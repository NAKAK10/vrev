import assert from "node:assert/strict";
import test from "node:test";
import { createLocalRunnerProvider } from "../server/local-runner.js";

test("AI owns built-in local CLI adapters", () => {
  const provider = createLocalRunnerProvider();
  assert.deepEqual(provider.list().map(({ runner_id }) => runner_id), ["opencode", "claude", "codex", "copilot", "pi"]);
  assert.deepEqual(provider.resolve("pi", { workspaceRoot: "/repo", prompt: "fix", options: {} }).args, ["--print", "--no-session", "--approve", "--", "fix"]);
  assert.deepEqual(provider.resolve("claude", { workspaceRoot: "/repo", prompt: "draft", options: { profile: "text-only" } }).args, ["-p", "--output-format", "json", "--safe-mode", "--strict-mcp-config", "--permission-mode", "plan", "--tools=", "draft"]);
});
