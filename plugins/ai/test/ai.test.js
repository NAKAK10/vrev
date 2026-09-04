import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import provider, { createAiCapability, createAiIntegrationRegistry } from "../server/index.js";

function workspace() { return mkdtempSync(path.join(os.tmpdir(), "vrev-ai-")); }

function fixture(result = { exitCode: 0, reason: "exit", stdout: "done" }, workspaceRoot = "/workspace") {
  const resolutions = [];
  let runs = 0;
  const runnerRegistry = {
    list: () => [
      { runner_id: "claude", name: "Claude", provider_id: "runner-local", verified: true, profiles: ["text-only"] },
      { runner_id: "command-id", name: "Local model", provider_id: "custom-command", verified: true },
      { runner_id: "pending", name: "Pending", provider_id: "custom-command", verified: false },
    ],
    resolve(methodId, context) { resolutions.push({ methodId, context }); return { command: "agent", args: [context.prompt], cwd: context.workspaceRoot, env: {} }; },
  };
  const processSupervisor = { run(spec) { runs += 1; return { cancel() {}, result: Promise.resolve(result) }; } };
  return { capability: createAiCapability({ workspaceRoot, runnerRegistry, processSupervisor }), resolutions, runCount: () => runs };
}

test("AI lists reusable CLI and external-command methods without command details", async () => {
  const { capability } = fixture();
  assert.deepEqual(await capability.list(), [
    { method_id: "claude", name: "Claude", method_kind: "cli", modes: ["workspace-write", "text-only"] },
    { method_id: "command-id", name: "Local model", method_kind: "external-command", modes: ["workspace-write"] },
  ]);
  assert.deepEqual(await capability.list({ mode: "text-only" }), [
    { method_id: "claude", name: "Claude", method_kind: "cli", modes: ["workspace-write", "text-only"] },
  ]);
});

test("AI resolves and supervises an opaque method with bounded output", async () => {
  const { capability, resolutions, runCount } = fixture();
  const invocation = await capability.invoke({ method_id: "claude", mode: "text-only", prompt: "draft", timeout_ms: 1000, output_limit_bytes: 16, options: { operation: "test" } });
  assert.deepEqual(await invocation.result, { status: "completed", output: "done", exit_code: 0 });
  const packageSelected = await capability.invoke({ mode: "workspace-write", prompt: "fix" });
  assert.equal((await packageSelected.result).status, "completed");
  assert.equal(runCount(), 2);
  assert.equal(resolutions[1].methodId, "claude");
  assert.deepEqual(resolutions[0], { methodId: "claude", context: { workspaceRoot: "/workspace", prompt: "draft", options: { operation: "test", profile: "text-only" } } });
});

test("AI preserves bounded process diagnostics and classifies a nonzero exit as an exit failure", async () => {
  const secret = "must-not-leak";
  const detail = `${"x".repeat(9000)}\nAPI_KEY=${secret}\nmodel crashed`;
  const { capability } = fixture({ exitCode: 7, reason: "exit", stdout: "protocol output", errorMessage: detail });
  const result = await capability.invoke({ method_id: "claude", mode: "workspace-write", prompt: "fix" }).result;
  assert.equal(result.status, "failed");
  assert.equal(result.exit_code, 7);
  assert.equal(result.output, "protocol output");
  assert.match(result.message, /AI invocation failed: exit|model crashed/);
  assert.match(result.message, /model crashed/);
  assert.doesNotMatch(result.message, new RegExp(secret));
  assert.ok(Buffer.byteLength(result.message, "utf8") <= 8192);
});

test("AI supports namespaced API, SDK, and remote integration providers", async () => {
  const integrationRegistry = createAiIntegrationRegistry();
  let received;
  integrationRegistry.register("cloud", {
    list: () => [{ method_id: "draft", name: "Cloud Draft", method_kind: "api", modes: ["text-only"] }],
    invoke(methodId, request) {
      received = { methodId, request };
      return { cancel() {}, result: Promise.resolve({ status: "completed", output: "remote result", exit_code: 0 }) };
    },
  });
  const runnerRegistry = { list: () => [], resolve: () => { throw new Error("unused"); } };
  const processSupervisor = { run: () => { throw new Error("unused"); } };
  const capability = createAiCapability({ workspaceRoot: "/workspace", runnerRegistry, processSupervisor, integrationRegistry });
  assert.deepEqual(await capability.list(), [
    { method_id: "cloud:draft", name: "Cloud Draft", method_kind: "api", modes: ["text-only"] },
  ]);
  const invocation = await capability.invoke({ method_id: "cloud:draft", mode: "text-only", prompt: "draft", options: { operation: "issue" } });
  assert.deepEqual(await invocation.result, { status: "completed", output: "remote result", exit_code: 0 });
  assert.equal(received.methodId, "draft");
  assert.equal(received.request.workspaceRoot, "/workspace");
  assert.equal(received.request.signal instanceof AbortSignal, true);
});

test("AI preserves delegated failure messages and nonzero exit classification", async () => {
  const integrationRegistry = createAiIntegrationRegistry();
  integrationRegistry.register("cloud", {
    list: () => [{ method_id: "draft", name: "Cloud Draft", method_kind: "api", modes: ["text-only"] }],
    invoke: () => ({ cancel() {}, result: Promise.resolve({ status: "failed", output: "partial", exit_code: 23, message: "remote model rejected the request", retryable: false }) }),
  });
  const capability = createAiCapability({
    workspaceRoot: "/workspace",
    runnerRegistry: { list: () => [], resolve: () => { throw new Error("unused"); } },
    processSupervisor: { run: () => { throw new Error("unused"); } },
    integrationRegistry,
  });
  const result = await capability.invoke({ method_id: "cloud:draft", mode: "text-only", prompt: "draft" }).result;
  assert.equal(result.status, "failed");
  assert.equal(result.exit_code, 23);
  assert.equal(result.output, "partial");
  assert.match(result.message, /AI invocation failed: exit/);
  assert.match(result.message, /remote model rejected the request/);
});

test("AI turns integration invoke throws and result rejections into diagnostic failures", async () => {
  for (const [providerId, invoke, expected] of [
    ["throwing", () => { throw new Error("provider invoke exploded"); }, /provider invoke exploded/],
    ["rejecting", () => ({ cancel() {}, result: Promise.reject(new Error("provider result disconnected")) }), /provider result disconnected/],
  ]) {
    const integrationRegistry = createAiIntegrationRegistry();
    integrationRegistry.register(providerId, {
      list: () => [{ method_id: "method", name: providerId, method_kind: "api", modes: ["text-only"] }],
      invoke,
    });
    const capability = createAiCapability({
      workspaceRoot: "/workspace",
      runnerRegistry: { list: () => [], resolve: () => { throw new Error("unused"); } },
      processSupervisor: { run: () => { throw new Error("unused"); } },
      integrationRegistry,
    });
    const result = await capability.invoke({ method_id: `${providerId}:method`, mode: "text-only", prompt: "draft" }).result;
    assert.equal(result.status, "failed");
    assert.equal(result.exit_code, null);
    assert.match(result.message, expected);
  }
});

test("AI falls back to another capable method when the configured default cannot serve the requested mode", async () => {
  const root = workspace();
  mkdirSync(path.join(root, ".vrev"), { recursive: true });
  writeFileSync(path.join(root, ".vrev", "ai-settings.json"), JSON.stringify({ schema_version: 1, method_id: "command-id" }));
  const { capability, resolutions } = fixture(undefined, root);
  const invocation = await capability.invoke({ mode: "text-only", prompt: "draft" });
  assert.equal((await invocation.result).status, "completed");
  assert.equal(resolutions[0].methodId, "claude");
});

test("AI rejects unsupported modes and stops active or late invocations", async () => {
  const { capability, runCount } = fixture();
  const unavailable = capability.invoke({ method_id: "command-id", mode: "text-only", prompt: "draft" });
  assert.equal((await unavailable.result).status, "failed");
  capability.stop();
  assert.throws(() => capability.invoke({ method_id: "claude", mode: "text-only", prompt: "draft" }), /stopped/);
  assert.equal(runCount(), 0);
});

test("AI timeout and cancellation settle even when an integration ignores its signal", async () => {
  const integrationRegistry = createAiIntegrationRegistry();
  integrationRegistry.register("hanging", {
    list: () => [{ method_id: "remote", name: "Hanging Remote", method_kind: "remote", modes: ["text-only"] }],
    invoke: () => ({ cancel() {}, result: new Promise(() => undefined) }),
  });
  const capability = createAiCapability({
    workspaceRoot: "/workspace",
    runnerRegistry: { list: () => [], resolve: () => { throw new Error("unused"); } },
    processSupervisor: { run: () => { throw new Error("unused"); } },
    integrationRegistry,
  });
  const timed = capability.invoke({ method_id: "hanging:remote", mode: "text-only", prompt: "draft", timeout_ms: 5 });
  assert.equal((await timed.result).status, "timeout");
  const cancelled = capability.invoke({ method_id: "hanging:remote", mode: "text-only", prompt: "draft", timeout_ms: 1000 });
  cancelled.cancel();
  assert.equal((await cancelled.result).status, "cancelled");
  capability.stop();
});

test("server provider exposes ai/v1 and owns both process-backed provider registrations", async () => {
  const capabilities = [];
  const registered = [];
  const instance = provider.create({
    workspace: { root: "/workspace" },
    capability(id) {
      if (id === "host.runner-registry") return {
        register(providerId) { registered.push(providerId); return () => registered.splice(registered.indexOf(providerId), 1); },
        list: () => [],
        resolve: () => { throw new Error("unused"); },
      };
      if (id === "host.process-supervisor") return { run: () => { throw new Error("unused"); } };
      throw new Error(`unexpected capability: ${id}`);
    },
  });
  await instance.start();
  assert.deepEqual(registered, ["runner-local", "custom-command"]);
  capabilities.push(...instance.capabilities());
  assert.equal(capabilities[0].id, "ai");
  assert.equal(capabilities[0].apiVersion, 1);
  assert.equal(capabilities[1].id, "ai.integration-registry");
  assert.equal(capabilities[1].apiVersion, 1);
  await instance.stop();
  assert.deepEqual(registered, []);
});
