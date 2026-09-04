import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const sleepBuffer = new SharedArrayBuffer(4);

export function fileSha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
}

export interface AtomicWriteJsonOptions {
  mode?: number;
  dirMode?: number;
}

export function atomicWriteJson(filePath: string, data: unknown, options: AtomicWriteJsonOptions = {}): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: options.dirMode ?? 0o777 });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", options.mode ?? 0o600);
    writeFileSync(descriptor, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, filePath);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
}

function tryClaimLock(lockPath: string, token: string, staleMs: number): boolean {
  try {
    writeFileSync(lockPath, `${JSON.stringify({ token, pid: process.pid })}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > staleMs) unlinkSync(lockPath);
    } catch (inspectionError) {
      if ((inspectionError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw inspectionError;
      }
    }
    return false;
  }
}

function acquireFileLock(lockPath: string, token: string, timeoutMs: number, staleMs: number, retryMs: number): void {
  const deadline = Date.now() + timeoutMs;
  mkdirSync(path.dirname(lockPath), { recursive: true });

  while (!tryClaimLock(lockPath, token, staleMs)) {
    if (Date.now() >= deadline) throw new Error(`timed out acquiring lock: ${lockPath}`);
    Atomics.wait(new Int32Array(sleepBuffer), 0, 0, retryMs);
  }
}

async function acquireFileLockAsync(lockPath: string, token: string, timeoutMs: number, staleMs: number, retryMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  mkdirSync(path.dirname(lockPath), { recursive: true });

  while (!tryClaimLock(lockPath, token, staleMs)) {
    if (Date.now() >= deadline) throw new Error(`timed out acquiring lock: ${lockPath}`);
    await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
  }
}

function releaseFileLock(lockPath: string, token: string): void {
  try {
    const current = readJson(lockPath) as { token?: unknown };
    if (current.token === token) unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function withFileLock<T>(
  protectedPath: string,
  operation: () => T,
  options: LockOptions = {},
): T {
  const lockPath = `${protectedPath}.lock`;
  const token = randomUUID();
  acquireFileLock(lockPath, token, options.timeoutMs ?? 10_000, options.staleMs ?? 30_000, options.retryMs ?? 20);

  try {
    return operation();
  } finally {
    releaseFileLock(lockPath, token);
  }
}

/** Async counterpart of {@link withFileLock}: the same lock-file protocol, but retries via a non-blocking timer and accepts an async action. */
export async function withFileLockAsync<T>(
  protectedPath: string,
  operation: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const lockPath = `${protectedPath}.lock`;
  const token = randomUUID();
  await acquireFileLockAsync(lockPath, token, options.timeoutMs ?? 10_000, options.staleMs ?? 30_000, options.retryMs ?? 20);
  try {
    return await operation();
  } finally {
    releaseFileLock(lockPath, token);
  }
}
