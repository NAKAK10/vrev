import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parsePluginSource, validateSourceSyntax } from "../src/index.js";

function workspace(): string {
  return mkdtempSync(path.join(os.tmpdir(), "vrev-plugin-source-"));
}

test("classifies an existing local directory by relative and absolute prefixes", () => {
  const root = workspace();
  const nested = path.join(root, "plugins", "example");
  mkdirSync(nested, { recursive: true });
  assert.deepEqual(parsePluginSource("./plugins/example", root), { kind: "local", path: nested });
  assert.deepEqual(parsePluginSource(nested, root), { kind: "local", path: nested });
  assert.deepEqual(parsePluginSource("plugins/example", root), { kind: "local", path: nested });
});

test("classifies a home-relative source and expands it against the home directory", () => {
  const home = os.homedir();
  const candidate = path.join(home, ".vrev-plugin-source-test-fixture");
  mkdirSync(candidate, { recursive: true });
  try {
    const parsed = parsePluginSource("~/.vrev-plugin-source-test-fixture", workspace());
    assert.deepEqual(parsed, { kind: "local", path: candidate });
  } finally {
    rmSync(candidate, { recursive: true, force: true });
  }
});

test("rejects a local-looking path that does not exist without falling back to npm", () => {
  const root = workspace();
  assert.throws(() => parsePluginSource("./missing", root), /local plugin path does not exist/);
  assert.throws(() => parsePluginSource("/definitely/not/on/disk/plugin", root), /local plugin path does not exist/);
});

test("classifies GitHub shorthand owner/repo specs and requires a pinned ref", () => {
  const root = workspace();
  assert.throws(() => parsePluginSource("owner/repo", root), /must pin a tag or commit SHA/);
  assert.deepEqual(parsePluginSource("owner/repo#v1", root), { kind: "git", spec: "owner/repo#v1", host: "github", ref: "v1", pinned: true, warnings: [] });
});

test("rejects unpinned scheme-prefixed git sources and accepts pinned ones", () => {
  const root = workspace();
  assert.throws(() => parsePluginSource("github:owner/repo", root), /must pin a tag or commit SHA/);
  const sha = "a".repeat(40);
  assert.deepEqual(parsePluginSource(`github:owner/repo#${sha}`, root), { kind: "git", spec: `github:owner/repo#${sha}`, host: "github", ref: sha, pinned: true, warnings: [] });
  assert.deepEqual(
    parsePluginSource(`git+https://github.com/owner/repo.git#${sha}`, root),
    { kind: "git", spec: `git+https://github.com/owner/repo.git#${sha}`, host: "github", ref: sha, pinned: true, warnings: [] },
  );
  assert.deepEqual(
    parsePluginSource("https://gitlab.com/owner/repo#v2.0.0", root),
    { kind: "git", spec: "https://gitlab.com/owner/repo#v2.0.0", host: "gitlab", ref: "v2.0.0", pinned: true, warnings: [] },
  );
});

test("parses scoped and unscoped npm specs, flagging unpinned ranges", () => {
  const root = workspace();
  assert.deepEqual(parsePluginSource("@scope/pkg@1.2.3", root), { kind: "npm", spec: "@scope/pkg@1.2.3", name: "@scope/pkg", range: "1.2.3", pinned: true });
  assert.deepEqual(parsePluginSource("pkg", root), { kind: "npm", spec: "pkg", name: "pkg", range: null, pinned: false });
  assert.deepEqual(parsePluginSource("pkg@^1.0.0", root), { kind: "npm", spec: "pkg@^1.0.0", name: "pkg", range: "^1.0.0", pinned: false });
  assert.deepEqual(parsePluginSource("@scope/pkg", root), { kind: "npm", spec: "@scope/pkg", name: "@scope/pkg", range: null, pinned: false });
});

test("rejects credentials in a URL source regardless of resulting kind", () => {
  const root = workspace();
  const credentialedUrl = ["https://", "user", ":", "pw", "@github.com/owner/repo.git#abc"].join("");
  assert.throws(() => parsePluginSource(credentialedUrl, root), /credentials/);
  const credentialedQuery = "https://example.com/plugin.tgz?access_token=placeholder";
  assert.throws(() => parsePluginSource(credentialedQuery, root), /credential parameters/);
});

test("validateSourceSyntax rejects blank and control-character sources", () => {
  assert.throws(() => validateSourceSyntax(""), /nonblank/);
  assert.throws(() => validateSourceSyntax("  pkg"), /nonblank/);
  assert.throws(() => validateSourceSyntax("pkg\u0000"), /control characters/);
});
