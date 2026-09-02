import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installPlugin, loadPluginIssueProvider } from "../src/index.js";
import {
  createIssueBridgeAdapter,
  createIssueTaskCapability,
  type IssueAnnotationCreateInputV1,
  type IssueProjectionAnnotationV1,
  type IssueReviewCapabilityV1,
  type IssueTaskCapabilityV1,
} from "../plugins/github-issue/server/index.js";

type BridgeCommandResult =
  | { ok: true; data: Record<string, unknown>; effects?: unknown[] }
  | { ok: false; error: { code: string; message: string; retryable: boolean; request_id: string } };

function issueRequestFixture(calls: IssueAnnotationCreateInputV1[]) {
  const review: IssueReviewCapabilityV1 = {
    apiVersion: 1,
    store: {
      target: { projectRoot: "/workspace" },
      load: () => ({ annotations: [] }),
      loadActive: () => ({ annotations: [] }),
      setIssueDraftReady: () => { throw new Error("not implemented"); },
      completeIssueDraft: () => { throw new Error("not implemented"); },
    },
    annotations: {
      create(input) {
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
    acceptCoordinatorOutput: () => [],
    state: () => "none",
    label: () => null,
    filters: () => [],
    filter: () => null,
    create: () => { throw new Error("not implemented"); },
  };
  return createIssueBridgeAdapter(review, issueTask);
}

function issueTaskFixture(): IssueTaskCapabilityV1 {
  const review: IssueReviewCapabilityV1 = {
    apiVersion: 1,
    store: {
      target: { projectRoot: "/workspace" },
      load: () => ({ annotations: [] }),
      loadActive: () => ({ annotations: [] }),
      setIssueDraftReady: () => { throw new Error("not implemented"); },
      completeIssueDraft: () => { throw new Error("not implemented"); },
    },
    annotations: {
      create: () => { throw new Error("not implemented"); },
    },
  };
  return createIssueTaskCapability(review);
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

test("issue.request creates an Issue request annotation through the review capability", async () => {
  const calls: IssueAnnotationCreateInputV1[] = [];
  const adapter = issueRequestFixture(calls);
  const result = await adapter.command("issue.request", {
    request_id: "issue-request-1",
    input: { anchor: { selector: "h1", kind: "dom" }, comment: "GitHub Issueにしてほしい" },
  }) as BridgeCommandResult;

  assert.deepEqual(result, {
    ok: true,
    data: { annotation_id: "annotation-1" },
    effects: [{ type: "resource.invalidate", resources: ["session", "annotations", "history"] }],
  });
  assert.deepEqual(calls, [{ anchor: { selector: "h1", kind: "dom" }, comment: "GitHub Issueにしてほしい", mode: "issue-request" }]);
});

test("issue.request maps invalid annotation input to a VALIDATION_FAILED envelope", async () => {
  const calls: IssueAnnotationCreateInputV1[] = [];
  const adapter = issueRequestFixture(calls);
  for (const [input, requestId] of [
    [{ anchor: { selector: "h1" }, comment: "" }, "empty-comment"],
    [{ anchor: "h1", comment: "見た目を整理して" }, "anchor-not-object"],
  ] as Array<[Record<string, unknown>, string]>) {
    const result = await adapter.command("issue.request", { request_id: requestId, input }) as BridgeCommandResult;
    assert.deepEqual(result, {
      ok: false,
      error: { code: "VALIDATION_FAILED", message: "annotation input is invalid", retryable: false, request_id: requestId },
    });
  }
  assert.equal(calls.length, 2);
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
