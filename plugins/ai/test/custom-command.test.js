import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { addCommand, customCommandProvider, parseCommandTemplate, readConfig, removeCommand } from "../server/custom-command.js";
import { createCustomCommandRunnerProvider } from "../server/custom-command-runner.js";

function workspace() { return mkdtempSync(path.join(os.tmpdir(), "visual-review-ai-command-")); }

test("AI owns shell-free external command parsing", () => {
  assert.deepEqual(parseCommandTemplate('agent --message "{prompt}"', "hello world"), { command: "agent", args: ["--message", "hello world"] });
  assert.throws(() => parseCommandTemplate("agent --message", "hello"), /\{prompt\} exactly once/);
  assert.throws(() => parseCommandTemplate("agent --api-key=secret {prompt}", "hello"), /credentials/);
});

test("AI stores external commands privately and resolves only verified entries", async () => {
  const root = workspace();
  const id = addCommand(root, "local model", "agent {prompt}");
  assert.equal(readConfig(root).commands[id].verified, false);
  assert.deepEqual(customCommandProvider.list(root), []);
  assert.equal(readFileSync(path.join(root, ".vreview/custom-commands.json"), "utf8").includes("agent {prompt}"), true);
  removeCommand(root, id);
  assert.deepEqual(Object.keys(readConfig(root).commands), []);
});

test("AI custom-command runner never exposes templates in its method list", async () => {
  const root = workspace();
  const provider = {
    list: () => [{ runner_id: "opaque", name: "Private model", verified: true }],
    resolve: () => ({ name: "Private model", template: "agent {prompt}" }),
  };
  const runner = createCustomCommandRunnerProvider(root, provider);
  assert.deepEqual(await runner.list({ workspaceRoot: root }), [{ runner_id: "opaque", name: "Private model", verified: true, integration_kind: "external-command" }]);
  assert.deepEqual(await runner.resolve("opaque", { workspaceRoot: root, prompt: "fix", options: {} }), { command: "agent", args: ["fix"], cwd: root, env: { ...process.env } });
});
