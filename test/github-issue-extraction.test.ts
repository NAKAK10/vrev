import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  createIssueTaskCapability,
  ISSUE_TASK_CAPABILITY_ID,
  type IssueProjectionAnnotationV1,
  type IssueTaskCapabilityV1,
} from "../plugins/github-issue/server/index.js";

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
    load: () => ({ annotations: [annotation] }),
    loadActive: () => ({ annotations: [annotation] }),
    setIssueDraftReady: (_id: string, title: string, body: string) => { drafts.push({ title, body }); annotation.issue_state = "ready"; },
    completeIssueDraft: (_id: string, _title: string, url: string) => { annotation.issue_state = "created"; annotation.issue_url = url; },
  };
  const annotations = { create: (): never => { throw new Error("not implemented"); } };
  return { annotation, drafts, task: createIssueTaskCapability({ apiVersion: 1, store, annotations }, { provider }) };
}

test("Issue task accepts only allowed annotation IDs and rejects internal references", () => {
  const fixture = taskFixture({ createIssue: async () => ({ url: "https://github.com/o/r/issues/1" }) });
  const block = (id: string, body: string) => `VISUAL_REVIEW_ISSUE_DRAFT_START\n${JSON.stringify({ annotation_id: id, title: "Title", body })}\nVISUAL_REVIEW_ISSUE_DRAFT_END`;
  fixture.task.acceptCoordinatorOutput(`${block("other-id", "Body")}\n${block("allowed-id", "mentions allowed-id")}`, new Set(["allowed-id"]));
  assert.deepEqual(fixture.drafts, []);
  fixture.task.acceptCoordinatorOutput(block("allowed-id", "Standalone body"), new Set(["allowed-id"]));
  assert.deepEqual(fixture.drafts, [{ title: "Title", body: "Standalone body" }]);
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
  assert.equal(calls, 1);
  const indeterminate = Object.assign(new Error("outcome indeterminate"), { indeterminate: true });
  reject(indeterminate);
  await assert.rejects(first, /indeterminate/);
  await assert.rejects(duplicate, /indeterminate/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
});

test("github-issue schema-v4 capability follows lifecycle and disabled code is not evaluated", async () => {
  const root = repository();
  await ensureDefaultPlugins(root);
  const capabilities = new CapabilityRegistry();
  capabilities.register(REVIEW_DOMAIN_DEPENDENCIES_CAPABILITY_ID, 1, reviewDomainDependencies);
  const runtime = createPluginHostRuntime({ workspaceRoot: root, workspaceId: "workspace", target: { id: "target", source: ".code/htmls/index.html" }, capabilities });
  await runtime.start();
  assert.equal(runtime.status("github-issue").state, "ready");
  assert.equal(capabilities.resolve<IssueTaskCapabilityV1>(ISSUE_TASK_CAPABILITY_ID, 1).apiVersion, 1);
  await runtime.stop();
  assert.equal(capabilities.has(ISSUE_TASK_CAPABILITY_ID, 1), false);

  const plugin = listPlugins(root).find(({ id }) => id === "github-issue")!;
  updatePluginSettings(plugin.id, plugin.manifest, { revision: pluginSettingsRevision(readPluginSettings(root)), enabled: false, configuration: {} }, root);
  writeFileSync(path.join(installedPluginDirectory("github-issue", root), "server/index.js"), "throw new Error('disabled module evaluated')");
  const disabledCapabilities = new CapabilityRegistry();
  disabledCapabilities.register(REVIEW_DOMAIN_DEPENDENCIES_CAPABILITY_ID, 1, reviewDomainDependencies);
  const disabledRuntime = createPluginHostRuntime({ workspaceRoot: root, workspaceId: "workspace", target: { id: "target", source: ".code/htmls/index.html" }, capabilities: disabledCapabilities });
  await disabledRuntime.start();
  assert.equal(disabledRuntime.status("github-issue").state, "unavailable");
  assert.equal(disabledCapabilities.has(ISSUE_TASK_CAPABILITY_ID, 1), false);
  await disabledRuntime.stop();
});

test("Issue implementation has plugin boundaries and legacy Core files are adapters", () => {
  const workflow = readFileSync(new URL("../../plugins/annotation-workflow/server/job-manager.ts", import.meta.url), "utf8");
  const issue = readFileSync(new URL("../../plugins/github-issue/server/index.js", import.meta.url), "utf8");
  const facade = readFileSync(new URL("../../src/github-issue.ts", import.meta.url), "utf8");
  assert.doesNotMatch(workflow, /VISUAL_REVIEW_ISSUE_DRAFT_START|GitHub Issue自体は作成せず|extractIssueDraftOutput/);
  assert.doesNotMatch(issue, /plugins\/(?:review|annotation-workflow)\/server/);
  assert.match(facade, /plugins\/github-issue\/server/);
  assert.doesNotMatch(facade, /function requiredText|new Map/);
});
