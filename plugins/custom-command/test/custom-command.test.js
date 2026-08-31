import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CONFIG_RELATIVE_PATH,
  addCommand,
  createSpawnExecutor,
  customCommandProvider,
  handler,
  parseCommandTemplate,
  readConfig,
  removeCommand,
  runCommand,
  testCommand as probeCommand,
} from "../index.js";
import { createRunnerRegistryCapability } from "../server/index.js";

function workspace() {
  return mkdtempSync(path.join(os.tmpdir(), "visual-review-custom-command-"));
}

function quoted(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

test("manifest and package describe an installable standalone ESM command", () => {
  const root = new URL("..", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("visual-review.plugin.json", root), "utf8"));
  const packageJson = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  const settingsUi = readFileSync(new URL("ui/settings.ui.json", root), "utf8");
  assert.deepEqual(manifest.commands, [{ name: "custom-command", module: "./index.js", export: "handler" }]);
  assert.equal(manifest.custom_command_provider.export, "customCommandProvider");
  assert.equal(manifest.server.module, "./server/index.js");
  assert.deepEqual(manifest.provides, [{ capability: "runner-registry", api_version: 1 }]);
  assert.equal(manifest.schema_version, 4);
  assert.deepEqual(manifest.ui.contributions, [{ id: "custom-command-settings", slot: "settings.detail", document: "./ui/settings.ui.json", order: 200 }]);
  assert.equal(packageJson.files.includes("ui"), true);
  assert.equal(packageJson.files.includes("server"), true);
  assert.equal(packageJson.type, "module");
  assert.equal(packageJson.dependencies, undefined);
  assert.match(settingsUi, /テスト中.*最大2分|最大2分.*テスト/);
  assert.match(settingsUi, /"disable": "register-runner"/);
  assert.equal(typeof handler, "function");
});

test("runner-registry is the cross-plugin extension point consumed by annotation workflow", async () => {
  const root = workspace();
  const provider = {
    list: () => [
      { runner_id: "00000000-0000-4000-8000-000000000001", name: "ready", verified: true },
      { runner_id: "00000000-0000-4000-8000-000000000002", name: "pending", verified: false },
    ],
    resolve: () => ({ name: "ready", template: "agent --prompt {prompt}" }),
  };
  const registry = createRunnerRegistryCapability(root, provider);
  const unregister = registry.register("another-ai", {
    list: () => [{ runner_id: "third-party-runner", name: "Third Party" }],
    resolve: () => ({ command: "third-party", args: [] }),
  });
  assert.deepEqual(await registry.list(), [
    { runner_id: "00000000-0000-4000-8000-000000000001", name: "ready", provider_id: "custom-command", verified: true },
    { runner_id: "00000000-0000-4000-8000-000000000002", name: "pending", provider_id: "custom-command", verified: false },
    { runner_id: "third-party-runner", name: "Third Party", provider_id: "another-ai", verified: true },
  ]);
  assert.deepEqual(await registry.resolve("00000000-0000-4000-8000-000000000001", { workspaceRoot: root, prompt: "fix it" }), {
    command: "agent", args: ["--prompt", "fix it"], cwd: root, env: { ...process.env },
  });
  unregister();
  assert.equal((await registry.list()).some(({ provider_id }) => provider_id === "another-ai"), false);
  await assert.rejects(registry.resolve("id", { workspaceRoot: `${root}-other`, prompt: "x" }), /workspace/);
});

test("template parser requires exactly one prompt and treats shell syntax as ordinary arguments", () => {
  assert.throws(() => parseCommandTemplate("agent --prompt hello", "x"), /exactly once/);
  assert.throws(() => parseCommandTemplate("agent {prompt} {prompt}", "x"), /exactly once/);
  assert.throws(() => parseCommandTemplate("{prompt} --flag", "x"), /executable/);
  assert.throws(() => parseCommandTemplate("agent --api-key=literal {prompt}", "x"), /environment/);
  assert.deepEqual(parseCommandTemplate("agent --prompt '{prompt}' && touch owned", "hello world"), {
    command: "agent",
    args: ["--prompt", "hello world", "&&", "touch", "owned"],
  });
});

test("add, list, and remove use a validated private atomic config", async () => {
  const root = workspace();
  const probe = `require("node:fs").writeFileSync(".visual-review-command-test","VISUAL_REVIEW_OK");process.stdout.write("VISUAL_REVIEW_OK")`;
  await handler({ workspaceRoot: root, pluginDirectory: path.dirname(new URL(import.meta.url).pathname), args: ["add", "reviewer", quoted(process.execPath), "-e", quoted(probe), "{prompt}"] });
  const runnerIds = Object.keys(readConfig(root).commands);
  assert.equal(runnerIds.length, 1);
  assert.equal(readConfig(root).commands[runnerIds[0]].name, "reviewer");
  const configPath = path.join(root, CONFIG_RELATIVE_PATH);
  assert.equal(lstatSync(configPath).mode & 0o777, 0o600);
  const stored = readFileSync(configPath, "utf8");
  assert.doesNotMatch(stored, /api.?key|token|password/i);
  assert.throws(() => addCommand(root, "reviewer", "other {prompt}"), /already exists/);
  removeCommand(root, "reviewer");
  assert.deepEqual(Object.keys(readConfig(root).commands), []);
});

test("v1 entries migrate as unverified and config rejects symlinks and malformed records", async () => {
  const legacyRoot = workspace();
  mkdirSync(path.join(legacyRoot, ".vreview"));
  writeFileSync(path.join(legacyRoot, ".vreview/custom-commands.json"), JSON.stringify({ schema_version: 1, commands: { reviewer: { template: "agent {prompt}" } } }));
  const migrated = Object.values(readConfig(legacyRoot).commands);
  assert.equal(migrated[0].name, "reviewer");
  assert.equal(migrated[0].verified, false);
  assert.deepEqual(customCommandProvider.list(legacyRoot), []);
  assert.deepEqual(customCommandProvider.listPending(legacyRoot).map(({ name }) => name), ["reviewer"]);
  await assert.rejects(runCommand(legacyRoot, "reviewer", "prompt"), /capability test/);

  const malformedRoot = workspace();
  mkdirSync(path.join(malformedRoot, ".vreview"));
  writeFileSync(path.join(malformedRoot, ".vreview/custom-commands.json"), JSON.stringify({ schema_version: 1, commands: { BAD: { template: "agent {prompt}" } } }));
  assert.throws(() => readConfig(malformedRoot), /command name/);

  const linkedRoot = workspace();
  const outside = path.join(workspace(), "outside.json");
  mkdirSync(path.join(linkedRoot, ".vreview"));
  writeFileSync(outside, JSON.stringify({ schema_version: 1, commands: {} }));
  symlinkSync(outside, path.join(linkedRoot, ".vreview/custom-commands.json"));
  assert.throws(() => readConfig(linkedRoot), /regular file/);
});

test("spawn is shell-free, inherits env, and substitutes an untrusted prompt as one argument", async () => {
  const root = workspace();
  const marker = path.join(root, "shell-was-used");
  const script = "const fs=require('node:fs');const p=process.argv[1];if(p.includes('capability test')){fs.writeFileSync('.visual-review-command-test','VISUAL_REVIEW_OK');process.stdout.write('VISUAL_REVIEW_OK')}else process.stdout.write(p+'|'+process.env.CUSTOM_COMMAND_TEST_ENV+'\\n')";
  const template = `${quoted(process.execPath)} -e ${quoted(script)} {prompt}`;
  addCommand(root, "echo", template);
  process.env.CUSTOM_COMMAND_TEST_ENV = "from-env";
  let result;
  try {
    await probeCommand(root, "echo", { timeoutMs: 2_000 });
    result = await runCommand(root, "echo", `hello;touch ${marker}`);
  } finally {
    delete process.env.CUSTOM_COMMAND_TEST_ENV;
  }
  assert.equal(result.output, `hello;touch ${marker}|from-env\n`);
  assert.equal(existsSync(marker), false);
});

test("registration runs the capability test first and persists only successful commands", async () => {
  const root = workspace();
  const script = `require("node:fs").writeFileSync(".visual-review-command-test","VISUAL_REVIEW_OK");process.stdout.write("VISUAL_REVIEW_OK")`;
  const added = await customCommandProvider.add(root, "ready", `${quoted(process.execPath)} -e ${quoted(script)} {prompt}`);
  assert.equal(typeof added.runner_id, "string");
  assert.deepEqual(customCommandProvider.list(root).map(({ name, verified }) => ({ name, verified })), [{ name: "ready", verified: true }]);
  const before = readFileSync(path.join(root, CONFIG_RELATIVE_PATH), "utf8");
  await assert.rejects(customCommandProvider.add(root, "broken", `${quoted(process.execPath)} -e ${quoted("process.exit(2)")} {prompt}`), /テストに失敗/);
  await assert.rejects(customCommandProvider.add(root, "blocked", `${quoted(process.execPath)} -e ${quoted("process.stdout.write('file-write permission was not granted')")} {prompt}`), /permission-mode bypassPermissions/);
  assert.equal(readFileSync(path.join(root, CONFIG_RELATIVE_PATH), "utf8"), before);
});

test("capability test verifies output and a tool-created marker in an isolated directory", async () => {
  const root = workspace();
  const script = `require("node:fs").writeFileSync(".visual-review-command-test","VISUAL_REVIEW_OK");process.stdout.write("VISUAL_REVIEW_OK")`;
  addCommand(root, "probe", `${quoted(process.execPath)} -e ${quoted(script)} {prompt}`);
  const result = await probeCommand(root, "probe", { timeoutMs: 2_000 });
  assert.equal(typeof result.durationMs, "number");
});

test("executor enforces timeout and bounded captured output", async () => {
  const timeoutRun = createSpawnExecutor({ timeoutMs: 50, outputLimit: 1024, killGraceMs: 20 })({
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: workspace(),
    env: { ...process.env },
  });
  assert.equal((await timeoutRun.result).reason, "timeout");

  const outputRun = createSpawnExecutor({ timeoutMs: 2_000, outputLimit: 32, killGraceMs: 20 })({
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000)"],
    cwd: workspace(),
    env: { ...process.env },
  });
  const outputResult = await outputRun.result;
  assert.equal(outputResult.reason, "output-limit");
  assert.ok(Buffer.byteLength(outputResult.output) <= 32);
});

test("explicit cancellation terminates a running process", async () => {
  const running = createSpawnExecutor({ timeoutMs: 2_000, killGraceMs: 20 })({
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: workspace(),
    env: { ...process.env },
  });
  running.cancel();
  assert.equal((await running.result).reason, "cancelled");
});

test("POSIX timeout terminates the spawned process tree", { skip: process.platform === "win32" }, async () => {
  const root = workspace();
  const marker = path.join(root, "grandchild-survived");
  const grandchild = `setTimeout(()=>require("node:fs").writeFileSync(${JSON.stringify(marker)},"bad"),500);setInterval(()=>{},1000)`;
  const parent = `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(grandchild)}],{stdio:"ignore"});setInterval(()=>{},1000)`;
  const running = createSpawnExecutor({ timeoutMs: 150, outputLimit: 1024, killGraceMs: 30 })({
    command: process.execPath,
    args: ["-e", parent],
    cwd: root,
    env: { ...process.env },
  });
  assert.equal((await running.result).reason, "timeout");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(existsSync(marker), false);
});
