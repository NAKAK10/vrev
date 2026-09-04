import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureDefaultPlugins } from "../src/cli.js";
import {
  CapabilityRegistry,
  createPluginHostRuntime,
  installedPluginDirectory,
  listPlugins,
  pluginSettingsRevision,
  readPluginSettings,
  REVIEW_DOMAIN_DEPENDENCIES_CAPABILITY_ID,
  reviewDomainDependencies,
  updatePluginSettings,
} from "../src/index.js";
import {
  createIssueBridgeAdapter,
  createIssueTaskCapability,
  ISSUE_TASK_CAPABILITY_ID,
  type IssueProjectionAnnotationV1,
  type IssueTaskCapabilityV1,
} from "../plugins/github-issue/server/index.js";
import { provider } from "../plugins/github-issue/server/issue-provider.js";
import { createProcessSupervisor } from "../src/process-supervisor.js";
import { createRunnerRegistry } from "../src/runner-registry.js";

function repository(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "visual-review-issue-extraction-"));
  mkdirSync(path.join(root, ".git"));
  mkdirSync(path.join(root, ".code/htmls"), { recursive: true });
  writeFileSync(path.join(root, ".code/htmls/index.html"), "<h1>Issue</h1>");
  return root;
}

function taskFixture(provider: { createIssue(root: string, draft: { title: string; body: string }): Promise<{ url: string }> }) {
  const annotation: IssueProjectionAnnotationV1 = { id: "allowed-id", status: "addressed", issue_state: "requested" };
  const drafts: Array<{ title: string; body: string }> = [];
  const store = {
    target: { projectRoot: "/workspace" },
    load: async () => ({ annotations: [annotation] }),
    loadActive: async () => ({ annotations: [annotation] }),
    setIssueDraftReady: async (_id: string, title: string, body: string) => { drafts.push({ title, body }); annotation.issue_state = "ready"; },
    failIssueDraft: async (): Promise<never> => { throw new Error("not implemented"); },
    completeIssueDraft: async (_id: string, _title: string, url: string) => { annotation.issue_state = "created"; annotation.issue_url = url; },
  };
  const annotations = { create: (): never => { throw new Error("not implemented"); } };
  return { annotation, drafts, task: createIssueTaskCapability({ apiVersion: 1, store, annotations }, { provider }) };
}

test("Issue task accepts only allowed annotation IDs and rejects internal references", async () => {
  const fixture = taskFixture({ createIssue: async () => ({ url: "https://github.com/o/r/issues/1" }) });
  const block = (id: string, body: string) => `VISUAL_REVIEW_ISSUE_DRAFT_START\n${JSON.stringify({ annotation_id: id, title: "Title", body })}\nVISUAL_REVIEW_ISSUE_DRAFT_END`;
  await fixture.task.acceptCoordinatorOutput(`${block("other-id", "Body")}\n${block("allowed-id", "mentions allowed-id")}`, new Set(["allowed-id"]));
  assert.deepEqual(fixture.drafts, []);
  await fixture.task.acceptCoordinatorOutput(block("allowed-id", "Standalone body"), new Set(["allowed-id"]));
  assert.deepEqual(fixture.drafts, [{ title: "Title", body: "Standalone body" }]);
});

test("a gh rejection before the mutation is a definite failure, not an indeterminate one", async () => {
  const root = repository();
  const stubDirectory = mkdtempSync(path.join(os.tmpdir(), "visual-review-gh-stub-"));
  const writeStub = (stderr: string): void => {
    const stub = path.join(stubDirectory, "gh");
    writeFileSync(stub, `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' ${JSON.stringify(stderr)} >&2\nexit 1\n`);
    chmodSync(stub, 0o755);
  };
  const originalPath = process.env.PATH;
  process.env.PATH = `${stubDirectory}${path.delimiter}${originalPath ?? ""}`;
  try {
    // GitHub answers "no such repository" before creating anything, so the reviewer must be told
    // the Issue was not created rather than that the outcome is unknown.
    writeStub("GraphQL: Could not resolve to a Repository with the name 'owner/repo'. (repository)");
    const rejected = await provider.createIssue(root, { title: "t", body: "b" }).then(() => null, (error: unknown) => error);
    assert.ok(rejected instanceof Error);
    assert.equal((rejected as { indeterminate?: boolean }).indeterminate, undefined);
    assert.match(rejected.message, /Could not resolve to a Repository/);
    assert.doesNotMatch(rejected.message, /不明/);

    // A failure that says nothing about whether the mutation landed stays indeterminate.
    writeStub("connection reset by peer");
    const unknown = await provider.createIssue(root, { title: "t", body: "b" }).then(() => null, (error: unknown) => error);
    assert.equal((unknown as { indeterminate?: boolean }).indeterminate, true);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("resolveTarget reads the repo and account gh would use, and returns null on failure or garbage", async () => {
  const root = repository();
  const stubDirectory = mkdtempSync(path.join(os.tmpdir(), "visual-review-gh-target-stub-"));
  const stubPath = path.join(stubDirectory, "gh");
  const writeStub = (script: string): void => { writeFileSync(stubPath, script); chmodSync(stubPath, 0o755); };
  const originalPath = process.env.PATH;
  process.env.PATH = `${stubDirectory}${path.delimiter}${originalPath ?? ""}`;
  try {
    writeStub(`#!/bin/sh\nif [ "$1" = "repo" ]; then printf '%s\\n' "example-org/example-repo"; exit 0; fi\nif [ "$1" = "api" ]; then printf '%s\\n' "example-user"; exit 0; fi\nexit 1\n`);
    assert.deepEqual(await provider.resolveTarget!(root), { repo: "example-org/example-repo", account: "example-user" });

    writeStub(`#!/bin/sh\nexit 1\n`);
    assert.deepEqual(await provider.resolveTarget!(root), { repo: null, account: null });

    // gh output that fails the validation regexes must never reach the DOM as-is.
    writeStub(`#!/bin/sh\nprintf '%s\\n' "not a repo name!!"\nexit 0\n`);
    assert.deepEqual(await provider.resolveTarget!(root), { repo: null, account: null });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("issue.target bridge query explicitly reports unavailable fields when the target is unknown", async () => {
  const fixture = taskFixture({ createIssue: async () => ({ url: "https://github.com/o/r/issues/1" }) });
  const review = { store: { target: { projectRoot: "/workspace" } } };
  const adapter = createIssueBridgeAdapter(review as never, fixture.task, {
    provider: { createIssue: async () => ({ url: "https://github.com/o/r/issues/1" }), resolveTarget: async () => ({ repo: null, account: null }) },
  });
  const result = await adapter.query("issue.target", { request_id: "r1", input: {} });
  assert.deepEqual(result, { ok: true, data: { repo: "利用できません", account: "利用できません" } });
});

test("issue.target bridge query returns the resolved repo and account", async () => {
  const fixture = taskFixture({ createIssue: async () => ({ url: "https://github.com/o/r/issues/1" }) });
  const review = { store: { target: { projectRoot: "/workspace" } } };
  const adapter = createIssueBridgeAdapter(review as never, fixture.task, {
    provider: {
      createIssue: async () => ({ url: "https://github.com/o/r/issues/1" }),
      resolveTarget: async () => ({ repo: "example-org/example-repo", account: "example-user" }),
    },
  });
  const result = await adapter.query("issue.target", { request_id: "r1", input: {} });
  assert.deepEqual(result, { ok: true, data: { repo: "example-org/example-repo", account: "example-user" } });
});

test("Issue creation is single-flight and never automatically retries an indeterminate result", async () => {
  let calls = 0;
  let reject!: (error: Error) => void;
  const fixture = taskFixture({
    createIssue: () => { calls += 1; return new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }); },
  });
  fixture.annotation.issue_state = "ready";
  const first = fixture.task.create("allowed-id", { title: "Title", body: "Body" });
  const duplicate = fixture.task.create("allowed-id", { title: "Title", body: "Body" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  const indeterminate = Object.assign(new Error("outcome indeterminate"), { indeterminate: true });
  reject(indeterminate);
  await assert.rejects(first, /indeterminate/);
  await assert.rejects(duplicate, /indeterminate/);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(fixture.task.create("allowed-id", { title: "Title", body: "Body" }), /indeterminate/);
  assert.equal(calls, 1);
});

test("github-issue schema-v4 capability follows lifecycle and disabled code is not evaluated", async () => {
  const root = repository();
  await ensureDefaultPlugins(root);
  const workflow = listPlugins(root).find(({ id }) => id === "annotation-workflow")!;
  updatePluginSettings(workflow.id, workflow.manifest, { revision: pluginSettingsRevision(readPluginSettings(root)), enabled: false, configuration: {} }, root);
  const capabilities = new CapabilityRegistry();
  capabilities.register(REVIEW_DOMAIN_DEPENDENCIES_CAPABILITY_ID, 1, reviewDomainDependencies);
  capabilities.register("host.runner-registry", 1, createRunnerRegistry(root));
  capabilities.register("host.process-supervisor", 1, createProcessSupervisor());
  const runtime = createPluginHostRuntime({ workspaceRoot: root, workspaceId: "workspace", target: { id: "target", source: ".code/htmls/index.html" }, capabilities });
  await runtime.start();
  assert.equal(runtime.status("github-issue").state, "ready");
  assert.equal(runtime.status("annotation-workflow").state, "unavailable");
  assert.deepEqual(await runtime.query("github-issue", "issues.list", { protocol: "plugin-bridge/1", request_id: "issues-without-workflow", input: {} }), { ok: true, revision: "review:0", data: { items: [], total: 0, latest_id: "", filters: [
    { value: "creating", label: "作成中" },
    { value: "retry", label: "再作成" },
    { value: "drafted", label: "作成済み" },
    { value: "resolved", label: "解決済み" },
  ] } });
  assert.equal(capabilities.resolve<IssueTaskCapabilityV1>(ISSUE_TASK_CAPABILITY_ID, 1).apiVersion, 1);
  await runtime.stop();
  assert.equal(capabilities.has(ISSUE_TASK_CAPABILITY_ID, 1), false);

  const plugin = listPlugins(root).find(({ id }) => id === "github-issue")!;
  updatePluginSettings(plugin.id, plugin.manifest, { revision: pluginSettingsRevision(readPluginSettings(root)), enabled: false, configuration: {} }, root);
  writeFileSync(path.join(installedPluginDirectory("github-issue", root), "server/index.js"), "throw new Error('disabled module evaluated')");
  const disabledCapabilities = new CapabilityRegistry();
  disabledCapabilities.register(REVIEW_DOMAIN_DEPENDENCIES_CAPABILITY_ID, 1, reviewDomainDependencies);
  disabledCapabilities.register("host.runner-registry", 1, createRunnerRegistry(root));
  disabledCapabilities.register("host.process-supervisor", 1, createProcessSupervisor());
  const disabledRuntime = createPluginHostRuntime({ workspaceRoot: root, workspaceId: "workspace", target: { id: "target", source: ".code/htmls/index.html" }, capabilities: disabledCapabilities });
  await disabledRuntime.start();
  assert.equal(disabledRuntime.status("github-issue").state, "unavailable");
  assert.equal(disabledCapabilities.has(ISSUE_TASK_CAPABILITY_ID, 1), false);
  await disabledRuntime.stop();
});

test("Issue implementation has plugin boundaries and legacy Core files are adapters", () => {
  const packageText = (paths: string[]) => paths.map((file) => readFileSync(path.join(process.cwd(), file), "utf8")).join("\n");
  const workflow = packageText([
    "plugins/annotation-workflow/visual-review.plugin.json", "plugins/annotation-workflow/server/index.ts",
    "plugins/annotation-workflow/server/job-manager.ts", "plugins/annotation-workflow/server/workflow-types.ts",
    "plugins/annotation-workflow/ui/sidebar.ui.json",
  ]);
  const issuePackage = packageText([
    "plugins/github-issue/visual-review.plugin.json", "plugins/github-issue/server.contract.json", "plugins/github-issue/server/index.js",
    "plugins/github-issue/README.md", "plugins/github-issue/ui/header.ui.json", "plugins/github-issue/ui/sidebar.ui.json",
  ]);
  const aiPackage = packageText([
    "plugins/ai/visual-review.plugin.json", "plugins/ai/server/index.js", "plugins/ai/server/settings.js", "plugins/ai/ui/settings.ui.json",
  ]);
  const issue = readFileSync(new URL("../../plugins/github-issue/server/index.js", import.meta.url), "utf8");
  const facade = readFileSync(new URL("../../src/github-issue.ts", import.meta.url), "utf8");
  const reviewStage = readFileSync(new URL("../../plugins/review/ui/stage.ui.json", import.meta.url), "utf8");
  assert.doesNotMatch(workflow, /VISUAL_REVIEW_ISSUE_DRAFT_START|extractIssueDraftOutput|github-issue|issue-task|issue_state|taskCapability/);
  assert.doesNotMatch(issuePackage, /annotation-workflow|ai_method_id|issue\.ai-methods/);
  assert.match(issue, /ai\.invoke\(\{\s*mode: "text-only"/);
  assert.doesNotMatch(issue, /ai\.list\(|ai\.invoke\(\{[^}]*method_id/s);
  assert.match(aiPackage, /selectAiMethod|method_id/);
  assert.doesNotMatch(issue, /plugins\/(?:review|annotation-workflow)\/server/);
  assert.doesNotMatch(reviewStage, /review\.comment-dialog\.actions/);
  assert.match(facade, /plugins\/github-issue\/server/);
  assert.doesNotMatch(facade, /function requiredText|new Map/);
});
