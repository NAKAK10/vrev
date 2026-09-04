import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export const CONFIG_RELATIVE_PATH = ".vrev/custom-commands.json";
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;

const CONFIG_VERSION = 2;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_TEMPLATE_LENGTH = 2_000;
const MAX_PROMPT_LENGTH = 256 * 1024;
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const RUNNER_ID_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f-]{27,}|legacy-[0-9a-f]{32})$/;
const PROBE_MARKER = ".vrev-command-test";
const PROBE_TOKEN = "VISUAL_REVIEW_OK";
const SECRET_OPTION_PATTERN = /^(?:--?)?(?:api[-_]?key|access[-_]?token|auth[-_]?token|password|secret)(?:=|$)/i;

function usage() {
  throw new Error("usage: custom-command add <name> <template> | list | remove <name> | test <name> | run <name> <prompt>");
}

function validateName(name) {
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new Error("command name must start with a lowercase letter and contain only lowercase letters, digits, and hyphens (max 63 characters)");
  }
  return name;
}

/** Parse a command line as data. This is deliberately not shell syntax. */
export function parseCommandTemplate(value, prompt) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEMPLATE_LENGTH || /[\0\r\n]/.test(value)) {
    throw new Error("command template must be a single nonblank line up to 2000 characters");
  }
  if ((value.match(/\{prompt\}/g) ?? []).length !== 1) {
    throw new Error("command template must include {prompt} exactly once");
  }

  const parts = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const character of value.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (escaped || quote !== null) throw new Error("command template contains an unfinished escape or quote");
  if (current) parts.push(current);
  if (parts.length === 0) throw new Error("command template must include an executable");
  if (parts[0].includes("{prompt}")) throw new Error("{prompt} must be in an argument, not the executable");
  if (parts.some((part) => SECRET_OPTION_PATTERN.test(part))) {
    throw new Error("credentials must not be stored in a command template; provide them through the environment");
  }

  const command = parts.shift();
  const args = parts.map((part) => part.replace("{prompt}", prompt));
  return { command, args };
}

function emptyConfig() {
  return { schema_version: CONFIG_VERSION, commands: Object.create(null) };
}

function storagePaths(workspaceRoot, createDirectory = false) {
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)) throw new Error("workspaceRoot must be an absolute path");
  const directory = path.join(workspaceRoot, ".vrev");
  if (existsSync(directory)) {
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(".vrev must be a real directory, not a symbolic link");
  } else if (createDirectory) {
    mkdirSync(directory, { mode: 0o700 });
  }
  return {
    directory,
    config: path.join(directory, "custom-commands.json"),
    lock: path.join(directory, "custom-commands.json.lock"),
  };
}

function assertRegularFile(file) {
  const info = lstatSync(file);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${CONFIG_RELATIVE_PATH} must be a regular file`);
  if (info.size > MAX_CONFIG_BYTES) throw new Error(`${CONFIG_RELATIVE_PATH} exceeds ${MAX_CONFIG_BYTES} bytes`);
}

function normalizeConfig(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("custom command config must be an object");
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("schema_version") || !keys.includes("commands") || ![1, CONFIG_VERSION].includes(value.schema_version)) {
    throw new Error("custom command config has an unsupported schema");
  }
  if (typeof value.commands !== "object" || value.commands === null || Array.isArray(value.commands)) {
    throw new Error("custom command config commands must be an object");
  }
  const commands = Object.create(null);
  for (const [key, record] of Object.entries(value.commands)) {
    if (typeof record !== "object" || record === null || Array.isArray(record) || typeof record.template !== "string") throw new Error(`custom command ${key} is invalid`);
    parseCommandTemplate(record.template, "validation");
    if (value.schema_version === 1) {
      validateName(key);
      const runnerId = `legacy-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
      commands[runnerId] = { name: key, template: record.template, verified: false, probe_ms: null, verified_at: null };
      continue;
    }
    if (!RUNNER_ID_PATTERN.test(key) || Object.keys(record).some((field) => !["name", "template", "verified", "probe_ms", "verified_at"].includes(field))
      || typeof record.name !== "string" || !record.name.trim() || record.name.length > 80 || typeof record.verified !== "boolean"
      || (record.probe_ms !== null && (!Number.isFinite(record.probe_ms) || record.probe_ms < 0))
      || (record.verified_at !== null && typeof record.verified_at !== "string")) throw new Error(`custom command ${key} is invalid`);
    commands[key] = { name: record.name, template: record.template, verified: record.verified, probe_ms: record.probe_ms, verified_at: record.verified_at };
  }
  return { schema_version: CONFIG_VERSION, commands };
}

export function readConfig(workspaceRoot) {
  const { config } = storagePaths(workspaceRoot);
  if (!existsSync(config)) return emptyConfig();
  assertRegularFile(config);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(config, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${CONFIG_RELATIVE_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizeConfig(parsed);
}

function withConfigLock(workspaceRoot, update) {
  const paths = storagePaths(workspaceRoot, true);
  let descriptor;
  try {
    descriptor = openSync(paths.lock, "wx", 0o600);
    writeFileSync(descriptor, `${process.pid}\n`);
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
      try { unlinkSync(paths.lock); } catch { /* preserve the original error */ }
    }
    if (error && error.code === "EEXIST") throw new Error("custom command config is busy; retry the operation");
    throw error;
  }
  closeSync(descriptor);
  try {
    const config = readConfig(workspaceRoot);
    update(config.commands);
    const temporary = path.join(paths.directory, `.custom-commands-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temporary, paths.config);
    } finally {
      rmSync(temporary, { force: true });
    }
  } finally {
    try { unlinkSync(paths.lock); } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  }
}

function findRunner(commands, idOrName) {
  if (Object.hasOwn(commands, idOrName)) return idOrName;
  return Object.keys(commands).find((id) => commands[id].name === idOrName);
}

export function addCommand(workspaceRoot, name, template) {
  if (typeof name !== "string" || !name.trim() || name.length > 80) throw new Error("command name must be 1 to 80 characters");
  parseCommandTemplate(template, "validation");
  const runnerId = randomUUID();
  withConfigLock(workspaceRoot, (commands) => {
    if (Object.values(commands).some((record) => record.name === name)) throw new Error(`custom command already exists: ${name}`);
    commands[runnerId] = { name, template, verified: false, probe_ms: null, verified_at: null };
  });
  return runnerId;
}

export async function testAndAddCommand(workspaceRoot, name, template, limits = {}) {
  if (typeof name !== "string" || !name.trim() || name.length > 80) throw new Error("command name must be 1 to 80 characters");
  parseCommandTemplate(template, "validation");
  const existing = Object.values(readConfig(workspaceRoot).commands).find((record) => record.name === name);
  if (existing?.verified) throw new Error(`custom command already exists: ${name}`);
  const { durationMs } = await probeTemplate(template, limits);
  const runnerId = randomUUID();
  withConfigLock(workspaceRoot, (commands) => {
    const duplicates = Object.entries(commands).filter(([, record]) => record.name === name);
    if (duplicates.some(([, record]) => record.verified)) throw new Error(`custom command already exists: ${name}`);
    for (const [id] of duplicates) delete commands[id];
    commands[runnerId] = { name, template, verified: true, probe_ms: durationMs, verified_at: new Date().toISOString() };
  });
  return { runnerId, durationMs };
}

export function removeCommand(workspaceRoot, idOrName) {
  withConfigLock(workspaceRoot, (commands) => {
    const runnerId = findRunner(commands, idOrName);
    if (!runnerId) throw new Error(`custom command does not exist: ${idOrName}`);
    delete commands[runnerId];
  });
}

export function createSpawnExecutor(options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outputLimit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
  const killGraceMs = options.killGraceMs ?? 2_000;
  const spawnProcess = options.spawnProcess ?? spawn;
  const platform = options.platform ?? process.platform;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(outputLimit) || outputLimit <= 0) {
    throw new Error("timeout and output limit must be positive integers");
  }

  return (spec) => {
    let child;
    let requestedReason;
    let settled = false;
    let outputBytes = 0;
    const outputChunks = [];
    let killTimer;
    let timeoutTimer;
    let resolveResult;
    const result = new Promise((resolve) => { resolveResult = resolve; });

    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolveResult({ ...value, output: Buffer.concat(outputChunks).toString("utf8") });
    };
    const signalTree = (signal) => {
      if (child?.pid === undefined) return;
      if (platform === "win32") {
        const killer = spawnProcess("taskkill", ["/pid", String(child.pid), "/t", ...(signal === "SIGKILL" ? ["/f"] : [])], {
          shell: false,
          stdio: "ignore",
        });
        killer.on?.("error", () => undefined);
        killer.unref?.();
      } else {
        try { process.kill(-child.pid, signal); } catch (error) {
          if (!error || error.code !== "ESRCH") return;
        }
      }
    };
    const terminate = (reason) => {
      if (settled || requestedReason) return;
      requestedReason = reason;
      signalTree("SIGTERM");
      killTimer = setTimeout(() => signalTree("SIGKILL"), killGraceMs);
      killTimer.unref();
    };

    try {
      child = spawnProcess(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        detached: platform !== "win32",
      });
    } catch {
      finish({ exitCode: null, reason: "spawn-error" });
      return { result, cancel() {} };
    }
    const collect = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, outputLimit - outputBytes);
      if (remaining > 0) outputChunks.push(buffer.subarray(0, remaining));
      outputBytes += buffer.byteLength;
      if (outputBytes > outputLimit) terminate("output-limit");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", () => finish({ exitCode: null, reason: requestedReason ?? "spawn-error" }));
    child.once("close", (code) => finish({ exitCode: code, reason: requestedReason ?? "exit" }));
    timeoutTimer = setTimeout(() => terminate("timeout"), timeoutMs);
    timeoutTimer.unref();
    return { result, cancel: () => terminate("cancelled") };
  };
}

async function execute(template, prompt, cwd, limits) {
  if (typeof prompt !== "string" || !prompt.trim() || Buffer.byteLength(prompt) > MAX_PROMPT_LENGTH) {
    throw new Error("prompt must be nonblank and no larger than 256 KiB");
  }
  const parsed = parseCommandTemplate(template, prompt);
  const running = createSpawnExecutor(limits)({ ...parsed, cwd, env: { ...process.env } });
  const cancel = () => running.cancel();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    return await running.result;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

function commandRecord(workspaceRoot, idOrName) {
  const commands = readConfig(workspaceRoot).commands;
  const runnerId = findRunner(commands, idOrName);
  if (!runnerId) throw new Error(`custom command does not exist: ${idOrName}`);
  return { runnerId, record: commands[runnerId] };
}

export async function runCommand(workspaceRoot, name, prompt, limits) {
  const { record } = commandRecord(workspaceRoot, name);
  if (!record.verified) throw new Error("custom command has not passed its capability test");
  const result = await execute(record.template, prompt, workspaceRoot, limits);
  if (result.output) process.stdout.write(result.output);
  if (result.reason !== "exit" || result.exitCode !== 0) {
    throw new Error(`custom command failed (${result.reason}, exit ${result.exitCode ?? "unknown"})`);
  }
  return result;
}

async function probeTemplate(template, limits = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "vrev-command-test-"));
  const prompt = `This is a capability test. In the current working directory, create a file named ${PROBE_MARKER} containing exactly ${PROBE_TOKEN} using your file or shell tools. Then reply exactly ${PROBE_TOKEN}. Do not read or modify anything outside the current working directory.`;
  const startedAt = Date.now();
  try {
    const result = await execute(template, prompt, directory, {
      timeoutMs: 120_000,
      outputLimit: 64 * 1024,
      ...limits,
    });
    if (result.reason !== "exit" || result.exitCode !== 0) {
      throw new Error(result.reason === "timeout" ? "コマンドのテストが2分以内に完了しませんでした。コマンドを直接実行できるか確認してください。" : `コマンドのテストに失敗しました（${result.reason}, exit ${result.exitCode ?? "unknown"}）`);
    }
    let marker = "";
    try {
      const markerPath = path.join(directory, PROBE_MARKER);
      if (lstatSync(markerPath).isFile() && !lstatSync(markerPath).isSymbolicLink()) marker = readFileSync(markerPath, "utf8").trim();
    } catch { /* reported below */ }
    if (marker !== PROBE_TOKEN || !result.output.includes(PROBE_TOKEN)) {
      if (/permission|not granted|blocked by the sandbox|requires approval/i.test(result.output)) {
        throw new Error("コマンドは応答しましたが、ファイル操作が許可されていません。Claude CLIの場合は `-- --permission-mode bypassPermissions -p {prompt}` のように権限モードを指定してください。");
      }
      throw new Error("コマンドは応答しましたが、ファイル操作を確認できませんでした。コマンドが作業ディレクトリ内のファイルを変更できる設定か確認してください。");
    }
    return { durationMs: Date.now() - startedAt };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function testCommand(workspaceRoot, name, limits = {}) {
  const { runnerId, record: initial } = commandRecord(workspaceRoot, name);
  const template = initial.template;
  withConfigLock(workspaceRoot, (commands) => {
    const record = commands[runnerId];
    if (!record || record.template !== template) throw new Error(`custom command changed before its test: ${name}`);
    record.verified = false;
    record.probe_ms = null;
    record.verified_at = null;
  });
  const { durationMs } = await probeTemplate(template, limits);
  withConfigLock(workspaceRoot, (commands) => {
    const record = commands[runnerId];
    if (!record || record.template !== template) throw new Error(`custom command changed during its test: ${name}`);
    record.verified = true;
    record.probe_ms = durationMs;
    record.verified_at = new Date().toISOString();
  });
  return { durationMs };
}

export const customCommandProvider = Object.freeze({
  apiVersion: 1,
  list(workspaceRoot) {
    return Object.entries(readConfig(workspaceRoot).commands)
      .filter(([, record]) => record.verified)
      .map(([runner_id, record]) => ({ runner_id, name: record.name, verified: true, probe_ms: record.probe_ms }))
      .sort((left, right) => left.name.localeCompare(right.name));
  },
  listPending(workspaceRoot) {
    return Object.entries(readConfig(workspaceRoot).commands)
      .filter(([, record]) => !record.verified)
      .map(([runner_id, record]) => ({ runner_id, name: record.name }))
      .sort((left, right) => left.name.localeCompare(right.name));
  },
  async add(workspaceRoot, name, template) {
    const result = await testAndAddCommand(workspaceRoot, name, template);
    return { runner_id: result.runnerId, duration_ms: result.durationMs };
  },
  remove(workspaceRoot, runnerId) { removeCommand(workspaceRoot, runnerId); },
  async test(workspaceRoot, runnerId) {
    const result = await testCommand(workspaceRoot, runnerId);
    return { duration_ms: result.durationMs };
  },
  resolve(workspaceRoot, runnerId) {
    const { record } = commandRecord(workspaceRoot, runnerId);
    if (!record.verified) throw new Error("custom command has not passed its capability test");
    return { name: record.name, template: record.template };
  },
});

function bridgeError(request, code, message) {
  return { ok: false, error: { code, message, retryable: false, request_id: request.request_id } };
}

/** Plugin-owned bridge projection; raw templates never leave this provider. */
export function createCustomCommandBridgeAdapter(workspaceRoot, providerSource = customCommandProvider) {
  const loadProvider = async () => typeof providerSource === "function" ? providerSource() : providerSource;
  return Object.freeze({
    async query(name, request) {
      if (name === "runners.list") {
        const provider = await loadProvider();
        return { ok: true, data: {
          runners: provider.list(workspaceRoot).map((runner) => ({ runner_id: runner.runner_id, name: runner.name, verified: runner.verified, ...(typeof runner.probe_ms === "number" ? { probe_ms: runner.probe_ms } : {}), status_label: "登録済み" })),
          candidates: (provider.listPending?.(workspaceRoot) ?? []).map((runner) => ({ runner_id: runner.runner_id, name: runner.name, status_label: "登録候補" })),
        } };
      }
      return bridgeError(request, "NOT_FOUND", "query is not declared by the plugin");
    },
    async command(name, request) {
      const input = request.input;
      const provider = await loadProvider();
      if (name === "runner.add" && typeof input.name === "string" && typeof input.command === "string") {
        return { ok: true, data: await provider.add(workspaceRoot, input.name, input.command), effects: [{ type: "resource.invalidate", resources: ["runners", "ai-settings"] }] };
      }
      if (name === "runner.test" && typeof input.runner_id === "string") {
        return { ok: true, data: await provider.test(workspaceRoot, input.runner_id), effects: [{ type: "resource.invalidate", resources: ["runners", "ai-settings"] }] };
      }
      if (name === "runner.delete" && typeof input.runner_id === "string") {
        provider.remove(workspaceRoot, input.runner_id);
        return { ok: true, data: {}, effects: [{ type: "resource.invalidate", resources: ["runners", "ai-settings"] }] };
      }
      return bridgeError(request, "NOT_FOUND", "command is not declared by the plugin");
    },
  });
}

/** @param {{workspaceRoot: string, pluginDirectory: string, args: readonly string[]}} context */
export async function handler(context) {
  const [subcommand, ...args] = context.args;
  if (subcommand === "add" && args.length >= 2) {
    const [name, ...templateParts] = args;
    const result = await testAndAddCommand(context.workspaceRoot, name, templateParts.join(" "));
    console.log(`Test passed and added ${name} (${result.durationMs} ms)`);
    return;
  }
  if (subcommand === "list" && args.length === 0) {
    const entries = customCommandProvider.list(context.workspaceRoot);
    if (entries.length === 0) console.log("No custom commands configured.");
    else for (const entry of entries) console.log(`${entry.runner_id}\t${entry.name}\t${entry.verified ? "verified" : "unverified"}`);
    return;
  }
  if (subcommand === "remove" && args.length === 1) {
    removeCommand(context.workspaceRoot, args[0]);
    console.log(`Removed ${args[0]}`);
    return;
  }
  if (subcommand === "test" && args.length === 1) {
    const result = await testCommand(context.workspaceRoot, args[0]);
    console.log(`Command test passed (${result.durationMs} ms)`);
    return;
  }
  if (subcommand === "run" && args.length >= 2) {
    const [name, ...promptParts] = args;
    await runCommand(context.workspaceRoot, name, promptParts.join(" "));
    return;
  }
  usage();
}

export default handler;
