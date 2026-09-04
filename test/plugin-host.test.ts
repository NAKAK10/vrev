import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CapabilityRegistry,
  CapabilityUnavailableError,
  PLUGIN_BRIDGE_PROTOCOL_V1,
  createPluginHostRuntime,
  createProcessSupervisor,
  createRunnerRegistry,
  installPlugin,
  listPlugins,
  pluginSettingsRevision,
  readPluginSettings,
  updatePluginSettings,
  type ProcessSpecV1,
} from "../src/index.js";

function pluginWorkspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "visual-review-host-"));
  mkdirSync(path.join(root, ".git"));
  return root;
}

async function installServerFixture(root: string, id: string, requiredCapability = "fixture.port"): Promise<string> {
  const source = path.join(root, "sources", id);
  mkdirSync(path.join(source, "ui"), { recursive: true });
  writeFileSync(path.join(source, "README.md"), "# Fixture\n");
  writeFileSync(path.join(source, "ui/broken.json"), "not valid JSON");
  const empty = { type: "object", properties: {}, additionalProperties: false };
  const output = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
  writeFileSync(path.join(source, "contract.json"), JSON.stringify({
    schema_version: 1,
    queries: [
      { name: "fixture.get", permission: "fixture.read", input_schema: empty, output_schema: output, resources: ["fixture"] },
      { name: "fixture.bad", permission: "fixture.read", input_schema: empty, output_schema: output, resources: ["fixture"] },
    ],
    commands: [{ name: "fixture.set", permission: "fixture.write", input_schema: empty, output_schema: output, invalidates: ["fixture"] }],
  }));
  writeFileSync(path.join(source, "server.js"), `
    import { appendFileSync, writeFileSync } from "node:fs";
    import path from "node:path";
    writeFileSync(path.join(import.meta.dirname, "evaluated"), "yes");
    export default {
      apiVersion: 1,
      create(context) {
        const log = (value) => appendFileSync(path.join(context.plugin.root, "lifecycle.log"), value + "\\n");
        return {
          start() { context.capability("${requiredCapability}", 1); log("start"); },
          async query(name) { return { ok: true, data: name === "fixture.bad" ? { wrong: true } : { value: "query" } }; },
          async command() { return { ok: true, data: { value: "command" } }; },
          subscribe(_request, emit) {
            log("subscribe");
            emit({ protocol: "plugin-bridge/1", event_id: "fixture:1", seq: 1, plugin_id: context.plugin.id, type: "resources.invalidated", resources: ["fixture"] });
            return () => log("unsubscribe");
          },
          stop(reason) { log("stop:" + reason); }
        };
      }
    };
  `);
  writeFileSync(path.join(source, "visual-review.plugin.json"), JSON.stringify({
    schema_version: 4,
    id,
    version: "1.0.0",
    display: { title: id, summary: "Host runtime fixture", readme: "./README.md" },
    configuration: [],
    server: { api_version: 1, bridge_api_version: 1, module: "./server.js", contract: "./contract.json" },
    ui: { renderer_api_version: 1, bridge_api_version: 1, contributions: [{ id: "main", slot: "review.sidebar", document: "./ui/broken.json", order: 1 }] },
    requires: [{ capability: requiredCapability, api_version: 1, optional: false }],
  }));
  return (await installPlugin(source, root)).directory;
}

function nodeProcess(source: string, ...args: string[]): ProcessSpecV1 {
  return {
    command: process.execPath,
    args: ["-e", source, ...args],
    cwd: process.cwd(),
    env: { ...process.env },
  };
}

test("capability registry resolves only exact registered API versions", () => {
  const registry = new CapabilityRegistry();
  const capability = { query: () => "ready" };
  const unregister = registry.register("review", 1, capability);

  assert.equal(registry.has("review", 1), true);
  assert.equal(registry.resolve<typeof capability>("review", 1), capability);
  assert.throws(() => registry.resolve("review", 2), CapabilityUnavailableError);
  assert.throws(() => registry.register("review", 1, {}), /already registered/);

  unregister();
  unregister();
  assert.equal(registry.has("review", 1), false);
  assert.throws(() => registry.resolve("review", 1), CapabilityUnavailableError);
});

test("host runner registry is workspace-scoped and validates multi-provider results", async () => {
  const root = pluginWorkspace();
  const registry = createRunnerRegistry(root);
  const unregister = registry.register("fixture.ai", {
    list: () => [{ runner_id: "fixture", name: "Fixture", verified: true, profiles: ["text-only"] }],
    resolve: (_id, context) => ({ command: "agent", args: [context.prompt], cwd: root, env: {} }),
  });
  registry.register("other.ai", { list: () => [{ runner_id: "other", name: "Other", verified: false }], resolve: () => ({ command: "other", args: [] }) });
  assert.deepEqual(await registry.list(), [
    { runner_id: "fixture", name: "Fixture", provider_id: "fixture.ai", verified: true, profiles: ["text-only"] },
    { runner_id: "other", name: "Other", provider_id: "other.ai", verified: false },
  ]);
  assert.deepEqual(await registry.resolve("fixture", { workspaceRoot: root, prompt: "fix", options: { profile: "text-only" } }), { command: "agent", args: ["fix"], cwd: root, env: {} });
  await assert.rejects(registry.resolve("fixture", { workspaceRoot: root, prompt: "fix", options: { profile: "workspace-write" } }), /does not support/);
  await assert.rejects(registry.resolve("other", { workspaceRoot: root, prompt: "fix" }), /verified runner is unavailable/);
  await assert.rejects(registry.list({ workspaceRoot: `${root}-other` }), /workspace/);
  unregister();
  assert.equal((await registry.list()).some(({ runner_id }) => runner_id === "fixture"), false);
});

test("disabled and capability-blocked v4 servers are never imported", async () => {
  const root = pluginWorkspace();
  const disabledDirectory = await installServerFixture(root, "disabled-server");
  const settings = readPluginSettings(root);
  updatePluginSettings("disabled-server", listPlugins(root)[0]!.manifest, {
    revision: pluginSettingsRevision(settings), enabled: false, configuration: {},
  }, root);

  const runtime = createPluginHostRuntime({ workspaceRoot: root, workspaceId: "workspace", target: { id: "target", source: "fixture" } });
  await runtime.start();
  assert.equal(runtime.status("disabled-server").state, "unavailable");
  assert.equal(existsSync(path.join(disabledDirectory, "evaluated")), false);
  const unavailable = await runtime.query("disabled-server", "fixture.get", { protocol: PLUGIN_BRIDGE_PROTOCOL_V1, request_id: "disabled", input: {} });
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) assert.equal(unavailable.error.code, "PLUGIN_UNAVAILABLE");
  await runtime.stop();

  const secondRoot = pluginWorkspace();
  const blockedDirectory = await installServerFixture(secondRoot, "blocked-server");
  const blocked = createPluginHostRuntime({ workspaceRoot: secondRoot, workspaceId: "workspace", target: { id: "target", source: "fixture" } });
  await blocked.start();
  assert.match(blocked.status("blocked-server").message ?? "", /required capability/);
  assert.equal(existsSync(path.join(blockedDirectory, "evaluated")), false);
  await blocked.stop();
});

test("plugin host starts capability dependencies independently of package order", async () => {
  const root = pluginWorkspace();
  await installServerFixture(root, "a-dependent", "late.port");
  const source = path.join(root, "sources", "z-provider");
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, "README.md"), "# Provider\n");
  writeFileSync(path.join(source, "contract.json"), JSON.stringify({ schema_version: 1, queries: [], commands: [] }));
  writeFileSync(path.join(source, "server.js"), `export default { apiVersion: 1, create() { return { start() {}, query() {}, command() {}, capabilities() { return [{ id: "late.port", apiVersion: 1, implementation: { ready: true } }]; }, stop() {} }; } };`);
  writeFileSync(path.join(source, "visual-review.plugin.json"), JSON.stringify({
    schema_version: 4,
    id: "z-provider",
    version: "1.0.0",
    display: { title: "Provider", summary: "Late capability provider", readme: "./README.md" },
    configuration: [],
    server: { api_version: 1, bridge_api_version: 1, module: "./server.js", contract: "./contract.json" },
    provides: [{ capability: "late.port", api_version: 1 }],
  }));
  await installPlugin(source, root);
  const runtime = createPluginHostRuntime({ workspaceRoot: root, workspaceId: "workspace", target: { id: "target", source: "fixture" } });
  await runtime.start();
  assert.equal(runtime.status("z-provider").state, "ready");
  assert.equal(runtime.status("a-dependent").state, "ready");
  await runtime.stop();
});

test("plugin host dispatches only contracted operations and owns lifecycle subscriptions", async () => {
  const root = pluginWorkspace();
  const directory = await installServerFixture(root, "runtime-server");
  rmSync(path.join(directory, "ui/broken.json"));
  const capabilities = new CapabilityRegistry();
  capabilities.register("fixture.port", 1, { ready: true });
  let allowCommands = true;
  const runtime = createPluginHostRuntime({
    workspaceRoot: root,
    workspaceId: "workspace",
    target: { id: "target", source: "fixture" },
    capabilities,
    principal: "human-ui",
    authorizeOperation: ({ permission }) => permission !== "fixture.write" || allowCommands,
  });

  await Promise.all([runtime.start(), runtime.start()]);
  assert.equal(runtime.status("runtime-server").state, "ready");
  assert.equal(readFileSync(path.join(directory, "lifecycle.log"), "utf8"), "start\n");

  const query = await runtime.query("runtime-server", "fixture.get", { protocol: PLUGIN_BRIDGE_PROTOCOL_V1, request_id: "query", input: {} });
  assert.deepEqual(query, { ok: true, data: { value: "query" } });
  const command = await runtime.sendAction("runtime-server", "fixture.set", { protocol: PLUGIN_BRIDGE_PROTOCOL_V1, request_id: "command", idempotency_key: "once", input: {} });
  assert.deepEqual(command, { ok: true, data: { value: "command" } });
  allowCommands = false;
  const forbidden = await runtime.sendAction("runtime-server", "fixture.set", { protocol: PLUGIN_BRIDGE_PROTOCOL_V1, request_id: "forbidden", idempotency_key: "twice", input: {} });
  assert.equal(forbidden.ok, false);
  if (!forbidden.ok) assert.equal(forbidden.error.code, "FORBIDDEN");

  const undeclared = await runtime.query("runtime-server", "fixture.hidden", { protocol: PLUGIN_BRIDGE_PROTOCOL_V1, request_id: "hidden", input: {} });
  assert.equal(undeclared.ok, false);
  if (!undeclared.ok) assert.equal(undeclared.error.code, "PLUGIN_PROTOCOL_ERROR");
  const malformed = await runtime.query("runtime-server", "fixture.bad", { protocol: PLUGIN_BRIDGE_PROTOCOL_V1, request_id: "bad", input: {} });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.error.code, "PLUGIN_PROTOCOL_ERROR");

  const events: string[] = [];
  const unsubscribe = runtime.subscribe("runtime-server", (event) => events.push(event.event_id));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["fixture:1"]);
  unsubscribe();
  unsubscribe();
  await Promise.all([runtime.stop(), runtime.stop()]);
  assert.equal(readFileSync(path.join(directory, "lifecycle.log"), "utf8"), "start\nsubscribe\nunsubscribe\nstop:shutdown\n");
});

test("process supervisor invokes commands without a shell and captures stdout", async () => {
  const supervisor = createProcessSupervisor({ timeoutMs: 2_000 });
  const marker = "literal;echo shell-was-used";
  const completed = await supervisor.run(nodeProcess("process.stdout.write(process.argv[1])", marker)).result;

  assert.deepEqual(completed, { exitCode: 0, reason: "exit", stdout: marker });
});

test("process supervisor enforces stdout limits and timeout", async () => {
  const outputLimited = createProcessSupervisor({ stdoutLimit: 4, timeoutMs: 2_000, killGraceMs: 20 });
  const outputResult = await outputLimited.run(nodeProcess("process.stdout.write('abcdefgh')")).result;
  assert.equal(outputResult.reason, "output-limit");
  assert.equal(outputResult.stdout, "efgh");

  const timed = createProcessSupervisor({ timeoutMs: 20, killGraceMs: 20 });
  const timeoutResult = await timed.run(nodeProcess("setInterval(() => {}, 1000)")).result;
  assert.equal(timeoutResult.reason, "timeout");
});

test("process supervisor supports explicit cancellation", async () => {
  const supervisor = createProcessSupervisor({ timeoutMs: 2_000, killGraceMs: 20 });
  const running = supervisor.run(nodeProcess("setInterval(() => {}, 1000)"));
  running.cancel();
  const result = await running.result;
  assert.equal(result.reason, "cancelled");
});
