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
  createRunnerRegistry,
  createVrevServer,
  listPlugins,
  pluginSettingsRevision,
  readPluginSettings,
  REVIEW_DOMAIN_DEPENDENCIES_CAPABILITY_ID,
  reviewDomainDependencies,
  updatePluginSettings,
} from "../src/index.js";
import {
  ANNOTATION_WORKFLOW_CAPABILITY_ID,
  createAnnotationWorkflowBridgeAdapter,
  type AnnotationWorkflowCapabilityV1,
} from "../plugins/annotation-workflow/server/index.js";

function repository(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vrev-workflow-extraction-"));
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
  assert.doesNotMatch(managerFacade, /VREV_ISSUE_DRAFT_START|recoverRunning|deferred_checkpoint/);
  assert.match(storeFacade, /plugins\/annotation-workflow\/server\/job-store/);
  assert.doesNotMatch(storeFacade, /job-state\.json|recoverRunning|withFileLock/);
  assert.match(adapterFacade, /createProcessSupervisor/);
  assert.doesNotMatch(adapterFacade, /opencode|claude|codex|copilot/);
  assert.match(manager, /ReviewCapabilityV1/);
  assert.match(manager, /this\.ai\.invoke/);
  assert.doesNotMatch(manager, /annotation add-message|annotation set-status/);
  assert.doesNotMatch(store, /from ["']\.\.\/\.\.\/\.\.\/src\//);
});

test("annotation-workflow server capability follows plugin lifecycle", async () => {
  const root = repository();
  await ensureDefaultPlugins(root);
  const capabilities = new CapabilityRegistry();
  capabilities.register(REVIEW_DOMAIN_DEPENDENCIES_CAPABILITY_ID, 1, reviewDomainDependencies);
  capabilities.register("host.process-supervisor", 1, createProcessSupervisor());
  const runnerRegistry = createRunnerRegistry(root);
  capabilities.register("host.runner-registry", 1, runnerRegistry);
  const runtime = createPluginHostRuntime({
    workspaceRoot: root,
    workspaceId: "workspace",
    target: { id: "target", source: ".code/htmls/index.html" },
    capabilities,
    runnerRegistry,
  });

  await runtime.start();
  assert.equal(runtime.status("review").state, "ready");
  assert.equal(runtime.status("annotation-workflow").state, "ready");
  const workflow = capabilities.resolve<AnnotationWorkflowCapabilityV1>(ANNOTATION_WORKFLOW_CAPABILITY_ID, 1);
  assert.equal(workflow.apiVersion, 1);
  assert.deepEqual((await workflow.manager.list()).jobs, []);
  await runtime.stop();
  assert.equal(capabilities.has(ANNOTATION_WORKFLOW_CAPABILITY_ID, 1), false);
});

test("workflow bridge persists workflow-only settings and sends no runner payload", async () => {
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
    list: () => ({ revision: 2, batches: [{ id: "legacy", max_parallel: 1, opencode_attach: null, runner_id: null, custom_command: "do-not-expose" }], jobs: [
      { id: "job-1", batch_id: "legacy", annotation_id: "annotation-1", page_path: "/", source_hash: "hash", cli: "ai", custom_name: null, session_id: null, state: "running", created: "2026-08-31T00:00:00.000Z", started: "2026-08-31T00:00:01.000Z", finished: null, exit_code: null, summary: "running" },
      { id: "job-2", batch_id: "queued", annotation_id: "annotation-2", page_path: "/", source_hash: "hash", cli: "ai", custom_name: null, session_id: null, state: "queued", created: "2026-08-31T00:00:02.000Z", started: null, finished: null, exit_code: null, summary: "queued" },
    ] }),
    enqueue: (input: unknown) => { enqueueInput = input; return { batch_id: "batch", jobs: Array.isArray((input as { annotation_ids?: unknown }).annotation_ids) ? [{}] : [] }; },
    retry: (annotationId: string, input: unknown) => { retryInput = { annotationId, input }; return { batch_id: "retry", jobs: [] }; },
    cancel: (input: unknown) => { cancelInput = input; },
  };
  const bridge = createAnnotationWorkflowBridgeAdapter(review as never, manager as never);
  const saved = await bridge.command("workflow.settings.update", { request_id: "save", input: { max_parallel: "4", auto_run: true } });
  assert.equal(saved.ok, true);
  const loaded = await bridge.query("workflow.settings", { request_id: "load", input: {} });
  assert.equal(loaded.ok, true);
  const settings = (loaded as { data: { max_parallel: number; auto_run: boolean } }).data;
  assert.equal(settings.max_parallel, 4);
  assert.equal(settings.auto_run, true);
  assert.equal(Object.hasOwn(settings, "runner"), false);
  assert.equal(Object.hasOwn(settings, "runner_options"), false);
  await bridge.command("jobs.enqueue", { request_id: "enqueue", input: { max_parallel: 3 } });
  assert.deepEqual(enqueueInput, { max_parallel: 3 });
  await bridge.command("jobs.enqueue", { request_id: "enqueue-one", input: { annotation_id: "annotation-1", max_parallel: 2 } });
  assert.deepEqual(enqueueInput, { max_parallel: 2, annotation_ids: ["annotation-1"] });
  await bridge.command("jobs.retry", { request_id: "retry", input: { annotation_id: "annotation-1", max_parallel: 2 } });
  assert.deepEqual(retryInput, { annotationId: "annotation-1", input: { max_parallel: 2 } });
  const jobs = await bridge.query("jobs.list", { request_id: "jobs", input: {} });
  assert.equal(jobs.ok, true);
  assert.deepEqual((jobs as { data: { active: unknown } }).data.active, { job_id: "job-1", started_at: "2026-08-31T00:00:01.000Z" });
  assert.doesNotMatch(JSON.stringify(jobs), /latest_info|AI修正を実行中です/);
  assert.equal((jobs as { data: { announcement: string } }).data.announcement, "2件のAI修正を処理中です");
  assert.doesNotMatch(JSON.stringify(jobs), /custom_command|do-not-expose/);
  await bridge.command("jobs.cancel", { request_id: "cancel", input: { job_id: "job-1" } });
  assert.equal(cancelInput, "job-1");

  const contract = readFileSync(path.join(process.cwd(), "plugins/annotation-workflow/server.contract.json"), "utf8");
  const ui = ["settings.ui.json", "sidebar.ui.json"].map((file) => readFileSync(path.join(process.cwd(), "plugins/annotation-workflow/ui", file), "utf8")).join("\n");
  assert.doesNotMatch(contract, /runner|method_id/);
  assert.doesNotMatch(ui, /runner|method_id/);
});

test("annotations.list owns only workflow status labels and filters", async () => {
  const root = repository();
  const review = {
    apiVersion: 1 as const,
    store: {
      target: { projectRoot: root },
      load: async () => ({
        revision: 1,
        annotations: [
          { id: "annotation-open", status: "open", kind: "dom", thread: [] },
          { id: "annotation-resolved", status: "resolved", kind: "region", thread: [] },
        ],
        events: [],
      }),
      loadActive: async () => ({ annotations: [] }),
      async addMessage() {},
      async setStatus() {},
    },
  };
  const manager = { list: async () => ({ revision: 1, batches: [], jobs: [] }), enqueue: async () => ({ batch_id: "", jobs: [] }), retry: async () => ({ batch_id: "", jobs: [] }), cancel: async () => {} };
  const bridge = createAnnotationWorkflowBridgeAdapter(review as never, manager as never);
  type ListData = { data: { filters: Array<{ value: string; label: string }>; items: Array<{ id: string; filter_id: string; status_label: string }> } };
  const result = await bridge.query("annotations.list", { request_id: "list", input: { hidden: [], kinds: ["dom", "region"] } }) as ListData;
  assert.deepEqual(result.data.filters, [
    { value: "open", label: "未対応" },
    { value: "in_progress", label: "AI対応中" },
    { value: "failed", label: "失敗" },
    { value: "addressed", label: "AI対応済み" },
    { value: "resolved", label: "解決済み" },
  ]);
  assert.deepEqual(result.data.items.map(({ id, filter_id, status_label }) => [id, filter_id, status_label]), [
    ["annotation-open", "open", "未対応"],
    ["annotation-resolved", "resolved", "解決済み"],
  ]);
});

test("disabling annotation-workflow rejects legacy job APIs while review stays available", async () => {
  const root = repository();
  await ensureDefaultPlugins(root);
  const plugin = listPlugins(root).find(({ id }) => id === "annotation-workflow")!;
  updatePluginSettings(plugin.id, plugin.manifest, {
    revision: pluginSettingsRevision(readPluginSettings(root)), enabled: false, configuration: {},
  }, root);
  const visual = createVrevServer({ projectRoot: root, target: ".code/htmls/index.html" });
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
