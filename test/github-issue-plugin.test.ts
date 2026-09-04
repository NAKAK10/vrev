import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installPlugin, loadPluginIssueProvider } from "../src/index.js";
import {
  createIssueBridgeAdapter,
  extractStandaloneIssueDraft,
  issueDraftMarkers,
  createIssueTaskCapability,
  type IssueAnnotationCreateInputV1,
  type IssueProjectionAnnotationV1,
  type IssueReviewCapabilityV1,
  type IssueTaskCapabilityV1,
} from "../plugins/github-issue/server/index.js";

type BridgeCommandResult =
  | { ok: true; revision?: string; data: Record<string, unknown>; effects?: unknown[] }
  | { ok: false; error: { code: string; message: string; retryable: boolean; request_id: string } };

function issueRequestFixture(calls: IssueAnnotationCreateInputV1[], draftsEnabled = true) {
  const review: IssueReviewCapabilityV1 = {
    apiVersion: 1,
    store: {
      target: { projectRoot: "/workspace" },
      load: async () => ({ annotations: [] }),
      loadActive: async () => ({ annotations: [] }),
      setIssueDraftReady: async () => { throw new Error("not implemented"); },
      failIssueDraft: async () => { throw new Error("not implemented"); },
      completeIssueDraft: async () => { throw new Error("not implemented"); },
    },
    annotations: {
      async create(input) {
        calls.push(input);
        if (typeof input.comment !== "string" || !input.comment.trim() || typeof input.anchor !== "object"
          || input.anchor === null || Array.isArray(input.anchor)) throw new Error("annotation input is invalid");
        return { review: { revision: 1 }, annotation: { id: "annotation-1", status: "open" } };
      },
    },
  };
  const issueTask: IssueTaskCapabilityV1 = {
    apiVersion: 1,
    coordinatorInstructions: () => "",
    acceptCoordinatorOutput: async () => [],
    state: () => "none",
    label: () => null,
    filters: () => [],
    filter: () => null,
    create: () => { throw new Error("not implemented"); },
  };
  return createIssueBridgeAdapter({ review, issueTask, draftsEnabled });
}

function issueTaskFixture(): IssueTaskCapabilityV1 {
  const review: IssueReviewCapabilityV1 = {
    apiVersion: 1,
    store: {
      target: { projectRoot: "/workspace" },
      load: async () => ({ annotations: [] }),
      loadActive: async () => ({ annotations: [] }),
      setIssueDraftReady: async () => { throw new Error("not implemented"); },
      failIssueDraft: async () => { throw new Error("not implemented"); },
      completeIssueDraft: async () => { throw new Error("not implemented"); },
    },
    annotations: {
      create: async () => { throw new Error("not implemented"); },
    },
  };
  return createIssueTaskCapability(review);
}

function aiFixture(
  runnerRegistry: { list(): Promise<readonly any[]> | readonly any[]; resolve(id: string, context: any): Promise<any> | any },
  processSupervisor: { run(spec: any): { result: Promise<{ exitCode: number | null; reason: string; stdout: string }>; cancel(): void } },
  invocations: Array<Record<string, unknown>> = [],
) {
  return {
    apiVersion: 1 as const,
    async list() {
      throw new Error("feature packages must not list or select AI methods");
    },
    invoke(input: { method_id?: string; prompt: string; options?: Record<string, unknown> }) {
      invocations.push(input);
      let running: ReturnType<typeof processSupervisor.run> | undefined;
      let cancelled = false;
      const result = (async () => {
        const descriptors = await runnerRegistry.list();
        const selected = descriptors.find(({ verified, profiles }) => verified && profiles?.includes("text-only"));
        if (!selected) throw new Error("AI package has no selected text-only method");
        const spec = await runnerRegistry.resolve(selected.runner_id, { prompt: input.prompt, options: { ...input.options, profile: "text-only" } });
        if (cancelled) return { status: "cancelled" as const, output: "", exit_code: null, message: "cancelled" };
        running = processSupervisor.run(spec);
        const completed = await running.result;
        return completed.reason === "exit" && completed.exitCode === 0
          ? { status: "completed" as const, output: completed.stdout, exit_code: 0 as const }
          : { status: "failed" as const, output: completed.stdout, exit_code: completed.exitCode, message: `failed: ${completed.reason}` };
      })();
      return { cancel: () => { cancelled = true; running?.cancel(); }, result };
    },
  };
}

function workspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "visual-review-github-issue-"));
  mkdirSync(path.join(root, ".git"));
  return root;
}

function fakeGh(directory: string, script: string): void {
  const executable = path.join(directory, "gh");
  writeFileSync(executable, `#!/bin/sh\n${script}\n`);
  chmodSync(executable, 0o755);
}

test("the github-issue provider sends the body over stdin and accepts a GitHub Issue URL", async () => {
  const root = workspace();
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const argsFile = path.join(root, "args.txt");
  const bodyFile = path.join(root, "body.txt");
  fakeGh(bin, 'printf "%s\\n" "$@" > "$GH_ARGS_FILE"\ncat > "$GH_BODY_FILE"\nprintf "created https://github.com/example/project/issues/42\\n"');

  await installPlugin(path.resolve("plugins/github-issue"), root);
  const { provider } = await loadPluginIssueProvider("github-issue", root);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  process.env.GH_ARGS_FILE = argsFile;
  process.env.GH_BODY_FILE = bodyFile;
  try {
    assert.deepEqual(await provider.createIssue(root, { title: "Issue title", body: "secret body\nline two" }), {
      url: "https://github.com/example/project/issues/42",
    });
  } finally {
    process.env.PATH = previousPath;
    delete process.env.GH_ARGS_FILE;
    delete process.env.GH_BODY_FILE;
  }

  assert.equal(readFileSync(bodyFile, "utf8"), "secret body\nline two");
  assert.deepEqual(readFileSync(argsFile, "utf8").trim().split("\n"), [
    "issue", "create", "--title", "Issue title", "--body-file", "-",
  ]);
});

test("the github-issue provider rejects non-GitHub output and excessive output", async () => {
  const root = workspace();
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  await installPlugin(path.resolve("plugins/github-issue"), root);
  const { provider } = await loadPluginIssueProvider("github-issue", root);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
  try {
    fakeGh(bin, 'cat >/dev/null\nprintf "https://example.com/example/project/issues/42\\n"');
    await assert.rejects(provider.createIssue(root, { title: "Title", body: "Body" }), /Issue URL/);
    fakeGh(bin, 'cat >/dev/null\nhead -c 65537 /dev/zero');
    await assert.rejects(provider.createIssue(root, { title: "Title", body: "Body" }), /output exceeded/);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("issue.draft persists a requested annotation immediately, marks it ready on success, and never calls GitHub", async () => {
  let readyCalls = 0;
  let githubCalls = 0;
  let resolvedPrompt = "";
  const annotation: IssueProjectionAnnotationV1 = { id: "annotation-1", status: "open", comment: "見出しを改善", anchor: { kind: "dom", selector: "h1" }, issue_state: "requested" };
  const review: IssueReviewCapabilityV1 = {
    apiVersion: 1,
    store: {
      target: { projectRoot: "/workspace" },
      load: async () => ({ annotations: [annotation] }),
      loadActive: async () => ({ annotations: [annotation] }),
      setIssueDraftReady: async (_id, title, body) => { readyCalls += 1; annotation.status = "addressed"; annotation.issue_state = "ready"; annotation.issue_title = title; annotation.issue_body = body; },
      failIssueDraft: async () => { throw new Error("must not fail"); },
      completeIssueDraft: async () => { throw new Error("must not create on GitHub"); },
    },
    annotations: { create: async (input) => { assert.deepEqual(input, { anchor: { kind: "dom", selector: "h1" }, comment: "見出しを改善", mode: "issue-request" }); return { review: {}, annotation }; } },
  };
  const task = createIssueTaskCapability(review, { provider: { createIssue: async () => { githubCalls += 1; return { url: "https://github.com/o/r/issues/1" }; } } });
  const runnerRegistry = {
    list: async () => [{ runner_id: "verified", name: "Verified", verified: true, profiles: ["text-only"] }],
    resolve: async (_runnerId: string, context: { prompt: string; options?: { profile?: string } }) => { assert.equal(context.options?.profile, "text-only"); resolvedPrompt = context.prompt; return { command: "ai", args: [] }; },
  };
  const processSupervisor = {
    run: () => {
      const nonce = resolvedPrompt.match(/VISUAL_REVIEW_ISSUE_DRAFT_([a-f0-9-]+)_START/)?.[1];
      assert.ok(nonce);
      const markers = issueDraftMarkers(nonce);
      return { cancel() {}, result: Promise.resolve({ exitCode: 0, reason: "exit" as const, stdout: `${markers.start}\n${JSON.stringify({ title: "Generated", body: "Standalone body" })}\n${markers.end}` }) };
    },
  };
  const invocations: Array<Record<string, unknown>> = [];
  const adapter = createIssueBridgeAdapter({ review, issueTask: task, ai: aiFixture(runnerRegistry, processSupervisor, invocations) });
  const result = await adapter.command("issue.draft", { request_id: "draft", input: { anchor: { kind: "dom", selector: "h1" }, request: "見出しを改善" } }) as BridgeCommandResult;
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.data, { annotation_id: "annotation-1", title: "Generated", body: "Standalone body" });
  assert.equal(Object.hasOwn(invocations[0]!, "method_id"), false);
  assert.equal(readyCalls, 1);
  assert.equal(githubCalls, 0);
  assert.match(resolvedPrompt, /toolやcommandを実行せず/);
  assert.match(resolvedPrompt, /ファイル編集・永続化・GitHub Issue作成を行わない/);
});

test("a failed AI invocation marks the annotation status failed instead of throwing past the bridge", async () => {
  let failMessage = "";
  const annotation: IssueProjectionAnnotationV1 = { id: "annotation-1", status: "open", comment: "見出しを改善", anchor: { kind: "dom", selector: "h1" }, issue_state: "requested" };
  const review: IssueReviewCapabilityV1 = {
    apiVersion: 1,
    store: {
      target: { projectRoot: "/workspace" },
      load: async () => ({ annotations: [annotation] }),
      loadActive: async () => ({ annotations: [annotation] }),
      setIssueDraftReady: async () => { throw new Error("must not become ready"); },
      failIssueDraft: async (_id, message) => { failMessage = message; annotation.status = "failed"; },
      completeIssueDraft: async () => { throw new Error("must not create on GitHub"); },
    },
    annotations: { create: async () => ({ review: {}, annotation }) },
  };
  const runnerRegistry = { list: async () => [], resolve: async () => { throw new Error("unused"); } };
  const processSupervisor = { run: (): never => { throw new Error("unused"); } };
  const adapter = createIssueBridgeAdapter({ review, issueTask: createIssueTaskCapability(review), ai: aiFixture(runnerRegistry, processSupervisor) });
  const result = await adapter.command("issue.draft", { request_id: "draft", input: { anchor: { kind: "dom", selector: "h1" }, request: "見出しを改善" } }) as BridgeCommandResult;
  assert.equal(result.ok, false);
  assert.equal(annotation.status, "failed");
  assert.match(failMessage, /text-only method/);
});

test("issue.draft.retry re-runs generation for a requested annotation and rejects annotations that already moved on", async () => {
  const requested: IssueProjectionAnnotationV1 = { id: "annotation-1", status: "failed", comment: "見出しを改善", anchor: { kind: "dom", selector: "h1" }, issue_state: "requested" };
  const ready: IssueProjectionAnnotationV1 = { id: "annotation-2", status: "addressed", comment: "本文の誤字", anchor: { kind: "dom", selector: "p" }, issue_state: "ready" };
  let readyCalls = 0;
  const review: IssueReviewCapabilityV1 = {
    apiVersion: 1,
    store: {
      target: { projectRoot: "/workspace" },
      load: async () => ({ annotations: [requested, ready] }),
      loadActive: async () => ({ annotations: [requested, ready] }),
      setIssueDraftReady: async (_id, title, body) => { readyCalls += 1; requested.status = "addressed"; requested.issue_state = "ready"; requested.issue_title = title; requested.issue_body = body; },
      failIssueDraft: async () => { throw new Error("must not fail"); },
      completeIssueDraft: async () => { throw new Error("must not create on GitHub"); },
    },
    annotations: { create: async () => { throw new Error("retry must not create a new annotation"); } },
  };
  let prompt = "";
  const runnerRegistry = {
    list: async () => [{ runner_id: "verified", name: "Verified", verified: true, profiles: ["text-only"] }],
    resolve: async (_runnerId: string, context: { prompt: string }) => { prompt = context.prompt; return { command: "ai", args: [] }; },
  };
  const processSupervisor = { run: () => {
    const nonce = prompt.match(/VISUAL_REVIEW_ISSUE_DRAFT_([a-f0-9-]+)_START/)?.[1];
    assert.ok(nonce);
    const markers = issueDraftMarkers(nonce);
    return { cancel() {}, result: Promise.resolve({ exitCode: 0, reason: "exit" as const, stdout: `${markers.start}\n${JSON.stringify({ title: "Retried title", body: "Retried body" })}\n${markers.end}` }) };
  } };
  const adapter = createIssueBridgeAdapter({ review, issueTask: createIssueTaskCapability(review), ai: aiFixture(runnerRegistry, processSupervisor) });

  const notReady = await adapter.command("issue.draft.retry", { request_id: "retry-not-requested", input: { annotation_id: "annotation-2" } }) as BridgeCommandResult;
  assert.equal(notReady.ok, false);
  if (!notReady.ok) assert.equal(notReady.error.code, "VALIDATION_FAILED");
  assert.equal(readyCalls, 0);

  const retried = await adapter.command("issue.draft.retry", { request_id: "retry", input: { annotation_id: "annotation-1" } }) as BridgeCommandResult;
  assert.equal(retried.ok, true);
  if (retried.ok) assert.deepEqual(retried.data, { annotation_id: "annotation-1", title: "Retried title", body: "Retried body" });
  assert.equal(readyCalls, 1);
  assert.equal(requested.issue_state, "ready");
});

test("stopping the Issue bridge prevents a late runner spawn", async () => {
  let releaseList!: () => void;
  const listGate = new Promise<void>((resolve) => { releaseList = resolve; });
  let runs = 0;
  const annotation: IssueProjectionAnnotationV1 = { id: "annotation-1", status: "open", comment: "見出しを改善", anchor: { kind: "dom", selector: "h1" }, issue_state: "requested" };
  const review: IssueReviewCapabilityV1 = {
    apiVersion: 1,
    store: { target: { projectRoot: "/workspace" }, load: async () => ({ annotations: [annotation] }), loadActive: async () => ({ annotations: [annotation] }), setIssueDraftReady: async () => ({}), failIssueDraft: async () => ({}), completeIssueDraft: async () => ({}) },
    annotations: { create: async () => ({ review: {}, annotation }) },
  };
  const adapter = createIssueBridgeAdapter({
    review,
    issueTask: createIssueTaskCapability(review),
    ai: aiFixture({
      list: async () => { await listGate; return [{ runner_id: "verified", name: "Verified", verified: true, profiles: ["text-only"] }]; },
      resolve: async () => ({ command: "ai", args: [] }),
    }, { run: () => { runs += 1; throw new Error("must not spawn"); } }),
  });
  const resultPromise = adapter.command("issue.draft", { request_id: "draft", input: { anchor: { kind: "dom", selector: "h1" }, request: "見出しを改善" } }) as Promise<BridgeCommandResult>;
  adapter.stop();
  releaseList();
  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(runs, 0);
});

test("standalone draft parser requires nonce framing and an exact safe object", () => {
  const nonce = "12345678-1234-1234-1234-123456789abc";
  const { start, end } = issueDraftMarkers(nonce);
  assert.deepEqual(extractStandaloneIssueDraft(`${start}\n{"title":"T","body":"B"}\n${end}`, nonce), { title: "T", body: "B" });
  assert.throws(() => extractStandaloneIssueDraft(`${start}\n{"title":"T","body":"B","extra":true}\n${end}`, nonce), /valid framed title\/body/);
  const framed = `${start}\n{"title":"T","body":"B"}\n${end}`;
  assert.deepEqual(extractStandaloneIssueDraft(JSON.stringify({ result: framed }), nonce), { title: "T", body: "B" });
  assert.throws(() => extractStandaloneIssueDraft(`${framed}\n${framed}`, nonce), /exactly one valid framed/);
  assert.throws(() => extractStandaloneIssueDraft(`${start}\n{"title":"T","body":"mentions .vreview"}\n${end}`, nonce), /internal review/);
  assert.throws(() => extractStandaloneIssueDraft("x".repeat(128 * 1024 + 1), nonce), /128 KiB/);
});

test("issue.create accepts only a generated draft, then persists and returns its target", async () => {
  const calls: IssueAnnotationCreateInputV1[] = [];
  const annotation: IssueProjectionAnnotationV1 = { id: "annotation-1", status: "open", comment: "見出しを改善", page_path: "/", anchor: { selector: "h1" }, created_at: "2026-01-01T00:00:00.000Z", issue_state: "requested" };
  const review: IssueReviewCapabilityV1 = {
    apiVersion: 1,
    store: {
      target: { projectRoot: "/workspace" },
      load: async () => ({ revision: 3, annotations: [annotation] }),
      loadActive: async () => ({ annotations: [annotation] }),
      setIssueDraftReady: async (_id, title, body) => { annotation.status = "addressed"; annotation.issue_state = "ready"; annotation.issue_title = title; annotation.issue_body = body; },
      failIssueDraft: async () => { throw new Error("must not fail"); },
      completeIssueDraft: async (_id, title, url) => { annotation.status = "resolved"; annotation.issue_state = "created"; annotation.issue_title = title; annotation.issue_url = url; },
    },
    annotations: { async create(input) { calls.push(input); return { review: {}, annotation }; } },
  };
  const task = createIssueTaskCapability(review, { provider: { createIssue: async () => ({ url: "https://github.com/o/r/issues/7" }) } });
  let prompt = "";
  const runnerRegistry = {
    list: async () => [{ runner_id: "verified", name: "Verified", verified: true, profiles: ["text-only"] }],
    resolve: async (_runnerId: string, context: { prompt: string }) => { prompt = context.prompt; return { command: "ai", args: [] }; },
  };
  const processSupervisor = { run: () => {
    const nonce = prompt.match(/VISUAL_REVIEW_ISSUE_DRAFT_([a-f0-9-]+)_START/)?.[1];
    assert.ok(nonce);
    const markers = issueDraftMarkers(nonce);
    return { cancel() {}, result: Promise.resolve({ exitCode: 0, reason: "exit" as const, stdout: `${markers.start}\n${JSON.stringify({ title: "Title", body: "Body" })}\n${markers.end}` }) };
  } };
  const provider = { createIssue: async () => { throw new Error("bridge draft must not create"); }, resolveTarget: async () => ({ repo: "o/r", account: "actor" }) };
  const invocations: Array<Record<string, unknown>> = [];
  const adapter = createIssueBridgeAdapter({ review, issueTask: task, ai: aiFixture(runnerRegistry, processSupervisor, invocations), provider });
  const rejected = await adapter.command("issue.create", { request_id: "direct", input: { title: "Title", body: "Body" } }) as BridgeCommandResult;
  assert.equal(rejected.ok, false);
  const generated = await adapter.command("issue.draft", { request_id: "draft", input: { anchor: { selector: "h1", kind: "dom" }, request: "見出しを改善" } }) as BridgeCommandResult;
  assert.equal(Object.hasOwn(invocations[0]!, "method_id"), false);
  assert.equal(generated.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls, [{ anchor: { selector: "h1", kind: "dom" }, comment: "見出しを改善", mode: "issue-request" }]);
  if (!generated.ok) return;
  assert.deepEqual(generated.data, { annotation_id: "annotation-1", title: "Title", body: "Body" });
  assert.equal(annotation.issue_state, "ready");
  const createInput = { annotation_id: generated.data.annotation_id, title: "Title", body: "Body" };
  const [result, duplicate] = await Promise.all([
    adapter.command("issue.create", { request_id: "create", input: createInput }),
    adapter.command("issue.create", { request_id: "duplicate", input: createInput }),
  ]) as BridgeCommandResult[];

  const expected = { ok: true, data: { annotation_id: "annotation-1", url: "https://github.com/o/r/issues/7" }, effects: [{ type: "resource.invalidate", resources: ["session", "issues", "history"] }] };
  assert.deepEqual(result, expected);
  assert.deepEqual(duplicate, expected);
  assert.equal(calls.length, 1);
  const listed = await adapter.query("issues.list", { request_id: "list", input: {} });
  assert.deepEqual(listed, {
    ok: true,
    revision: "review:3",
    data: {
      items: [{
        id: "annotation-1", request: "見出しを改善", title: "Title", body: "Body", url: "https://github.com/o/r/issues/7",
        page_path: "/", anchor: { selector: "h1" }, created_at: "2026-01-01T00:00:00.000Z",
        status_label: "解決済み", status_tone: "done", filter_id: "resolved",
      }],
      total: 1,
      latest_id: "annotation-1",
      filters: [
        { value: "creating", label: "作成中" },
        { value: "retry", label: "再作成" },
        { value: "drafted", label: "作成済み" },
        { value: "resolved", label: "解決済み" },
      ],
    },
  });
});

test("issue.create validates manual title, body, and anchor", async () => {
  const adapter = issueRequestFixture([]);
  for (const [input, requestId] of [
    [{ anchor: { selector: "h1" }, title: "", body: "Body" }, "empty-title"],
    [{ anchor: "h1", title: "Title", body: "Body" }, "anchor-not-object"],
  ] as Array<[Record<string, unknown>, string]>) {
    const result = await adapter.command("issue.create", { request_id: requestId, input }) as BridgeCommandResult;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "VALIDATION_FAILED");
  }
});

test("GitHub Issue exposes no AI selector or ai_method_id payload", async () => {
  const contract = readFileSync(path.join(process.cwd(), "plugins/github-issue/server.contract.json"), "utf8");
  const ui = ["header.ui.json", "sidebar.ui.json"].map((file) => readFileSync(path.join(process.cwd(), "plugins/github-issue/ui", file), "utf8")).join("\n");
  assert.doesNotMatch(contract, /ai_method_id|issue\.ai-methods/);
  assert.doesNotMatch(ui, /ai_method_id|ai-method|method_id/);

  const adapter = issueRequestFixture([], false);
  const result = await adapter.command("issue.draft", { request_id: "draft", input: {} }) as BridgeCommandResult;
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /disabled/);
});

test("undeclared bridge commands are rejected as NOT_FOUND", async () => {
  const adapter = issueRequestFixture([]);
  const result = await adapter.command("issue.missing", { request_id: "missing-command", input: {} }) as BridgeCommandResult;
  assert.deepEqual(result, {
    ok: false,
    error: { code: "NOT_FOUND", message: "command is not declared by the plugin", retryable: false, request_id: "missing-command" },
  });
});

test("issue-task capability's label() maps issue_state/status combinations to status badges", () => {
  const issueTask = issueTaskFixture();
  const annotation = (overrides: Partial<IssueProjectionAnnotationV1>): IssueProjectionAnnotationV1 => ({
    id: "annotation-1",
    status: "open",
    ...overrides,
  });

  assert.deepEqual(issueTask.label(annotation({ issue_state: "requested", status: "open" })), {
    text: "Issueラフ作成中", tone: "pending",
  });
  assert.deepEqual(issueTask.label(annotation({ issue_state: "requested", status: "in_progress" })), {
    text: "AI Issueラフ作成中", tone: "active",
  });
  assert.deepEqual(issueTask.label(annotation({ issue_state: "requested", status: "failed" })), {
    text: "Issueラフ作成失敗", tone: "failed",
  });
  assert.deepEqual(issueTask.label(annotation({ issue_state: "ready", status: "addressed" })), {
    text: "Issueラフ確認待ち", tone: "ready",
  });
  assert.deepEqual(issueTask.label(annotation({ issue_state: "created", status: "resolved", issue_url: "https://github.com/example/project/issues/1" })), {
    text: "Issue作成済み", tone: "done",
  });
});

test("issue-task capability's filter chips match the badges one-to-one", () => {
  const issueTask = issueTaskFixture();
  const annotation = (overrides: Partial<IssueProjectionAnnotationV1>): IssueProjectionAnnotationV1 => ({
    id: "annotation-1",
    status: "open",
    ...overrides,
  });
  const cases: Array<[Partial<IssueProjectionAnnotationV1>, string]> = [
    [{ issue_state: "requested", status: "open" }, "issue-requested"],
    [{ issue_state: "requested", status: "in_progress" }, "issue-drafting"],
    [{ issue_state: "requested", status: "failed" }, "issue-draft-failed"],
    [{ issue_state: "ready", status: "addressed" }, "issue-ready"],
    [{ issue_state: "created", status: "resolved" }, "issue-created"],
  ];

  const chips = issueTask.filters();
  assert.deepEqual(chips.map(({ id }) => id), cases.map(([, id]) => id));

  // Every badge an annotation can wear is also the label of the chip it is filtered by.
  for (const [overrides, expectedId] of cases) {
    const subject = annotation(overrides);
    assert.equal(issueTask.filter(subject), expectedId);
    assert.equal(issueTask.label(subject)?.text, chips.find(({ id }) => id === expectedId)?.label);
  }
});

test("issue-task capability's filter() returns null when no category applies", () => {
  const issueTask = issueTaskFixture();

  assert.equal(issueTask.filter({ id: "annotation-1", status: "open" }), null);
  assert.equal(issueTask.filter({ id: "annotation-1", status: "addressed", issue_state: "requested" }), null);
  assert.equal(issueTask.filter({} as unknown as IssueProjectionAnnotationV1), null);
});

test("issue-task capability's label() returns null when there is no meaningful badge", () => {
  const issueTask = issueTaskFixture();

  assert.equal(issueTask.label({ id: "annotation-1", status: "open" }), null);
  assert.equal(issueTask.label({ id: "annotation-1", status: "addressed", issue_state: "requested" }), null);
  assert.equal(issueTask.label({} as unknown as IssueProjectionAnnotationV1), null);
});
