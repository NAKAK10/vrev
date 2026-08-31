import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureDefaultPlugins } from "../src/cli.js";
import {
  CapabilityRegistry,
  createPluginHostRuntime,
  createProcessSupervisor,
  createVisualReviewServer,
  listPlugins,
  pluginSettingsRevision,
  readPluginSettings,
  REVIEW_DOMAIN_DEPENDENCIES_CAPABILITY_ID,
  reviewDomainDependencies,
  updatePluginSettings,
} from "../src/index.js";
import {
  ANNOTATION_WORKFLOW_CAPABILITY_ID,
  PROCESS_SUPERVISOR_CAPABILITY_ID,
  createAnnotationWorkflowBridgeAdapter,
  type AnnotationWorkflowCapabilityV1,
} from "../plugins/annotation-workflow/server/index.js";

function repository(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "visual-review-workflow-extraction-"));
  mkdirSync(path.join(root, ".git"));
  mkdirSync(path.join(root, ".code/htmls"), { recursive: true });
  writeFileSync(path.join(root, ".code/htmls/index.html"), "<h1>Workflow</h1>");
  return root;
}

test("deprecated workflow modules are delegating facades and Core has no job policy", () => {
  const managerFacade = readFileSync(new URL("../../src/job-manager.ts", import.meta.url), "utf8");
  const storeFacade = readFileSync(new URL("../../src/job-store.ts", import.meta.url), "utf8");
  const adapterFacade = readFileSync(new URL("../../src/adapters.ts", import.meta.url), "utf8");
  const manager = readFileSync(new URL("../../plugins/annotation-workflow/server/job-manager.ts", import.meta.url), "utf8");
  const store = readFileSync(new URL("../../plugins/annotation-workflow/server/job-store.ts", import.meta.url), "utf8");

  assert.match(managerFacade, /plugins\/annotation-workflow\/server\/job-manager/);
  assert.doesNotMatch(managerFacade, /VISUAL_REVIEW_ISSUE_DRAFT_START|recoverRunning|deferred_checkpoint/);
  assert.match(storeFacade, /plugins\/annotation-workflow\/server\/job-store/);
  assert.doesNotMatch(storeFacade, /job-state\.json|recoverRunning|withFileLock/);
  assert.match(adapterFacade, /createProcessSupervisor/);
  assert.doesNotMatch(adapterFacade, /opencode|claude|codex|copilot/);
  assert.match(manager, /ReviewCapabilityV1/);
  assert.match(manager, /runnerRegistry\.resolve/);
  assert.doesNotMatch(manager, /annotation add-message|annotation set-status/);
  assert.doesNotMatch(store, /from ["']\.\.\/\.\.\/\.\.\/src\//);
});

test("annotation-workflow server capability follows plugin lifecycle", async () => {
  const root = repository();
  await ensureDefaultPlugins(root);
  const capabilities = new CapabilityRegistry();
  capabilities.register(REVIEW_DOMAIN_DEPENDENCIES_CAPABILITY_ID, 1, reviewDomainDependencies);
  capabilities.register(PROCESS_SUPERVISOR_CAPABILITY_ID, 1, createProcessSupervisor());
  const runtime = createPluginHostRuntime({
    workspaceRoot: root,
    workspaceId: "workspace",
    target: { id: "target", source: ".code/htmls/index.html" },
    capabilities,
  });

  await runtime.start();
  assert.equal(runtime.status("review").state, "ready");
  assert.equal(runtime.status("annotation-workflow").state, "ready");
  const workflow = capabilities.resolve<AnnotationWorkflowCapabilityV1>(ANNOTATION_WORKFLOW_CAPABILITY_ID, 1);
  assert.equal(workflow.apiVersion, 1);
  assert.deepEqual(workflow.manager.list().jobs, []);
  await runtime.stop();
  assert.equal(capabilities.has(ANNOTATION_WORKFLOW_CAPABILITY_ID, 1), false);
});

test("workflow bridge persists shared settings and strips legacy custom commands from jobs.list", async () => {
  const root = repository();
  const review = {
    apiVersion: 1 as const,
    store: {
      target: { projectRoot: root },
      load: () => ({ revision: 1, annotations: [], events: [] }),
      loadActive: () => ({ annotations: [] }),
      addMessage() {},
      setStatus() {},
    },
  };
  let enqueueInput: unknown;
  let cancelInput: unknown;
  let retryInput: unknown;
  const manager = {
    list: () => ({ revision: 2, batches: [{ id: "legacy", max_parallel: 1, opencode_attach: null, runner_id: null, custom_command: "do-not-expose" }], jobs: [{ id: "job-1", batch_id: "legacy", annotation_id: "annotation-1", page_path: "/", source_hash: "hash", cli: "codex", custom_name: null, session_id: null, state: "running", created: "2026-08-31T00:00:00.000Z", started: "2026-08-31T00:00:01.000Z", finished: null, exit_code: null, summary: "running" }] }),
    enqueue: (input: unknown) => { enqueueInput = input; return { batch_id: "batch", jobs: [] }; },
    retry: (annotationId: string, input: unknown) => { retryInput = { annotationId, input }; return { batch_id: "retry", jobs: [] }; },
    cancel: (input: unknown) => { cancelInput = input; },
  };
  const externalRunnerId = "00000000-0000-4000-8000-000000000001";
  const unverifiedRunnerId = "00000000-0000-4000-8000-000000000002";
  const runnerRegistry = {
    list: () => [
      { runner_id: externalRunnerId, name: "Local AI", provider_id: "custom-command", verified: true },
      { runner_id: unverifiedRunnerId, name: "Pending AI", provider_id: "custom-command", verified: false },
    ],
    resolve: () => ({ command: "agent", args: [] }),
  };
  const bridge = createAnnotationWorkflowBridgeAdapter(review as never, manager as never, runnerRegistry);
  const saved = await bridge.command("workflow.settings.update", { request_id: "save", input: { runner: "pi", max_parallel: "4", auto_run: true } });
  assert.equal(saved.ok, true);
  const loaded = await bridge.query("workflow.settings", { request_id: "load", input: {} });
  assert.equal(loaded.ok, true);
  const settings = (loaded as { data: { runner: string; max_parallel: number; auto_run: boolean } }).data;
  assert.equal(settings.runner, "pi");
  assert.equal(settings.max_parallel, 4);
  assert.equal(settings.auto_run, true);
  const externalSelection = `custom:${externalRunnerId}`;
  const externalSaved = await bridge.command("workflow.settings.update", { request_id: "external-save", input: { runner: externalSelection, max_parallel: 3, auto_run: false } });
  assert.equal(externalSaved.ok, true);
  const externalLoaded = await bridge.query("workflow.settings", { request_id: "external-load", input: {} });
  assert.deepEqual((externalLoaded as { data: { runner: string; runner_options: { value: string }[] } }).data.runner, externalSelection);
  const runnerOptions = (externalLoaded as { data: { runner_options: { value: string; label: string }[] } }).data.runner_options;
  assert.equal(runnerOptions.some(({ value }) => value === externalSelection), true);
  assert.equal(runnerOptions.some(({ value, label }) => value === `custom:${unverifiedRunnerId}` && label.includes("未検証")), true);
  await assert.rejects(bridge.command("jobs.enqueue", { request_id: "unverified", input: { runner: `custom:${unverifiedRunnerId}`, max_parallel: 3 } }), /未検証/);
  await bridge.command("jobs.enqueue", { request_id: "enqueue", input: { runner: externalSelection, max_parallel: 3 } });
  assert.deepEqual(enqueueInput, { cli: "custom", runner_id: externalRunnerId, max_parallel: 3 });
  await bridge.command("jobs.retry", { request_id: "retry", input: { annotation_id: "annotation-1", runner: externalSelection, max_parallel: 2 } });
  assert.deepEqual(retryInput, { annotationId: "annotation-1", input: { cli: "custom", runner_id: externalRunnerId, max_parallel: 2 } });
  const jobs = await bridge.query("jobs.list", { request_id: "jobs", input: {} });
  assert.equal(jobs.ok, true);
  assert.deepEqual((jobs as { data: { active: unknown } }).data.active, { job_id: "job-1", started_at: "2026-08-31T00:00:01.000Z", latest_info: "1件のAI修正を実行中です" });
  assert.doesNotMatch(JSON.stringify(jobs), /custom_command|do-not-expose/);
  await bridge.command("jobs.cancel", { request_id: "cancel", input: { job_id: "job-1" } });
  assert.equal(cancelInput, "job-1");
});

test("disabling annotation-workflow rejects legacy job APIs while review stays available", async () => {
  const root = repository();
  await ensureDefaultPlugins(root);
  const plugin = listPlugins(root).find(({ id }) => id === "annotation-workflow")!;
  updatePluginSettings(plugin.id, plugin.manifest, {
    revision: pluginSettingsRevision(readPluginSettings(root)), enabled: false, configuration: {},
  }, root);
  const visual = createVisualReviewServer({ projectRoot: root, target: ".code/htmls/index.html" });
  await new Promise<void>((resolve) => visual.server.listen(0, "127.0.0.1", resolve));
  const address = visual.server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${origin}/api/session`)).status, 200);
    const jobs = await fetch(`${origin}/api/jobs`);
    assert.equal(jobs.status, 409);
    assert.deepEqual(await jobs.json(), { error: "annotation workflow plugin is disabled" });
  } finally {
    await visual.close();
  }
});
