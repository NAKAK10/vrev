import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSpawnExecutor, parseCustomCommand, type CommandExecutor } from "./adapters.js";

const PROBE_MARKER = ".visual-review-command-test";
const PROBE_TOKEN = "VISUAL_REVIEW_OK";

export async function testCustomCommand(command: string, executor?: CommandExecutor): Promise<{ durationMs: number }> {
  const directory = mkdtempSync(path.join(os.tmpdir(), "visual-review-command-test-"));
  const startedAt = Date.now();
  const prompt = `This is a capability test. In the current working directory, create a file named ${PROBE_MARKER} containing exactly ${PROBE_TOKEN} using your file or shell tools. Then reply exactly ${PROBE_TOKEN}. Do not read or modify anything outside the current working directory.`;
  try {
    const parsed = parseCustomCommand(command, prompt);
    const run = (executor ?? createSpawnExecutor({ timeoutMs: 45_000, outputLimit: 64 * 1024 }))({
      command: parsed.command,
      args: parsed.args,
      cwd: directory,
      env: { ...process.env },
    });
    const result = await run.result;
    if (result.reason !== "exit" || result.exitCode !== 0) {
      throw new Error(result.reason === "timeout" ? "45秒以内に応答がありませんでした" : `command testが失敗しました（${result.reason}, exit ${result.exitCode ?? "unknown"}）`);
    }
    let marker = "";
    try { marker = readFileSync(path.join(directory, PROBE_MARKER), "utf8").trim(); } catch { /* reported below */ }
    if (marker !== PROBE_TOKEN || !result.output?.includes(PROBE_TOKEN)) {
      throw new Error("応答はありましたが、AI修正に必要なtoolによるファイル操作を確認できませんでした");
    }
    return { durationMs: Date.now() - startedAt };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
