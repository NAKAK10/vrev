import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installPlugin, loadPluginIssueProvider } from "../src/index.js";

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
