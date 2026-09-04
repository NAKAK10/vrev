import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import {
  acquireServerLease,
  assertLoopbackHost,
  createVrevServer,
  fileSha256,
  MAX_REQUEST_BODY,
  type VrevServer,
} from "../src/index.js";
import { ensureDefaultPlugins, listenOnAvailablePort, parseCliArguments } from "../src/cli.js";

let root: string;
let vrev: VrevServer;
let baseUrl: string;
const createdIssueDrafts: Array<{ title: string; body: string }> = [];
let releaseIssueCreation: (() => void) | null = null;
let issueCreationGate: Promise<void> | null = null;

async function openEventStream(url: string): Promise<{ next(): Promise<Record<string, unknown>>; close(): void }> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next() {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const data = frame.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
          if (data) return JSON.parse(data) as Record<string, unknown>;
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error("event stream closed");
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    close() { controller.abort(); },
  };
}

before(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "vrev-server-"));
  mkdirSync(path.join(root, ".code/htmls/pages"), { recursive: true });
  mkdirSync(path.join(root, ".code/vrevs"), { recursive: true });
  mkdirSync(path.join(root, "assets"));
  writeFileSync(
    path.join(root, ".code/htmls/pages/index.html"),
    "<!doctype html><script>globalThis.targetScriptRan=true</script><h1>Target</h1>",
  );
  writeFileSync(path.join(root, ".code/htmls/pages/other.html"), "<p>Other</p>");
  writeFileSync(path.join(root, ".code/htmls/pages/styles.css"), "body{};");
  writeFileSync(path.join(root, ".code/htmls/pages/.hidden.html"), "hidden");
  writeFileSync(path.join(root, ".code/htmls/pages/secret-token.js"), "secret");
  writeFileSync(path.join(root, ".code/vrevs/review.json"), "{}");
  writeFileSync(path.join(root, "assets/logo.png"), "png-data");
  await ensureDefaultPlugins(root);
  vrev = createVrevServer({
    projectRoot: root,
    target: ".code/htmls/pages/index.html",
    allowAiJobsWithScripts: true,
    jobManager: {
      executor: () => ({ result: Promise.resolve({ exitCode: 0, reason: "exit" }), cancel: () => undefined }),
    },
    issueCreator: async (draft) => {
      createdIssueDrafts.push(draft);
      if (issueCreationGate) await issueCreationGate;
      return { url: "https://github.com/example/project/issues/42" };
    },
    reloadTokenReplayTtlMs: 1_000,
    reloadTokenReplayMaxEntries: 2,
  });
  await new Promise<void>((resolve) => vrev.server.listen(0, "127.0.0.1", resolve));
  const address = vrev.server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await vrev.close();
});

test("serves built UI and compatible session/security headers", async () => {
  const sessionResponse = await fetch(`${baseUrl}/api/session`);
  const session = await sessionResponse.json() as {
    target: { entry_path: string; allow_scripts: boolean; ai_jobs_enabled: boolean };
    review: { schema_version: number; revision: number };
  };
  assert.equal(sessionResponse.status, 200);
  assert.equal(session.target.entry_path, ".code/htmls/pages/index.html");
  assert.equal(session.target.allow_scripts, true);
  assert.equal(session.target.ai_jobs_enabled, true);
  assert.equal(session.review.schema_version, 2);
  assert.equal(sessionResponse.headers.get("cache-control"), "no-store");
  assert.equal(sessionResponse.headers.get("x-content-type-options"), "nosniff");
  assert.equal(sessionResponse.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.match(sessionResponse.headers.get("content-security-policy") ?? "", /frame-ancestors 'self'/);

  for (const asset of ["/", "/renderer.css", "/reviewer.css", "/reviewer.js", "/jobs.js"]) {
    const response = await fetch(`${baseUrl}${asset}`);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).length > 10);
  }
  assert.ok(existsSync(new URL("../src/ui/index.html", import.meta.url)));
  const pluginRuntime = await fetch(`${baseUrl}/api/plugin-host/v1/plugins/review/ui-modules/review-stage`);
  assert.equal(pluginRuntime.status, 200);
  assert.match(pluginRuntime.headers.get("content-type") ?? "", /javascript/);
  assert.match(await pluginRuntime.text(), /export function mount/);

  const forwardedHost = new URL(baseUrl).host;
  const forwardedQuery = await fetch(`${baseUrl}/api/plugin-host/v1/plugins/review/queries/session.get`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `https://${forwardedHost}` },
    body: JSON.stringify({ protocol: "plugin-bridge/1", request_id: "forwarded-https", input: {} }),
  });
  assert.equal(forwardedQuery.status, 200);

  const flowResponse = await fetch(`${baseUrl}/api/plugins/annotation-flow`);
  assert.equal(flowResponse.status, 200);
  const flowPayload = await flowResponse.json() as {
    enabled: boolean;
    custom_command_enabled: boolean;
    policy: { events: string[]; debounceMs: number; settings: { maxParallel: { max: number }; autoRun: { label: string } } };
  };
  assert.equal(flowPayload.enabled, true);
  assert.equal(flowPayload.custom_command_enabled, true);
  assert.deepEqual(flowPayload.policy.events, ["annotation-created", "annotation-reopened"]);
  assert.equal(flowPayload.policy.debounceMs, 300);
  assert.equal("runner" in flowPayload.policy.settings, false);
  assert.equal(flowPayload.policy.settings.maxParallel.max, 10);
  assert.match(flowPayload.policy.settings.autoRun.label, /自動/);
});

test("broadcasts mutations to multiple event-stream clients", async () => {
  const first = await openEventStream(`${baseUrl}/api/plugin-host/v1/plugins/review/events`);
  const second = await openEventStream(`${baseUrl}/api/plugin-host/v1/plugins/review/events`);
  try {
    assert.equal((await first.next()).type, "resync.required");
    assert.equal((await second.next()).type, "resync.required");
    const created = await fetch(`${baseUrl}/api/annotations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "dom", page_path: ".code/htmls/pages/index.html", comment: "Concurrent sync", anchor: { selector: "h1" }, source_hash: vrev.store.sourceHash() }),
    });
    assert.equal(created.status, 200);
    const [left, right] = await Promise.all([first.next(), second.next()]);
    assert.equal(left.type, "resources.invalidated");
    assert.equal(right.type, "resources.invalidated");
    assert.deepEqual(left.resources, ["session", "annotations", "history"]);
    assert.equal(left.event_id, right.event_id);
  } finally { first.close(); second.close(); }
});

test("plugin management is visible by default and can be explicitly hidden", async () => {
  assert.equal((await fetch(`${baseUrl}/settings/plugins`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/settings/plugins`)).status, 200);

  const hiddenRoot = mkdtempSync(path.join(os.tmpdir(), "vrev-hidden-plugin-settings-"));
  mkdirSync(path.join(hiddenRoot, ".git"));
  mkdirSync(path.join(hiddenRoot, ".code/htmls"), { recursive: true });
  mkdirSync(path.join(hiddenRoot, ".vrev"), { recursive: true });
  writeFileSync(path.join(hiddenRoot, ".code/htmls/index.html"), "<h1>Hidden settings</h1>");
  writeFileSync(path.join(hiddenRoot, ".vrev/settings.json"), JSON.stringify({
    schema_version: 1,
    workspace: { root: ".", monorepo: false },
    ui: { plugin_management: false },
    projects: [],
  }));
  await ensureDefaultPlugins(hiddenRoot);
  const hiddenServer = createVrevServer({ projectRoot: hiddenRoot, target: ".code/htmls/index.html" });
  await new Promise<void>((resolve) => hiddenServer.server.listen(0, "127.0.0.1", resolve));
  try {
    const hiddenAddress = hiddenServer.server.address();
    assert.ok(hiddenAddress && typeof hiddenAddress !== "string");
    const hiddenUrl = `http://127.0.0.1:${hiddenAddress.port}`;
    assert.equal((await fetch(`${hiddenUrl}/settings/plugins`)).status, 404);
    assert.equal((await fetch(`${hiddenUrl}/api/settings/plugins`)).status, 404);
  } finally {
    await hiddenServer.close();
  }

  const settingsRoot = mkdtempSync(path.join(os.tmpdir(), "vrev-plugin-settings-"));
  mkdirSync(path.join(settingsRoot, ".git"));
  mkdirSync(path.join(settingsRoot, ".code/htmls"), { recursive: true });
  mkdirSync(path.join(settingsRoot, ".vrev"), { recursive: true });
  writeFileSync(path.join(settingsRoot, ".code/htmls/index.html"), "<h1>Settings</h1>");
  writeFileSync(path.join(settingsRoot, ".vrev/settings.json"), JSON.stringify({
    schema_version: 1,
    workspace: { root: ".", monorepo: false },
    ui: { plugin_management: true },
    projects: [],
  }));
  await ensureDefaultPlugins(settingsRoot);
  const server = createVrevServer({ projectRoot: settingsRoot, target: ".code/htmls/index.html" });
  await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${url}/settings/plugins`)).status, 200);
    const listed = await (await fetch(`${url}/api/settings/plugins`)).json() as { revision: string; plugins: Array<{ id: string; title: string; enabled: boolean; has_readme: boolean }> };
    const ai = listed.plugins.find(({ id }) => id === "ai");
    assert.equal(ai?.title, "AI");
    assert.equal(ai?.enabled, true);
    assert.equal(ai?.has_readme, true);
    const readme = await (await fetch(`${url}/api/settings/plugins/ai/readme`)).json() as { readme: string };
    assert.match(readme.readme, /@vrev\/ai/);
    const aiSettingsResponse = await fetch(`${url}/api/plugin-host/v1/plugins/ai/queries/ai.settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: url },
      body: JSON.stringify({ protocol: "plugin-bridge/1", request_id: "ai-settings-query", input: {} }),
    });
    assert.equal(aiSettingsResponse.status, 200);
    const aiSettings = await aiSettingsResponse.json() as { ok: boolean; data: { method_id: string; available: boolean; options: Array<{ value: string; label: string }> } };
    assert.equal(aiSettings.ok, true);
    assert.equal(aiSettings.data.available, true);
    assert.equal(aiSettings.data.options.some(({ value }) => value === "claude"), true);

    const probeScript = `require("node:fs").writeFileSync(".vrev-command-test","VREV_OK");process.stdout.write("VREV_OK")`;
    const addedResponse = await fetch(`${url}/api/jobs/custom-commands`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Server runner", command: `${process.execPath} -e '${probeScript}' {prompt}` }),
    });
    assert.equal(addedResponse.status, 201);
    const added = await addedResponse.json() as { runner_id: string; duration_ms: number };
    assert.equal(typeof added.duration_ms, "number");
    const verifiedEnqueue = await fetch(`${url}/api/jobs/batch`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ max_parallel: 1 }),
    });
    assert.equal(verifiedEnqueue.status, 200);
    const failedRegistration = await fetch(`${url}/api/jobs/custom-commands`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Broken runner", command: `${process.execPath} -e 'process.exit(2)' {prompt}` }),
    });
    assert.notEqual(failedRegistration.status, 201);
    const runnersPayload = await (await fetch(`${url}/api/jobs/custom-commands`)).json() as { runners: Array<Record<string, unknown>> };
    assert.equal(runnersPayload.runners[0]?.runner_id, added.runner_id);
    assert.equal(runnersPayload.runners[0]?.verified, true);
    assert.equal("command" in runnersPayload.runners[0]! || "template" in runnersPayload.runners[0]!, false);
    assert.equal((await fetch(`${url}/api/jobs/custom-commands/${encodeURIComponent(added.runner_id)}`, { method: "DELETE" })).status, 200);

    const updated = await fetch(`${url}/api/settings/plugins/ai`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: listed.revision, enabled: false, configuration: {} }),
    });
    assert.equal(updated.status, 200);
    const payload = await updated.json() as { revision: string; plugins: Array<{ id: string; enabled: boolean }> };
    assert.equal(payload.plugins.find(({ id }) => id === "ai")?.enabled, false);
    const aiDisabledFlow = await (await fetch(`${url}/api/plugins/annotation-flow`)).json() as { enabled: boolean; custom_command_enabled: boolean };
    assert.equal(aiDisabledFlow.enabled, true);
    assert.equal(aiDisabledFlow.custom_command_enabled, false);
    assert.equal((await fetch(`${url}/api/jobs/custom-commands`)).status, 409);
    assert.equal((await fetch(`${url}/api/jobs/batch`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ max_parallel: 1 }),
    })).status, 409);

    const annotationUpdated = await fetch(`${url}/api/settings/plugins/annotation-workflow`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: payload.revision, enabled: false, configuration: {} }),
    });
    assert.equal(annotationUpdated.status, 200);
    const disabledFlowResponse = await fetch(`${url}/api/plugins/annotation-flow`);
    assert.equal(disabledFlowResponse.status, 200);
    const disabledFlow = await disabledFlowResponse.json() as { enabled: boolean; reason: string; policy: unknown };
    assert.deepEqual(disabledFlow, { enabled: false, reason: "disabled", policy: null, custom_command_enabled: false });
    assert.equal((await fetch(`${url}/api/jobs/batch`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ max_parallel: 1 }),
    })).status, 409);
  } finally {
    await server.close();
  }
});

test("/settings serves the renderer shell and /api/settings/layout round trips with revision conflicts", async () => {
  const settingsResponse = await fetch(`${baseUrl}/settings`);
  assert.equal(settingsResponse.status, 200);
  assert.match(await settingsResponse.text(), /id="renderer-root"/);

  const layoutResponse = await fetch(`${baseUrl}/api/settings/layout`);
  assert.equal(layoutResponse.status, 200);
  const layoutPayload = await layoutResponse.json() as {
    revision: string;
    settings: { header: { order: string[] }; sidebar: { order: string[] }; stage: { active: string | null; switcher_position: string } };
    features: { plugin_management: boolean };
  };
  assert.equal(typeof layoutPayload.revision, "string");
  assert.equal(layoutPayload.features.plugin_management, true);

  const updated = await fetch(`${baseUrl}/api/settings/layout`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision: layoutPayload.revision, header: { order: ["review/review-header"] } }),
  });
  assert.equal(updated.status, 200);
  const updatedPayload = await updated.json() as { revision: string; settings: { header: { order: string[] } } };
  assert.deepEqual(updatedPayload.settings.header.order, ["review/review-header"]);
  assert.notEqual(updatedPayload.revision, layoutPayload.revision);

  const conflict = await fetch(`${baseUrl}/api/settings/layout`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision: layoutPayload.revision, sidebar: { order: [] } }),
  });
  assert.equal(conflict.status, 409);
  assert.match((await conflict.json() as { error: string }).error, /revision conflict/);

  const invalid = await fetch(`${baseUrl}/api/settings/layout`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision: updatedPayload.revision, stage: { switcher_position: "middle" } }),
  });
  assert.equal(invalid.status, 400);

  const surfaceResponse = await fetch(`${baseUrl}/api/plugin-host/v1/surfaces/review`);
  assert.equal(surfaceResponse.status, 200);
  const surface = await surfaceResponse.json() as { layout: { active_stage: string | null }; page: { title: string } };
  assert.equal(surface.layout.active_stage, "review/review-stage");
  assert.equal(surface.page.title, ".code/htmls/pages/index.html");
});

test("one-time reload redirects preserve logical URLs and reject unsafe targets", async () => {
  const token = "12345678-1234-4234-8234-123456789abc";
  const logical = "/target/.code/htmls/pages/index.html?encoded=%2f+%41&empty=#h%2f";
  const endpoint = `${baseUrl}/_vrev/reload/${token}?url=${encodeURIComponent(logical)}`;
  const redirect = await fetch(endpoint, { redirect: "manual" });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), logical);
  assert.equal(redirect.headers.get("cache-control"), "no-store");
  assert.equal((await fetch(endpoint, { redirect: "manual" })).status, 410, "a reload URL is consumed once");

  const secondEndpoint = `${baseUrl}/_vrev/reload/00000000-0000-4000-8000-000000000101?url=%2Flive%2F`;
  const thirdEndpoint = `${baseUrl}/_vrev/reload/00000000-0000-4000-8000-000000000102?url=%2Ftarget%2Fx`;
  assert.equal((await fetch(secondEndpoint, { redirect: "manual" })).status, 302);
  assert.equal((await fetch(thirdEndpoint, { redirect: "manual" })).status, 302);
  assert.equal((await fetch(endpoint, { redirect: "manual" })).status, 302, "the oldest replay entry is evicted at the size limit");
  assert.equal((await fetch(endpoint, { redirect: "manual" })).status, 410, "an accepted token remains one-time after eviction and reuse");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal((await fetch(endpoint, { redirect: "manual" })).status, 302, "expired replay entries are removed");

  const unsafe = [
    "https://example.com/live/", "//example.com/live/", `http://${["user", "word"].join(":")}@localhost/live/`,
    "/api/session", "/live/%2e%2e/api/session", "/target\\@example.com/secret", "/foo",
  ];
  for (let index = 0; index < unsafe.length; index += 1) {
    const unsafeToken = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const response = await fetch(`${baseUrl}/_vrev/reload/${unsafeToken}?url=${encodeURIComponent(unsafe[index]!)}`, { redirect: "manual" });
    assert.equal(response.status, 400, unsafe[index]);
    assert.equal(response.headers.get("location"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const duplicate = await fetch(`${baseUrl}/_vrev/reload/00000000-0000-4000-8000-000000000099?url=%2Flive%2F&url=%2Ftarget%2Fx`, { redirect: "manual" });
  assert.equal(duplicate.status, 400);
  assert.equal((await fetch(`${baseUrl}/_vrev/reload/not-a-token?url=%2Flive%2F`, { redirect: "manual" })).status, 404);
  assert.equal((await fetch(`${baseUrl}/_vrev/reload/00000000-0000-4000-8000-000000000098?url=%2Flive%2F`, { method: "POST", redirect: "manual" })).status, 405);
});

test("local scripts default on and can be disabled persistently from settings", async () => {
  const response = await fetch(`${baseUrl}/target/.code/htmls/pages/index.html`);
  assert.match(await response.text(), /targetScriptRan=true/);

  const initial = await (await fetch(`${baseUrl}/api/settings/target`)).json() as {
    revision: string; settings: { allow_scripts: boolean }; restricted: boolean;
  };
  assert.equal(initial.settings.allow_scripts, true);
  assert.equal(initial.restricted, false);
  const disabledResponse = await fetch(`${baseUrl}/api/settings/target`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision: initial.revision, allow_scripts: false }),
  });
  assert.equal(disabledResponse.status, 200);
  const disabled = await disabledResponse.json() as { revision: string; settings: { allow_scripts: boolean } };
  assert.equal(disabled.settings.allow_scripts, false);
  assert.equal((await (await fetch(`${baseUrl}/api/session`)).json() as { target: { allow_scripts: boolean } }).target.allow_scripts, false);
  const bridgeSession = await (await fetch(`${baseUrl}/api/plugin-host/v1/plugins/review/queries/session.get`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ protocol: "plugin-bridge/1", request_id: "scripts-disabled", input: {} }),
  })).json() as { data: { target: { allow_scripts: boolean } } };
  assert.equal(bridgeSession.data.target.allow_scripts, false);
  const persisted = JSON.parse(readFileSync(path.join(root, ".vrev/settings.json"), "utf8")) as { ui: { allow_scripts: boolean } };
  assert.equal(persisted.ui.allow_scripts, false);
  assert.equal((await fetch(`${baseUrl}/api/settings/target`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision: initial.revision, allow_scripts: true }),
  })).status, 409);
  assert.equal((await fetch(`${baseUrl}/api/settings/target`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision: disabled.revision, allow_scripts: true }),
  })).status, 200);
});

test("owner lease rejects a live owner, recovers stale PID, and only owner token releases", () => {
  const leaseRoot = mkdtempSync(path.join(os.tmpdir(), "vrev-lease-"));
  const reviewPath = path.join(leaseRoot, "review.json");
  const lease = acquireServerLease(reviewPath, "test");
  assert.throws(() => acquireServerLease(reviewPath, "second"), /already owns/);
  const leasePath = path.join(leaseRoot, ".server-lease.json");
  const actual = JSON.parse(readFileSync(leasePath, "utf8")) as { token: string };
  writeFileSync(leasePath, JSON.stringify({ ...actual, token: "not-owner", pid: process.pid }));
  lease.release();
  assert.ok(existsSync(leasePath));
  writeFileSync(leasePath, JSON.stringify({ token: "stale", pid: 999_999_999, started_at: new Date().toISOString(), tool: "test" }));
  const recovered = acquireServerLease(reviewPath, "replacement");
  recovered.release();
  assert.equal(existsSync(leasePath), false);
});

test("proxies loopback applications and persists URL annotations", async () => {
  let alternateOrigin = "";
  let lastRequestUrl = "";
  const upstream = http.createServer((request, response) => {
    lastRequestUrl = request.url ?? "";
    if (request.url === "/app.js") {
      response.writeHead(200, { "Content-Type": "application/javascript" });
      response.end(`import "/src/main.js";\nconst escaped = value.replace(/\`/g, "\\\`").replace(/""/g, '"');\nconst quoted = /quote'/ && true;\nconst route = "/";\nconst path = window.location.pathname;\nwindow.location.replace(route);\nfetch('/api/data');`);
      return;
    }
    if (request.url === "/eval.js") {
      response.writeHead(200, { "Content-Type": "application/javascript" });
      response.end(`eval("const page = window.location.pathname;");`);
      return;
    }
    if (request.url === "/broken") {
      response.writeHead(500, { "Content-Type": "text/html" });
      response.end("<html><head></head><body>upstream failed</body></html>");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "upstream=blocked", "Cache-Control": "public, max-age=3600" });
    response.end(`<html><head></head><body><a href="/next">Next</a><a href="${alternateOrigin}/alias">Alias</a><script src="/app.js"></script><main id="app">Live app</main></body></html>`);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== "string");
  const liveUrl = `http://127.0.0.1:${upstreamAddress.port}/`;
  alternateOrigin = `http://localhost:${upstreamAddress.port}`;
  const live = createVrevServer({ projectRoot: root, target: liveUrl, allowAiJobsWithScripts: true });
  await new Promise<void>((resolve) => live.server.listen(0, "127.0.0.1", resolve));
  try {
    const address = live.server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    const session = await (await fetch(`${url}/api/session`)).json() as {
      target: { entry_path: string; live_url: string; url: string; sha256: string; allow_scripts: boolean; ai_jobs_enabled: boolean };
    };
    assert.equal(session.target.entry_path, liveUrl);
    assert.equal(session.target.live_url, liveUrl);
    assert.equal(session.target.url, "/live/");
    assert.equal(session.target.allow_scripts, true);
    assert.equal(session.target.ai_jobs_enabled, true);
    const liveResponse = await fetch(`${url}/live/`);
    assert.equal(liveResponse.headers.get("set-cookie"), null);
    assert.equal(liveResponse.headers.get("clear-site-data"), '"cache"');
    assert.equal(liveResponse.headers.get("cache-control"), "no-store", "upstream caching cannot make live HTML stale");
    const html = await liveResponse.text();
    assert.match(html, /<base href="\/live\/">/);
    assert.match(html, /href="\/live\/next"/);
    assert.match(html, /src="\/live\/app\.js"/);
    assert.match(html, /href="\/live\/alias"/);
    const token = "12345678-1234-4234-8234-123456789abc";
    const logical = "/live/?encoded=%2f+%41&empty=#h%2f";
    const reloaded = await fetch(`${url}/_vrev/reload/${token}?url=${encodeURIComponent(logical)}`);
    assert.equal(reloaded.status, 200);
    assert.equal(reloaded.headers.get("cache-control"), "no-store");
    assert.equal(lastRequestUrl, "/?encoded=%2f+%41&empty=", "the target receives the unchanged logical query and no reload marker");
    assert.doesNotMatch(lastRequestUrl, /vrev.*reload/i);
    const fallbackToken = "00000000-0000-4000-8000-000000000201";
    const fallbackLogical = "/foo?route=%2f+%41#section";
    const fallbackReload = await fetch(`${url}/_vrev/reload/${fallbackToken}?url=${encodeURIComponent(fallbackLogical)}`);
    assert.equal(fallbackReload.status, 200);
    assert.equal(lastRequestUrl, "/foo?route=%2f+%41", "private live SPA fallback paths use the reload endpoint unchanged");
    for (const [index, reserved] of ["/", "/api/session", "/settings", "/assets/app.js", "/_vrev/other"].entries()) {
      const reservedToken = `00000000-0000-4000-8000-${String(300 + index).padStart(12, "0")}`;
      assert.equal((await fetch(`${url}/_vrev/reload/${reservedToken}?url=${encodeURIComponent(reserved)}`, { redirect: "manual" })).status, 400, reserved);
    }
    assert.equal(
      await (await fetch(`${url}/live/app.js`)).text(),
      `import "/live/src/main.js";\nconst escaped = value.replace(/\`/g, "\\\`").replace(/""/g, '"');\nconst quoted = /quote'/ && true;\nconst route = "/";\nconst path = window.location.pathname;\nwindow.location.replace(window.__vrevUrl(route));\nfetch('/live/api/data');`,
    );
    const evalScript = await (await fetch(`${url}/live/eval.js`)).text();
    assert.equal(evalScript, `eval("const page = window.location.pathname;");`);
    assert.doesNotThrow(() => new Function(evalScript));
    const brokenResponse = await fetch(`${url}/live/broken`);
    assert.equal(brokenResponse.status, 500);
    assert.match(await brokenResponse.text(), /upstream failed/);
    assert.equal((await fetch(`${url}/live//example.invalid/path`)).status, 200);
    assert.equal(lastRequestUrl, "//example.invalid/path");
    assert.equal((await fetch(`${url}/root-asset.png`)).status, 200);
    assert.equal(lastRequestUrl, "/root-asset.png");
    const state = await (await fetch(`${url}/api/file-state?path=${encodeURIComponent(liveUrl)}`)).json() as { sha256: string };
    assert.equal(state.sha256, session.target.sha256);
    const machinePath = ["/", "Users", "/demo/project/src/App.vue"].join("");
    const created = await fetch(`${url}/api/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "dom", page_path: liveUrl, comment: "Live fix", anchor: { selector: "#app", source_hint: { framework: "vue", component: "App", file: machinePath } }, source_hash: state.sha256 }),
    });
    assert.equal(created.status, 200);
    const review = await created.json() as { annotations: Array<{ page_path: string; anchor: { source_hint: Record<string, string> } }> };
    assert.equal(review.annotations[0]!.page_path, liveUrl);
    assert.deepEqual(review.annotations[0]!.anchor.source_hint, { framework: "vue", component: "App", file: "src/App.vue" });
  } finally {
    await live.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("public targets stay script-free and reject private network resolution", async () => {
  const live = createVrevServer({ projectRoot: root, target: "https://10.0.0.1/" });
  await new Promise<void>((resolve) => live.server.listen(0, "127.0.0.1", resolve));
  const address = live.server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const session = await (await fetch(`${url}/api/session`)).json() as { target: { allow_scripts: boolean; url_mode: string } };
    assert.equal(session.target.allow_scripts, false);
    assert.equal(session.target.url_mode, "public");
    const targetSettings = await (await fetch(`${url}/api/settings/target`)).json() as { settings: { allow_scripts: boolean }; restricted: boolean };
    assert.equal(targetSettings.settings.allow_scripts, false);
    assert.equal(targetSettings.restricted, true);
    assert.equal((await fetch(`${url}/api/settings/target`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: "ignored", allow_scripts: true }),
    })).status, 403);
    const fallbackReload = await fetch(`${url}/_vrev/reload/00000000-0000-4000-8000-000000000401?url=%2Ffoo`, { redirect: "manual" });
    assert.equal(fallbackReload.status, 400, "public live targets cannot reload arbitrary fallback paths");
    const blocked = await fetch(`${url}/live/`);
    assert.equal(blocked.status, 403);
    assert.match(await blocked.text(), /non-public address/);
  } finally {
    await live.close();
  }
});

test("trusted script mode disables every jobs API when AI execution is explicitly opted out", async () => {
  const trusted = createVrevServer({ projectRoot: root, target: ".code/htmls/pages/other.html", allowAiJobsWithScripts: false });
  await new Promise<void>((resolve) => trusted.server.listen(0, "127.0.0.1", resolve));
  try {
    const address = trusted.server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    for (const [method, route] of [["GET", "/api/jobs"], ["POST", "/api/jobs/batch"], ["GET", "/api/jobs/custom-commands"], ["POST", "/api/issues/request"], ["POST", "/api/issues"], ["POST", "/api/jobs/anything/cancel"], ["POST", "/api/plugin-host/v1/plugins/annotation-workflow/commands/jobs.enqueue"], ["POST", "/api/plugin-host/v1/plugins/github-issue/commands/issue.draft"], ["POST", "/api/plugin-host/v1/plugins/ai/commands/runner.add"]] as const) {
      const response = await fetch(`${url}${route}`, { method });
      assert.equal(response.status, 403, `${method} ${route}`);
    }
  } finally {
    await trusted.close();
  }
});

test("trusted script mode supports explicitly enabled AI execution", async () => {
  const trusted = createVrevServer({
    projectRoot: root,
    target: ".code/htmls/pages/other.html",
    allowAiJobsWithScripts: true,
  });
  await new Promise<void>((resolve) => trusted.server.listen(0, "127.0.0.1", resolve));
  try {
    const address = trusted.server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    const session = await (await fetch(`${url}/api/session`)).json() as {
      target: { allow_scripts: boolean; ai_jobs_enabled: boolean };
    };
    assert.equal(session.target.allow_scripts, true);
    assert.equal(session.target.ai_jobs_enabled, true);
    assert.equal((await fetch(`${url}/api/jobs`)).status, 200);
    assert.equal((await fetch(`${url}/api/jobs/custom-commands`)).status, 200);
    const rawLegacyProbe = await fetch(`${url}/api/jobs/custom-command/test`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: "runner {prompt}" }),
    });
    assert.equal(rawLegacyProbe.status, 404);
  } finally {
    await trusted.close();
  }
});

test("returns an installation instruction when the GitHub Issue plugin is absent", async () => {
  const missingRoot = mkdtempSync(path.join(os.tmpdir(), "vrev-missing-issue-plugin-"));
  mkdirSync(path.join(missingRoot, ".git"));
  mkdirSync(path.join(missingRoot, ".code/htmls"), { recursive: true });
  writeFileSync(path.join(missingRoot, ".code/htmls/index.html"), "<h1>Target</h1>");
  const withoutPlugin = createVrevServer({
    projectRoot: missingRoot,
    target: ".code/htmls/index.html",
    jobManager: { executor: () => ({ result: Promise.resolve({ exitCode: 0, reason: "exit" }), cancel: () => undefined }) },
  });
  await withoutPlugin.store.createIssueRequest({
    comment: "Create an issue",
    page_path: ".code/htmls/index.html",
    kind: "dom",
    anchor: { selector: "h1" },
    source_hash: withoutPlugin.store.sourceHash(".code/htmls/index.html"),
  });
  const annotation = (await withoutPlugin.store.load()).annotations.at(-1)!;
  await withoutPlugin.store.setStatus(annotation.id, { actor: "ai", status: "in_progress" });
  await withoutPlugin.store.setIssueDraftReady(annotation.id, "Issue title", "Issue body");
  await new Promise<void>((resolve) => withoutPlugin.server.listen(0, "127.0.0.1", resolve));
  try {
    const address = withoutPlugin.server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ annotation_id: annotation.id, title: "Issue title", body: "Issue body" }),
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /github-issue.*not installed.*npm install/i);
  } finally {
    await withoutPlugin.close();
  }
});

test("stores an Issue request, then creates and archives the AI-authored draft", async () => {
  const before = (await vrev.store.load()).annotations.length;
  const annotation = {
    comment: "大きめに整理してほしい",
    page_path: ".code/htmls/pages/index.html",
    kind: "dom",
    viewport_mode: "desktop",
    selector: "h1",
  };
  const reference = {
    ...annotation,
    anchor: { selector: "h1", tag: "h1" },
    source_hash: vrev.store.sourceHash(annotation.page_path),
  };
  const requestResponse = await fetch(`${baseUrl}/api/issues/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reference),
  });
  assert.equal(requestResponse.status, 200);
  const requested = (await requestResponse.json() as { annotations: Array<{ id: string; status: string; issue_state: string }> }).annotations.at(-1)!;
  assert.equal(requested.status, "open");
  assert.equal(requested.issue_state, "requested");
  assert.equal((await vrev.store.load()).annotations.length, before + 1);
  await vrev.store.setStatus(requested.id, { actor: "ai", status: "in_progress" });
  await vrev.store.setIssueDraftReady(requested.id, "整理されたIssue", "## 期待結果\n正しく表示する");
  const ready = (await vrev.store.load()).annotations.find(({ id }) => id === requested.id)!;
  assert.equal(ready.status, "addressed");
  assert.equal(ready.issue_state, "ready");

  const issueCountBefore = createdIssueDrafts.length;
  const preservedUpdatedAt = ready.updated_at;
  const preservedThreadLength = ready.thread.length;
  issueCreationGate = new Promise<void>((resolve) => { releaseIssueCreation = resolve; });
  const issuePayload = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "編集後のIssue",
      body: "## 期待結果\n編集済み",
      annotation_id: requested.id,
    }),
  };
  const firstRequest = fetch(`${baseUrl}/api/issues`, issuePayload);
  const duplicateRequest = fetch(`${baseUrl}/api/issues`, issuePayload);
  while (createdIssueDrafts.length === issueCountBefore) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(createdIssueDrafts.length, issueCountBefore + 1);
  releaseIssueCreation?.();
  issueCreationGate = null;
  releaseIssueCreation = null;
  const [createResponse, duplicateResponse] = await Promise.all([firstRequest, duplicateRequest]);
  assert.equal(createResponse.status, 200);
  assert.equal(duplicateResponse.status, 200);
  const createdResult = await createResponse.json() as { url: string; review: { annotations: unknown[] } };
  const duplicateResult = await duplicateResponse.json() as { url: string; review: { annotations: unknown[] } };
  assert.equal(createdResult.url, "https://github.com/example/project/issues/42");
  assert.equal(duplicateResult.url, createdResult.url);
  assert.ok(Array.isArray(createdResult.review.annotations));
  assert.deepEqual(createdIssueDrafts.at(-1), { title: "編集後のIssue", body: "## 期待結果\n編集済み" });

  const laterDuplicateResponse = await fetch(`${baseUrl}/api/issues`, issuePayload);
  assert.equal(laterDuplicateResponse.status, 200);
  assert.equal(createdIssueDrafts.length, issueCountBefore + 1);
  const archived = (await vrev.store.load()).annotations.find(({ id }) => id === requested.id)!;
  assert.equal(archived.status, "resolved");
  assert.equal(archived.issue_url, "https://github.com/example/project/issues/42");
  assert.equal(archived.issue_title, "編集後のIssue");
  assert.equal(archived.issue_state, "created");
  assert.equal(archived.updated_at, preservedUpdatedAt);
  assert.equal(archived.thread.length, preservedThreadLength);
});

test("the issue.create bridge command rejects direct creation without an AI-generated draft", async () => {
  const before = (await vrev.store.load()).annotations.length;
  const response = await fetch(`${baseUrl}/api/plugin-host/v1/plugins/github-issue/commands/issue.create`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({
      protocol: "plugin-bridge/1",
      request_id: "issue-create-bridge",
      idempotency_key: "issue-create-bridge",
      input: { title: "手入力Issue", body: "手入力した本文" },
    }),
  });
  assert.equal(response.status, 422);
  const result = await response.json() as { ok: boolean; error: { code: string; request_id: string } };
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "VALIDATION_FAILED");
  assert.equal(result.error.request_id, "issue-create-bridge");
  assert.equal((await vrev.store.load()).annotations.length, before);
});

test("the issue.create bridge command rejects invalid manual input", async () => {
  const before = (await vrev.store.load()).annotations.length;
  const response = await fetch(`${baseUrl}/api/plugin-host/v1/plugins/github-issue/commands/issue.create`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({
      protocol: "plugin-bridge/1",
      request_id: "issue-create-invalid",
      idempotency_key: "issue-create-invalid",
      input: { anchor: { selector: "h1", kind: "dom" }, title: "", body: "Body" },
    }),
  });
  assert.equal(response.status, 422);
  const payload = await response.json() as { ok: boolean; error: { code: string; request_id: string } };
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "VALIDATION_FAILED");
  assert.equal(payload.error.request_id, "issue-create-invalid");
  assert.equal((await vrev.store.load()).annotations.length, before);
});

test("supports file-state and annotation/message/status APIs through ReviewStore", async () => {
  const stateResponse = await fetch(`${baseUrl}/api/file-state?path=.code%2Fhtmls%2Fpages%2Fother.html`);
  const state = await stateResponse.json() as { path: string; sha256: string };
  assert.equal(stateResponse.status, 200);
  assert.equal(state.path, ".code/htmls/pages/other.html");

  const createResponse = await fetch(`${baseUrl}/api/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "dom",
      page_path: state.path,
      comment: "Fix this",
      anchor: { selector: "p" },
      source_hash: state.sha256,
    }),
  });
  const created = await createResponse.json() as { annotations: Array<{ id: string }>; revision: number };
  assert.equal(createResponse.status, 200);
  const id = created.annotations.at(-1)!.id;

  const statusResponse = await fetch(`${baseUrl}/api/annotations/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "addressed", actor: "ai" }),
  });
  assert.equal(statusResponse.status, 200);
  const messageResponse = await fetch(`${baseUrl}/api/annotations/${id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: "Please recheck", actor: "human" }),
  });
  const messaged = await messageResponse.json() as { revision: number };
  assert.equal(messageResponse.status, 200);
  assert.equal(messaged.revision, created.revision + 3);

  const resolvedResponse = await fetch(`${baseUrl}/api/annotations/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "resolved", actor: "human" }),
  });
  const resolved = await resolvedResponse.json() as { annotations: Array<{ id: string }> };
  assert.equal(resolved.annotations.some((annotation) => annotation.id === id), false);
  const session = await (await fetch(`${baseUrl}/api/session`)).json() as { review: { annotations: Array<{ id: string }> } };
  assert.equal(session.review.annotations.some((annotation) => annotation.id === id), false);
  assert.equal((JSON.parse(readFileSync(vrev.store.resolvedPath, "utf8")) as { annotations: Array<{ id: string }> }).annotations.some((annotation) => annotation.id === id), true);

  const archiveResponse = await fetch(`${baseUrl}/api/archive?offset=0&limit=1`);
  const archive = await archiveResponse.json() as {
    annotations: Array<{ id: string; status: string }>;
    annotation_total: number;
    events: Array<{ revision: number }>;
    history_total: number;
  };
  assert.equal(archiveResponse.status, 200);
  assert.equal(archive.annotations.some((annotation) => annotation.id === id && annotation.status === "resolved"), true);
  assert.ok(archive.annotation_total >= 1);
  assert.equal(archive.events.length, 1);
  assert.ok(archive.history_total >= archive.events.length);
  assert.equal((await fetch(`${baseUrl}/api/archive?offset=0&limit=25`)).status, 400);

  const reopenedResponse = await fetch(`${baseUrl}/api/annotations/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "open", actor: "human" }),
  });
  const reopened = await reopenedResponse.json() as { annotations: Array<{ id: string; status: string }> };
  assert.equal(reopened.annotations.find((annotation) => annotation.id === id)?.status, "open");
});

test("rejects traversal, hidden, secret and review-data paths", async () => {
  for (const pathname of [
    "/target/.git/config",
    "/target/.code/vrevs/review.json",
    "/target/.code/htmls/pages/.hidden.html",
    "/target/.code/htmls/pages/secret-token.js",
    "/target/%2e%2e/outside.html",
  ]) {
    const response = await fetch(`${baseUrl}${pathname}`);
    assert.equal(response.status, 404, pathname);
    assert.deepEqual(await response.json(), { error: response.status === 404 && pathname.includes("%2e%2e") ? "route not found" : "file not found" });
  }
  assert.equal((await fetch(`${baseUrl}/assets/logo.png`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/target/.code/htmls/pages/styles.css`)).status, 200);
});

test("returns JSON errors for malformed and over-limit bodies", async () => {
  const malformed = await fetch(`${baseUrl}/api/annotations`, { method: "POST", body: "{" });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "malformed JSON" });

  const oversized = Buffer.alloc(MAX_REQUEST_BODY + 1, 0x20);
  const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const url = new URL(`${baseUrl}/api/annotations`);
    const request = http.request({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: { "Content-Length": oversized.byteLength },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    request.on("error", reject);
    request.end(oversized);
  });
  assert.equal(result.status, 413);
  assert.deepEqual(JSON.parse(result.body), { error: "request body too large" });
});

test("CLI entrypoint runs when invoked through a package-bin symlink", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "vrev-bin-"));
  const link = path.join(directory, "vrev");
  symlinkSync(new URL("../src/cli.js", import.meta.url), link);
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [link], { stdio: ["ignore", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr: Buffer.concat(stderr).toString() }));
  });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
});

test("server increments from an occupied port", async () => {
  const blocker = http.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const address = blocker.address();
  assert.ok(address && typeof address !== "string" && address.port < 65535);
  const candidate = http.createServer();
  try {
    const selected = await listenOnAvailablePort(candidate, "127.0.0.1", address.port);
    assert.equal(selected, address.port + 1);
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => blocker.close(() => resolve())),
      new Promise<void>((resolve) => candidate.close(() => resolve())),
    ]);
  }
});

test("CLI normalizes project root and accepts loopback or private-network targets", () => {
  const cliRoot = mkdtempSync(path.join(os.tmpdir(), "vrev-cli-"));
  mkdirSync(path.join(cliRoot, "project"));
  const parsed = parseCliArguments([
    "serve", "--project-root", "project", "--target", ".code/htmls/page.html", "--host", "::1", "--port", "65535", "--allow-ai-jobs-with-scripts", "--no-open",
  ], cliRoot);
  assert.equal(parsed.projectRoot, realpathSync(path.join(cliRoot, "project")));
  assert.equal(parsed.projectDirectory, realpathSync(path.join(cliRoot, "project")));
  assert.equal(parsed.target, ".code/htmls/page.html");
  assert.equal(parsed.host, "::1");
  assert.equal(parsed.port, 65535);
  assert.equal(parsed.allowAiJobsWithScripts, true);
  assert.equal(parsed.open, false);
  const defaults = parseCliArguments(["serve", "--target", "assets/x.png"], cliRoot);
  assert.equal(defaults.projectRoot, realpathSync(cliRoot));
  const monorepo = mkdtempSync(path.join(os.tmpdir(), "vrev-cli-monorepo-"));
  mkdirSync(path.join(monorepo, ".git"));
  const appDirectory = path.join(monorepo, "apps/web");
  mkdirSync(appDirectory, { recursive: true });
  const nested = parseCliArguments(["serve", "--target", ".code/htmls/page.html"], appDirectory);
  assert.equal(nested.projectRoot, realpathSync(monorepo));
  assert.equal(nested.projectDirectory, realpathSync(appDirectory));
  assert.equal(nested.target, "apps/web/.code/htmls/page.html");
  assert.equal(defaults.port, 18765);
  assert.equal(defaults.allowAiJobsWithScripts, true);
  const optedOut = parseCliArguments(["serve", "--project-root", ".", "--target", "assets/x.png", "--no-ai-jobs-with-scripts"], "/tmp");
  assert.equal(optedOut.allowAiJobsWithScripts, false);
  const live = parseCliArguments(["serve", "--project-root", ".", "--target", "http://localhost:5173", "--start", "npm run dev", "--stop", "npm run down"], "/tmp");
  assert.equal(live.target, "http://localhost:5173");
  assert.equal(live.startCommand, "npm run dev");
  assert.equal(live.stopCommand, "npm run down");
  const privateNetwork = parseCliArguments(["serve", "--project-root", ".", "--target", "http://192.168.11.13:3000", "--start", "npm run dev"], "/tmp");
  assert.equal(privateNetwork.target, "http://192.168.11.13:3000");
  assert.equal(privateNetwork.startCommand, "npm run dev");
  assert.throws(() => assertLoopbackHost("0.0.0.0"), /host/);
  assert.throws(() => parseCliArguments(["serve", "--project-root", ".", "--target", "assets\\x.png"]), /POSIX/);
  assert.throws(() => parseCliArguments(["serve", "--project-root", ".", "--target", "assets/x.png", "--port", "0"]), /port/);
  const hosted = parseCliArguments(["serve", "--project-root", ".", "--target", "https://example.com/products"], "/tmp");
  assert.equal(hosted.target, "https://example.com/products");
  assert.throws(() => parseCliArguments(["serve", "--project-root", ".", "--target", "assets/x.png", "--start", "npm run dev"]), /requires a loopback or private-network URL/);
  assert.throws(() => parseCliArguments(["serve", "--project-root", ".", "--target", "https://example.com", "--start", "npm run dev"]), /requires a loopback or private-network URL/);
  assert.throws(() => parseCliArguments(["serve", "--project-root", ".", "--target", "assets/x.png", "--allow-scripts"]), /usage/);
  assert.throws(() => parseCliArguments(["serve", "--project-root", ".", "--target", "http://localhost:5173", "--stop", "npm run down"]), /requires --start/);
});

test("session target hash matches the target file", async () => {
  const session = await (await fetch(`${baseUrl}/api/session`)).json() as { target: { sha256: string } };
  assert.equal(session.target.sha256, fileSha256(path.join(root, ".code/htmls/pages/index.html")));
});

test("exposes batch, list, and cancel job APIs and treats exit zero as success", async () => {
  const batchResponse = await fetch(`${baseUrl}/api/jobs/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ max_parallel: 2 }),
  });
  const batch = await batchResponse.json() as { batch_id: string; jobs: Array<{ id: string }> };
  assert.equal(batchResponse.status, 200);
  assert.ok(batch.batch_id);
  assert.ok(batch.jobs.length > 0);
  for (let index = 0; index < 50; index += 1) {
    const state = await (await fetch(`${baseUrl}/api/jobs`)).json() as { jobs: Array<{ id: string; state: string }> };
    if (state.jobs.find(({ id }) => id === batch.jobs[0]!.id)?.state === "succeeded") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const state = await (await fetch(`${baseUrl}/api/jobs`)).json() as { jobs: Array<{ id: string; state: string }> };
  assert.equal(state.jobs.find(({ id }) => id === batch.jobs[0]!.id)?.state, "succeeded");
  const cancelMissing = await fetch(`${baseUrl}/api/jobs/missing/cancel`, { method: "POST" });
  assert.equal(cancelMissing.status, 404);
});
