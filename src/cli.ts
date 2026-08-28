#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertLoopbackHost, createVisualReviewServer } from "./http-server.js";
import { ReviewStore } from "./review-store.js";

interface ServeArguments {
  projectRoot: string;
  target: string;
  host: string;
  port: number;
  allowScripts: boolean;
  allowAiJobsWithScripts: boolean;
  startCommand: string | null;
  stopCommand: string | null;
  open: boolean;
}

function serveUsage(): never {
  throw new Error("usage: visual-review serve --project-root <root> --target <relative|loopback-url> [--start <command>] [--stop <command>] [--host 127.0.0.1|::1] [--port 18765] [--allow-scripts] [--no-ai-jobs-with-scripts] [--no-open]");
}

export function parseCliArguments(argv: string[], cwd = process.cwd()): ServeArguments {
  if (argv[0] !== "serve") serveUsage();
  const values = new Map<string, string>();
  let allowScripts = false;
  let allowAiJobsWithScripts = true;
  let open = true;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--allow-scripts") { allowScripts = true; continue; }
    if (argument === "--allow-ai-jobs-with-scripts") { allowAiJobsWithScripts = true; continue; }
    if (argument === "--no-ai-jobs-with-scripts") { allowAiJobsWithScripts = false; continue; }
    if (argument === "--no-open") { open = false; continue; }
    if (!["--project-root", "--target", "--start", "--stop", "--host", "--port"].includes(argument)) serveUsage();
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) serveUsage();
    values.set(argument, value);
    index += 1;
  }
  const rootValue = values.get("--project-root");
  const target = values.get("--target");
  if (rootValue === undefined || target === undefined) serveUsage();
  const liveTarget = /^https?:\/\//i.test(target);
  if (!target.trim() || (!liveTarget && (path.isAbsolute(target) || path.win32.isAbsolute(target) || target.includes("\\")))) {
    throw new Error("target must be a POSIX relative path or loopback HTTP URL");
  }
  if (values.has("--start") && !liveTarget) throw new Error("--start requires a loopback URL target");
  if (values.has("--stop") && !values.has("--start")) throw new Error("--stop requires --start");
  const host = values.get("--host") ?? "127.0.0.1";
  assertLoopbackHost(host);
  const portText = values.get("--port") ?? "18765";
  if (!/^\d+$/.test(portText)) throw new Error("port must be an integer from 1 to 65535");
  const port = Number(portText);
  if (port < 1 || port > 65535) throw new Error("port must be an integer from 1 to 65535");
  return {
    projectRoot: path.resolve(cwd, rootValue),
    target,
    host,
    port,
    allowScripts,
    allowAiJobsWithScripts,
    startCommand: values.get("--start") ?? null,
    stopCommand: values.get("--stop") ?? null,
    open,
  };
}

interface AnnotationArguments {
  action: "add-message" | "set-status";
  projectRoot: string;
  reviewPath: string;
  annotationId: string;
}

function annotationUsage(): never {
  throw new Error("usage: visual-review annotation add-message|set-status --project-root <root> --review-path <relative review.json> --annotation-id <id> [--actor ai --body-stdin|--status addressed]");
}

export function parseAnnotationArguments(argv: string[], cwd = process.cwd()): AnnotationArguments {
  if (argv[0] !== "annotation" || (argv[1] !== "add-message" && argv[1] !== "set-status")) annotationUsage();
  const action = argv[1];
  const values = new Map<string, string>();
  let bodyStdin = false;
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--body-stdin") { bodyStdin = true; continue; }
    if (!["--project-root", "--review-path", "--annotation-id", "--actor", "--status"].includes(argument)) annotationUsage();
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) annotationUsage();
    values.set(argument, value);
    index += 1;
  }
  const projectRoot = values.get("--project-root");
  const reviewPath = values.get("--review-path");
  const annotationId = values.get("--annotation-id");
  if (projectRoot === undefined || reviewPath === undefined || annotationId === undefined || !annotationId) annotationUsage();
  if (!reviewPath || path.isAbsolute(reviewPath) || path.win32.isAbsolute(reviewPath) || reviewPath.includes("\\") || reviewPath.split("/").some((part) => part === ".." || part === "." || !part)) {
    throw new Error("review-path must be a canonical POSIX relative path");
  }
  if (action === "add-message") {
    if (!bodyStdin || values.get("--actor") !== "ai" || values.has("--status")) annotationUsage();
  } else if (bodyStdin || values.has("--actor") || values.get("--status") !== "addressed") annotationUsage();
  return { action, projectRoot: path.resolve(cwd, projectRoot), reviewPath, annotationId };
}

function reviewStoreForPath(args: AnnotationArguments): ReviewStore {
  const supplied = path.resolve(args.projectRoot, ...args.reviewPath.split("/"));
  const raw = readFileSync(supplied, "utf8");
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch { throw new Error("review file contains malformed JSON"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("review file must contain an object");
  const target = (value as { target?: unknown }).target;
  if (typeof target !== "object" || target === null || Array.isArray(target) || typeof (target as { entry_path?: unknown }).entry_path !== "string") {
    throw new Error("review file target.entry_path is invalid");
  }
  const store = new ReviewStore((target as { entry_path: string }).entry_path, { projectRoot: args.projectRoot });
  const canonical = path.relative(store.target.projectRoot, store.path).split(path.sep).join("/");
  if (canonical !== args.reviewPath || realpathSync(store.path) !== realpathSync(supplied)) throw new Error("review-path does not match the canonical ReviewStore path");
  store.load();
  return store;
}

async function readStdinBody(): Promise<string> {
  const limit = 64 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > limit) throw new Error("stdin body exceeds 64 KiB");
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body.trim()) throw new Error("stdin body must be nonblank");
  return body;
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { shell: false, detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Opening the browser is best-effort; the printed URL remains usable.
  }
}

export interface SignalSource {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export function installShutdownHandlers(close: () => Promise<void>, source: SignalSource = process): () => void {
  let shuttingDown = false;
  const handler = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void close().catch((error: unknown) => {
      console.error(`error during shutdown: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
  };
  source.once("SIGINT", handler);
  source.once("SIGTERM", handler);
  return () => {
    source.removeListener("SIGINT", handler);
    source.removeListener("SIGTERM", handler);
  };
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}

export async function listenOnAvailablePort(server: Server, host: string, startPort: number): Promise<number> {
  for (let port = startPort; port <= 65535; port += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once("error", onError);
        server.listen(port, host, () => {
          server.removeListener("error", onError);
          resolve();
        });
      });
      return port;
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
    }
  }
  throw new Error(`no available port from ${startPort} to 65535`);
}

async function waitForLiveTarget(url: string, child: ReturnType<typeof spawn> | null, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined && child.exitCode !== 0) throw new Error(`start command exited with ${child.exitCode} before ${url} became ready`);
    try {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
      if (response.status < 500) return;
    } catch {
      // Retry until the local development server is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${url}`);
}

function stopStartedProcess(child: ReturnType<typeof spawn> | null): void {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); return; } catch { /* fall through */ }
  }
  child.kill("SIGTERM");
}

function runLifecycleCommand(command: string | null, cwd: string): Promise<void> {
  if (command === null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`lifecycle command exited with ${code ?? "unknown"}`)));
  });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv[0] === "annotation") {
    const args = parseAnnotationArguments(argv);
    const store = reviewStoreForPath(args);
    if (args.action === "add-message") store.addMessage(args.annotationId, { actor: "ai", body: await readStdinBody() });
    else store.setStatus(args.annotationId, { actor: "ai", status: "addressed" });
    return;
  }
  const args = parseCliArguments(argv);
  const startedProcess = args.startCommand === null ? null : spawn(args.startCommand, {
    cwd: args.projectRoot,
    shell: true,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  if (/^https?:\/\//i.test(args.target) && args.startCommand !== null) {
    try {
      await waitForLiveTarget(args.target, startedProcess);
    } catch (error) {
      stopStartedProcess(startedProcess);
      await runLifecycleCommand(args.stopCommand, args.projectRoot);
      throw error;
    }
  }
  const visualReview = createVisualReviewServer({
    projectRoot: args.projectRoot,
    target: args.target,
    allowScripts: args.allowScripts,
    allowAiJobsWithScripts: args.allowAiJobsWithScripts,
  });
  installShutdownHandlers(async () => {
    await visualReview.close();
    stopStartedProcess(startedProcess);
    await runLifecycleCommand(args.stopCommand, args.projectRoot);
  });
  try {
    await listenOnAvailablePort(visualReview.server, args.host, args.port);
  } catch (error) {
    await visualReview.close();
    stopStartedProcess(startedProcess);
    await runLifecycleCommand(args.stopCommand, args.projectRoot);
    throw error;
  }
  const address = visualReview.server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind a TCP address");
  const url = `http://${args.host === "::1" ? "[::1]" : args.host}:${address.port}/`;
  console.log(`Visual review: ${url}`);
  console.log(`Target: ${visualReview.store.entryPath}`);
  if (args.open) openBrowser(url);
}

const invokedPath = process.argv[1];
const isDirectInvocation = invokedPath !== undefined
  && realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url));
if (isDirectInvocation) {
  main().catch((error: unknown) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
