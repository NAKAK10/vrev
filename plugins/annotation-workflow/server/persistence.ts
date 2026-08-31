import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const sleepBuffer = new SharedArrayBuffer(4);
export function readJson(filePath: string): unknown { return JSON.parse(readFileSync(filePath, "utf8")); }
export function atomicWriteJson(filePath: string, data: unknown): void {
  const directory = path.dirname(filePath); mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(data, null, 2)}\n`, "utf8"); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, filePath);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
export function withFileLock<T>(protectedPath: string, operation: () => T): T {
  const lockPath = `${protectedPath}.lock`; const token = randomUUID(); const deadline = Date.now() + 10_000;
  mkdirSync(path.dirname(lockPath), { recursive: true });
  for (;;) {
    try { writeFileSync(lockPath, `${JSON.stringify({ token, pid: process.pid })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try { if (Date.now() - statSync(lockPath).mtimeMs > 30_000) unlinkSync(lockPath); }
      catch (inspectionError) { if ((inspectionError as NodeJS.ErrnoException).code !== "ENOENT") throw inspectionError; }
      if (Date.now() >= deadline) throw new Error(`timed out acquiring lock: ${lockPath}`);
      Atomics.wait(new Int32Array(sleepBuffer), 0, 0, 20);
    }
  }
  try { return operation(); }
  finally {
    try { if ((readJson(lockPath) as { token?: unknown }).token === token) unlinkSync(lockPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
