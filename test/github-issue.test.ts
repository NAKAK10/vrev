import assert from "node:assert/strict";
import test from "node:test";

import { normalizeGitHubIssueDraft } from "../src/github-issue.js";
import { buildBatchPrompt, extractIssueDraftOutput } from "../src/job-manager.js";

test("validates the human-editable GitHub Issue draft", () => {
  assert.deepEqual(normalizeGitHubIssueDraft({ title: " Title ", body: " Body " }), { title: "Title", body: "Body" });
  assert.throws(() => normalizeGitHubIssueDraft({ title: "", body: "Body" }), /title must be nonblank/);
  assert.throws(() => normalizeGitHubIssueDraft({ title: "Title", body: "" }), /body must be nonblank/);
});

test("the normal coordinator produces Issue drafts in the selected repository without creating GitHub Issues", () => {
  const prompt = buildBatchPrompt(".vrev/reviews/index/review.json", ["annotation-id"], 2, "dist/src/cli.js");
  assert.match(prompt, /issue_stateがあるIssue用annotation/);
  assert.match(prompt, /sourceを一切編集せず/);
  assert.match(prompt, /現在のworking directoryで対象repository/);
  assert.match(prompt, /画像に依存せずrepository相対path/);
  assert.match(prompt, /Issue単体を初めて読む実装者が背景と修正対象を理解/);
  assert.match(prompt, /annotation ID、review file path、\.vrev、Vrev注釈など内部review情報はtitle\/bodyへ書かず/);
  assert.match(prompt, /GitHub Issue自体は作成せず/);
  assert.match(prompt, /VISUAL_REVIEW_ISSUE_DRAFT_START/);
  assert.match(prompt, /VISUAL_REVIEW_ISSUE_DRAFT_END/);
  assert.match(prompt, /この出力をhostが保存/);
  assert.doesNotMatch(prompt, /set-issue-draft/);
});

test("extracts Issue drafts from plain custom CLI and JSON-wrapped CLI output", () => {
  const block = [
    "VISUAL_REVIEW_ISSUE_DRAFT_START",
    JSON.stringify({ annotation_id: "annotation-id", title: "Standalone title", body: "## Background\\nStandalone body" }),
    "VISUAL_REVIEW_ISSUE_DRAFT_END",
  ].join("\n");
  const expected = [{ annotationId: "annotation-id", title: "Standalone title", body: "## Background\\nStandalone body" }];
  assert.deepEqual(extractIssueDraftOutput(block), expected);
  assert.deepEqual(extractIssueDraftOutput(JSON.stringify({ result: block })), expected);
  assert.deepEqual(extractIssueDraftOutput(`${JSON.stringify({ type: "result", text: block })}\n`), expected);
  assert.deepEqual(extractIssueDraftOutput("unstructured response"), []);
});
