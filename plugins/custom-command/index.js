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
import { randomBytes } from "node:crypto";

export const CONFIG_RELATIVE_PATH = ".vreview/custom-commands.json";
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;

const CONFIG_VERSION = 1;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_TEMPLATE_LENGTH = 2_000;
const MAX_PROMPT_LENGTH = 256 * 1024;
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const PROBE_MARKER = ".visual-review-command-test";
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
  const directory = path.join(workspaceRoot, ".vreview");
  if (existsSync(directory)) {
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(".vreview must be a real directory, not a symbolic link");
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
  if (keys.length !== 2 || !keys.includes("schema_version") || !keys.includes("commands") || value.schema_version !== CONFIG_VERSION) {
    throw new Error("custom command config has an unsupported schema");
  }
  if (typeof value.commands !== "object" || value.commands === null || Array.isArray(value.commands)) {
    throw new Error("custom command config commands must be an object");
  }
  const commands = Object.create(null);
  for (const [name, record] of Object.entries(value.commands)) {
    validateName(name);
    if (typeof record !== "object" || record === null || Array.isArray(record) || Object.keys(record).length !== 1 || typeof record.template !== "string") {
      throw new Error(`custom command ${name} is invalid`);
    }
    parseCommandTemplate(record.template, "validation");
    commands[name] = { template: record.template };
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

export function addCommand(workspaceRoot, name, template) {
  validateName(name);
  parseCommandTemplate(template, "validation");
  withConfigLock(workspaceRoot, (commands) => {
    if (Object.hasOwn(commands, name)) throw new Error(`custom command already exists: ${name}`);
    commands[name] = { template };
  });
}

export function removeCommand(workspaceRoot, name) {
  validateName(name);
  withConfigLock(workspaceRoot, (commands) => {
    if (!Object.hasOwn(commands, name)) throw new Error(`custom command does not exist: ${name}`);
    delete commands[name];
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

function commandTemplate(workspaceRoot, name) {
  validateName(name);
  const record = readConfig(workspaceRoot).commands[name];
  if (!record) throw new Error(`custom command does not exist: ${name}`);
  return record.template;
}

export async function runCommand(workspaceRoot, name, prompt, limits) {
  const result = await execute(commandTemplate(workspaceRoot, name), prompt, workspaceRoot, limits);
  if (result.output) process.stdout.write(result.output);
  if (result.reason !== "exit" || result.exitCode !== 0) {
    throw new Error(`custom command failed (${result.reason}, exit ${result.exitCode ?? "unknown"})`);
  }
  return result;
}

export async function testCommand(workspaceRoot, name, limits = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "visual-review-command-test-"));
  const prompt = `This is a capability test. In the current working directory, create a file named ${PROBE_MARKER} containing exactly ${PROBE_TOKEN} using your file or shell tools. Then reply exactly ${PROBE_TOKEN}. Do not read or modify anything outside the current working directory.`;
  const startedAt = Date.now();
  try {
    const result = await execute(commandTemplate(workspaceRoot, name), prompt, directory, {
      timeoutMs: 45_000,
      outputLimit: 64 * 1024,
      ...limits,
    });
    if (result.reason !== "exit" || result.exitCode !== 0) {
      throw new Error(result.reason === "timeout" ? "command did not respond within 45 seconds" : `command test failed (${result.reason}, exit ${result.exitCode ?? "unknown"})`);
    }
    let marker = "";
    try {
      const markerPath = path.join(directory, PROBE_MARKER);
      if (lstatSync(markerPath).isFile() && !lstatSync(markerPath).isSymbolicLink()) marker = readFileSync(markerPath, "utf8").trim();
    } catch { /* reported below */ }
    if (marker !== PROBE_TOKEN || !result.output.includes(PROBE_TOKEN)) {
      throw new Error("the command responded, but its file-tool capability could not be verified");
    }
    return { durationMs: Date.now() - startedAt };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** @param {{workspaceRoot: string, pluginDirectory: string, args: readonly string[]}} context */
export async function handler(context) {
  const [subcommand, ...args] = context.args;
  if (subcommand === "add" && args.length >= 2) {
    const [name, ...templateParts] = args;
    addCommand(context.workspaceRoot, name, templateParts.join(" "));
    console.log(`Added ${name}`);
    return;
  }
  if (subcommand === "list" && args.length === 0) {
    const entries = Object.entries(readConfig(context.workspaceRoot).commands).sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) console.log("No custom commands configured.");
    else for (const [name, record] of entries) console.log(`${name}\t${record.template}`);
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
