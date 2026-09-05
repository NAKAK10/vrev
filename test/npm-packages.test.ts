import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const featurePackages = new Map([
  ["plugins/review", "@vrev/review"],
  ["plugins/ai", "@vrev/ai"],
  ["plugins/firestore", "@vrev/storage-firestore"],
  ["plugins/annotation-workflow", "@vrev/annotation-workflow"],
  ["plugins/page-map", "@vrev/page-map"],
  ["plugins/github-issue", "@vrev/github-issue"],
]);
const packages = new Map([
  [".", "@vrev/cli"],
  ["packages/plugin-sdk", "@vrev/plugin-sdk"],
  ...featurePackages,
]);

test("the agreed package set targets public npm and feature packages expose package API v1 metadata", () => {
  for (const [directory, expectedName] of packages) {
    const packageJson = JSON.parse(readFileSync(path.join(root, directory, "package.json"), "utf8")) as {
      name: string;
      repository: { type: string; url: string; directory?: string };
      license: string;
      publishConfig?: { access?: string; registry?: string };
      bin?: Record<string, string>;
      vrev?: { apiVersion?: number; manifest?: string };
      dependencies?: Record<string, string>;
    };
    assert.equal(packageJson.name, expectedName);
    assert.equal(packageJson.repository.type, "git");
    assert.equal(packageJson.repository.url, "git+https://github.com/NAKAK10/vrev.git");
    if (directory !== ".") assert.equal(packageJson.repository.directory, directory);
    assert.equal(packageJson.license, "MIT");
    assert.equal(readFileSync(path.join(root, directory, "LICENSE"), "utf8"), readFileSync(path.join(root, "LICENSE"), "utf8"));
    assert.deepEqual(packageJson.publishConfig, { access: "public", registry: "https://registry.npmjs.org" });
    if (directory === ".") assert.deepEqual(packageJson.bin, { vrev: "dist/src/cli.js" });
    if (directory.startsWith("plugins/")) {
      assert.deepEqual(packageJson.vrev, { apiVersion: 1, manifest: "./vrev.plugin.json" });
      assert.equal(existsSync(path.join(root, directory, "vrev.plugin.json")), true);
      for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
        assert.equal([...featurePackages.values()].includes(dependency), false, `${expectedName} must not depend on feature package ${dependency}`);
      }
    }
  }
  assert.equal(featurePackages.size, 6);
  assert.deepEqual(
    readdirSync(path.join(root, "plugins"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(path.join(root, "plugins", entry.name, "package.json")))
      .map(({ name }) => name)
      .sort(),
    [...featurePackages.keys()].map((directory) => path.basename(directory)).sort(),
  );
  assert.equal(existsSync(path.join(root, "plugins/runner-local")), false);
  assert.equal(existsSync(path.join(root, "plugins/custom-command")), false);
});

test("release version lookup skips existing versions and fails closed on registry errors", async () => {
  const workflow = readFileSync(path.join(root, ".github/workflows/release-package.yml"), "utf8");
  const start = workflow.indexOf("const name = process.env.PACKAGE_NAME;");
  const end = workflow.indexOf("\n          NODE", start);
  assert.ok(start > 0 && end > start);
  const lookup = new Function("process", "fetch", "console", "AbortSignal", `return (async () => {${workflow.slice(start, end)}})()`);
  const output: string[] = [];
  const env = { env: { PACKAGE_NAME: "@vrev/cli", PACKAGE_VERSION: "1.0.0-beta" } };
  const run = (response: Response) => lookup(env, async (url: string) => {
    assert.equal(url, "https://registry.npmjs.org/%40vrev%2Fcli/1.0.0-beta");
    return response;
  }, { log: (value: string) => output.push(value) }, AbortSignal) as Promise<void>;
  await run(new Response(JSON.stringify({ name: "@vrev/cli", version: "1.0.0-beta" })));
  await run(new Response(null, { status: 404 }));
  assert.deepEqual(output, ["present", "missing"]);
  for (const status of [401, 403, 429, 500, 503]) {
    await assert.rejects(run(new Response(null, { status })), /Registry version lookup failed/);
  }
  await assert.rejects(run(new Response(JSON.stringify({ name: "wrong", version: "other" }))), /unexpected package metadata/);
  assert.deepEqual(output, ["present", "missing"], "errors must never be reported as missing versions");
});

test("AI feature packages consume the reusable ai/v1 capability", () => {
  const ai = readFileSync(path.join(root, "plugins/ai/server/index.js"), "utf8");
  const issue = readFileSync(path.join(root, "plugins/github-issue/server/index.js"), "utf8");
  const workflow = readFileSync(path.join(root, "plugins/annotation-workflow/server/job-manager.ts"), "utf8");
  assert.match(ai, /createAiCapability/);
  assert.match(issue, /AI_CAPABILITY_ID/);
  assert.match(workflow, /this\.ai\.invoke/);
  assert.doesNotMatch(issue, /host\.runner-registry|host\.process-supervisor/);
  assert.doesNotMatch(workflow, /runnerRegistry\.resolve/);
});

test("AI exports the local CLI and custom-command providers", () => {
  const registry = readFileSync(path.join(root, "src/runner-registry.ts"), "utf8");
  const ai = readFileSync(path.join(root, "plugins/ai/server/index.js"), "utf8");
  assert.doesNotMatch(registry, /opencode|claude|codex|copilot|createBuiltInRunnerProvider/);
  assert.match(ai, /export \* from "\.\/custom-command\.js"/);
  assert.match(ai, /export \* from "\.\/custom-command-runner\.js"/);
  assert.match(ai, /export \* from "\.\/local-runner\.js"/);
  assert.match(ai, /runnerRegistry\.register\("runner-local", createLocalRunnerProvider\(\)\)/);
  assert.match(ai, /runnerRegistry\.register\("custom-command", createCustomCommandRunnerProvider/);
});

test("release workflow publishes built feature artifacts to npm with OIDC provenance", () => {
  const workflow = readFileSync(path.join(root, ".github/workflows/release-package.yml"), "utf8");
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /node-version: 22/);
  assert.match(workflow, /npm install --global npm@11\.19\.1/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && inputs\.bootstrap/);
  assert.match(workflow, /secrets\.NPM_TOKEN/);
  assert.match(workflow, /npm whoami --registry https:\/\/registry\.npmjs\.org/);
  assert.doesNotMatch(workflow, /^\s+registry-url:/m, "avoid dummy credentials masking an OIDC exchange failure");
  assert.match(workflow, /--provenance/);
  assert.match(workflow, /data\.repository =/);
  assert.match(workflow, /git\+https:\/\/github\.com\/NAKAK10\/vrev\.git/);
  assert.match(workflow, /dist\/plugins\/ai/);
  assert.match(workflow, /dist\/plugins\/firestore/);
  assert.doesNotMatch(workflow, /dist\/plugins\/(?:runner-local|custom-command)/);
  assert.match(workflow, /packages\/plugin-sdk/);
  assert.doesNotMatch(workflow, /npm\.pkg\.github\.com|secrets\.GITHUB_TOKEN/);
});
