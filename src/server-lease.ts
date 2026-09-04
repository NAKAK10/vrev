import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const GUARD_NAME = ".server-lease.guard";
const GUARD_RETRY_MS = 25;
const GUARD_TIMEOUT_MS = 3_000;
const GUARD_MALFORMED_GRACE_MS = 250;
const GUARD_STALE_MS = 30_000;

export interface ServerLeaseRecord {
  token: string;
  pid: number;
  started_at: string;
  tool: string;
}

export interface ServerLease {
  path: string;
  record: ServerLeaseRecord;
  release(): void;
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function validGuardOwner(value: unknown): value is ServerLeaseRecord {
  if (typeof value !== "object" || value === null) return false;
  const owner = value as Partial<ServerLeaseRecord>;
  return typeof owner.token === "string" && owner.token.length > 0
    && typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0
    && typeof owner.started_at === "string" && typeof owner.tool === "string";
}

function releaseGuard(guardPath: string, token: string): void {
  try {
    const owner = JSON.parse(readFileSync(path.join(guardPath, "owner.json"), "utf8")) as { token?: unknown };
    if (owner.token === token) rmSync(guardPath, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function withLeaseGuard<T>(reviewDirectory: string, tool: string, action: () => T): T {
  const guardPath = path.join(reviewDirectory, GUARD_NAME);
  const token = randomUUID();
  const owner: ServerLeaseRecord = { token, pid: process.pid, started_at: new Date().toISOString(), tool };
  const deadline = Date.now() + GUARD_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(guardPath, { mode: 0o700 });
      try {
        writeFileSync(path.join(guardPath, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      } catch (error) {
        rmSync(guardPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing: unknown;
      let age = Number.POSITIVE_INFINITY;
      try {
        existing = JSON.parse(readFileSync(path.join(guardPath, "owner.json"), "utf8"));
        age = Date.now() - statSync(guardPath).mtimeMs;
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        try { age = Date.now() - statSync(guardPath).mtimeMs; } catch { continue; }
      }
      const live = validGuardOwner(existing) && pidIsAlive(existing.pid);
      const reclaimable = validGuardOwner(existing) ? !live : age >= GUARD_MALFORMED_GRACE_MS;
      if (!live && (reclaimable || age >= GUARD_STALE_MS)) {
        const quarantine = `${guardPath}.quarantine-${randomUUID()}`;
        try {
          renameSync(guardPath, quarantine);
          rmSync(quarantine, { recursive: true, force: true });
        } catch (renameError) {
          if (!["ENOENT", "EEXIST"].includes((renameError as NodeJS.ErrnoException).code ?? "")) throw renameError;
        }
        continue;
      }
      if (Date.now() >= deadline) throw new Error("timed out waiting for vrev server lease guard");
      sleep(GUARD_RETRY_MS);
    }
  }
  try {
    return action();
  } finally {
    releaseGuard(guardPath, token);
  }
}

export function acquireServerLease(reviewPath: string, tool = "vrev"): ServerLease {
  const leasePath = path.join(path.dirname(reviewPath), ".server-lease.json");
  const record: ServerLeaseRecord = {
    token: randomUUID(),
    pid: process.pid,
    started_at: new Date().toISOString(),
    tool,
  };
  mkdirSync(path.dirname(leasePath), { recursive: true });
  withLeaseGuard(path.dirname(leasePath), `${tool}:acquire`, () => {
    try {
      const owner = JSON.parse(readFileSync(leasePath, "utf8")) as Partial<ServerLeaseRecord>;
      if (typeof owner.pid === "number" && pidIsAlive(owner.pid)) {
        throw new Error(`vrev server already owns this review directory (pid ${owner.pid})`);
      }
      unlinkSync(leasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && error instanceof Error && error.message.startsWith("vrev server already owns")) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        try { unlinkSync(leasePath); } catch (unlinkError) { if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError; }
      }
    }
    try {
      writeFileSync(leasePath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: Partial<ServerLeaseRecord> = {};
      try { owner = JSON.parse(readFileSync(leasePath, "utf8")) as Partial<ServerLeaseRecord>; } catch { /* malformed lease is stale */ }
      if (typeof owner.pid === "number" && pidIsAlive(owner.pid)) {
        throw new Error(`vrev server already owns this review directory (pid ${owner.pid})`);
      }
      throw error;
    }
  });
  let released = false;
  return {
    path: leasePath,
    record,
    release(): void {
      if (released) return;
      try {
        withLeaseGuard(path.dirname(leasePath), `${tool}:release`, () => {
          try {
            const current = JSON.parse(readFileSync(leasePath, "utf8")) as { token?: unknown };
            if (current.token === record.token) unlinkSync(leasePath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        });
      } finally { released = true; }
    },
  };
}
