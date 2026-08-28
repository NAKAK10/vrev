import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JobManager, type JobManagerOptions } from "./job-manager.js";
import { ReviewStore } from "./review-store.js";
import { acquireServerLease, type ServerLease } from "./server-lease.js";
import type { AddMessageInput, CreateAnnotationInput, SetStatusInput } from "./types.js";

export const MAX_REQUEST_BODY = 1024 * 1024;
export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

const SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "media-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webp": "image/webp",
};

const SENSITIVE_PREFIXES = ["credential", "secret"];

export interface VisualReviewServerOptions {
  projectRoot: string;
  target: string;
  allowScripts?: boolean;
  allowAiJobsWithScripts?: boolean;
  jobManager?: JobManagerOptions;
}

export interface VisualReviewServer {
  server: Server;
  store: ReviewStore;
  jobManager: JobManager;
  uiRoot: string;
  lease: ServerLease;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", SECURITY_POLICY);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "SAMEORIGIN");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function send(response: ServerResponse, status: number, body: Buffer, contentType: string): void {
  setSecurityHeaders(response);
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": body.byteLength,
  });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, Buffer.from(JSON.stringify(value)), "application/json; charset=utf-8");
}

function sendError(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { error: message });
}

function contentType(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function rewriteLiveText(content: string, contentTypeValue: string, origin: string): string {
  const upstream = new URL(origin);
  const port = upstream.port ? `:${upstream.port}` : "";
  let result = content;
  for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
    result = result.replaceAll(`http://${hostname}${port}`, "/live");
  }
  if (contentTypeValue.includes("text/html")) {
    result = result.replace(/\b(src|href|action)=(['"])\/(?!\/|live\/)/gi, (_match, name: string, quote: string) => `${name}=${quote}/live/`);
  }
  if (contentTypeValue.includes("text/css")) {
    result = result.replace(/url\((['"]?)\/(?!\/|live\/)/gi, (_match, quote: string) => `url(${quote}/live/`);
  }
  if (contentTypeValue.includes("javascript")) {
    result = result.replace(/(['"`])\/(?!\/|live\/)/g, "$1/live/");
  }
  return result;
}

function proxyLiveRequest(request: IncomingMessage, response: ServerResponse, liveUrl: string, requestUrl: URL): Promise<void> {
  const origin = new URL(liveUrl).origin;
  const suffix = requestUrl.pathname.slice("/live".length) || "/";
  const upstream = new URL(`${suffix}${requestUrl.search}`, origin);
  return new Promise((resolve, reject) => {
    const headers = { ...request.headers, host: upstream.host, "accept-encoding": "identity" };
    delete headers.connection;
    const outgoing = httpRequest(upstream, { method: request.method, headers }, (incoming) => {
      const contentTypeValue = String(incoming.headers["content-type"] ?? "application/octet-stream");
      const textual = /text\/|javascript|json|xml|svg/i.test(contentTypeValue);
      const responseHeaders = { ...incoming.headers };
      for (const name of ["content-length", "content-encoding", "transfer-encoding", "content-security-policy", "x-frame-options"]) delete responseHeaders[name];
      const location = incoming.headers.location;
      if (location) {
        const resolved = new URL(location, upstream);
        responseHeaders.location = resolved.origin === origin ? `/live${resolved.pathname}${resolved.search}${resolved.hash}` : location;
      }
      setSecurityHeaders(response);
      if (!textual) {
        response.writeHead(incoming.statusCode ?? 502, responseHeaders);
        incoming.pipe(response);
        incoming.once("end", resolve);
        incoming.once("error", reject);
        return;
      }
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      incoming.once("error", reject);
      incoming.once("end", () => {
        const rewritten = Buffer.from(rewriteLiveText(Buffer.concat(chunks).toString("utf8"), contentTypeValue, origin));
        responseHeaders["content-length"] = String(rewritten.byteLength);
        response.writeHead(incoming.statusCode ?? 502, responseHeaders);
        response.end(rewritten);
        resolve();
      });
    });
    outgoing.once("error", reject);
    request.pipe(outgoing);
  });
}

function serveFile(response: ServerResponse, filePath: string): void {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new HttpError(404, "file not found");
  }
  send(response, 200, readFileSync(filePath), contentType(filePath));
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(404, "file not found");
  }
}

function publicParts(relativePath: string): string[] {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    relativePath.includes("\\")
  ) {
    throw new HttpError(404, "file not found");
  }
  const parts = relativePath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new HttpError(404, "file not found");
  }
  const prefixLength = parts[0] === "assets" ? 1 : parts[0] === ".code" && parts[1] === "htmls" ? 2 : 0;
  if (prefixLength === 0 || parts.length === prefixLength) {
    throw new HttpError(404, "file not found");
  }
  if (
    parts.slice(prefixLength).some(
      (part) => part.startsWith(".") || SENSITIVE_PREFIXES.some((prefix) => part.toLowerCase().startsWith(prefix)),
    )
  ) {
    throw new HttpError(404, "file not found");
  }
  return parts;
}

function resolvePublicFile(projectRoot: string, relativePath: string): string {
  const parts = publicParts(relativePath);
  let candidate = projectRoot;
  try {
    for (const part of parts) {
      candidate = path.join(candidate, part);
      if (lstatSync(candidate).isSymbolicLink()) throw new Error("symlink");
    }
    const resolved = realpathSync(candidate);
    const relative = path.relative(projectRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !statSync(resolved).isFile()) throw new Error("outside");
    return resolved;
  } catch {
    throw new HttpError(404, "file not found");
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    const length = Number(declared);
    if (!Number.isInteger(length) || length < 0) throw new HttpError(400, "invalid Content-Length");
    if (length > MAX_REQUEST_BODY) throw new HttpError(413, "request body too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_REQUEST_BODY) throw new HttpError(413, "request body too large");
    chunks.push(buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "malformed JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "JSON body must be an object");
  }
  return value as Record<string, unknown>;
}

function annotationId(pathname: string, suffix = ""): string | undefined {
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^/api/annotations/([^/]+)${escapedSuffix}$`).exec(pathname);
  return match?.[1] === undefined ? undefined : decodePath(match[1]);
}

function jobId(pathname: string): string | undefined {
  const match = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(pathname);
  return match?.[1] === undefined ? undefined : decodePath(match[1]);
}

function isAnnotationMissing(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("annotation not found:");
}

function isJobMissing(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("job not found:");
}

function defaultUiRoot(): string {
  return fileURLToPath(new URL("./ui", import.meta.url));
}

export function assertLoopbackHost(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) throw new Error("host must be 127.0.0.1 or ::1");
}

export function createVisualReviewServer(options: VisualReviewServerOptions): VisualReviewServer {
  const store = new ReviewStore(options.target, { projectRoot: options.projectRoot });
  const jobManager = new JobManager(store, options.jobManager);
  const uiRoot = defaultUiRoot();
  for (const name of ["index.html", "reviewer.css", "reviewer.js", "jobs.js"]) {
    if (!existsSync(path.join(uiRoot, name))) {
      throw new Error(`built UI asset missing: ${path.join(uiRoot, name)}; run npm run build first`);
    }
  }
  const lease = acquireServerLease(store.path);
  const allowScripts = options.allowScripts === true || store.target.liveUrl !== undefined;
  const aiJobsEnabled = !allowScripts || options.allowAiJobsWithScripts === true;
  try {
    if (aiJobsEnabled) jobManager.start();
  } catch (error) {
    lease.release();
    throw error;
  }
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://localhost");
        const pathname = url.pathname;
        if (!aiJobsEnabled && (pathname === "/api/jobs" || pathname === "/api/jobs/batch" || /^\/api\/jobs\/[^/]+\/cancel$/.test(pathname))) {
          throw new HttpError(403, "AI jobs require explicit --allow-ai-jobs-with-scripts consent when target scripts are allowed");
        }
        if (request.method === "GET" && pathname === "/") return serveFile(response, path.join(uiRoot, "index.html"));
        if (request.method === "GET" && ["/reviewer.css", "/reviewer.js", "/jobs.js"].includes(pathname)) {
          return serveFile(response, path.join(uiRoot, pathname.slice(1)));
        }
        if (request.method === "GET" && pathname === "/api/session") {
          return sendJson(response, 200, {
            target: {
              entry_path: store.entryPath,
              kind: store.target.kind,
              sha256: store.sourceHash(),
              allow_scripts: allowScripts,
              ai_jobs_enabled: aiJobsEnabled,
              live_url: store.target.liveUrl ?? null,
              url: store.target.liveUrl
                ? `/live${new URL(store.target.liveUrl).pathname}${new URL(store.target.liveUrl).search}`
                : `/target/${store.entryPath.split("/").map(encodeURIComponent).join("/")}`,
            },
            review: store.load(),
          });
        }
        if (request.method === "GET" && pathname === "/api/file-state") {
          const paths = url.searchParams.getAll("path");
          if (paths.length !== 1 || !paths[0]?.trim()) throw new HttpError(400, "exactly one nonblank path is required");
          try {
            const pagePath = paths[0];
            if (store.target.liveUrl) {
              return sendJson(response, 200, { path: pagePath, sha256: store.sourceHash(pagePath) });
            }
            const page = new ReviewStore(pagePath, { projectRoot: store.target.projectRoot });
            if (store.target.kind === "image" && page.targetPath !== store.targetPath) throw new Error("outside session");
            if (store.target.kind === "html" && page.target.kind !== "html") throw new Error("outside session");
            return sendJson(response, 200, { path: page.entryPath, sha256: page.sourceHash() });
          } catch {
            throw new HttpError(400, "path is outside the active session");
          }
        }
        if (request.method === "GET" && pathname === "/api/jobs") {
          return sendJson(response, 200, jobManager.list());
        }
        if (request.method === "POST" && pathname === "/api/jobs/batch") {
          return sendJson(response, 200, jobManager.enqueue(await readJson(request)));
        }
        const cancelId = request.method === "POST" ? jobId(pathname) : undefined;
        if (cancelId !== undefined) return sendJson(response, 200, jobManager.cancel(cancelId));
        if (store.target.liveUrl && pathname.startsWith("/live")) {
          await proxyLiveRequest(request, response, store.target.liveUrl, url);
          return;
        }
        if (request.method === "GET" && pathname.startsWith("/target/")) {
          return serveFile(response, resolvePublicFile(store.target.projectRoot, decodePath(pathname.slice(8))));
        }
        if (request.method === "GET" && pathname.startsWith("/assets/")) {
          return serveFile(response, resolvePublicFile(store.target.projectRoot, `assets/${decodePath(pathname.slice(8))}`));
        }
        if (request.method === "POST" && pathname === "/api/annotations") {
          const review = store.createAnnotation(await readJson(request) as unknown as CreateAnnotationInput);
          return sendJson(response, 200, review);
        }
        const messageId = request.method === "POST" ? annotationId(pathname, "/messages") : undefined;
        if (messageId !== undefined) {
          const review = store.addMessage(messageId, await readJson(request) as unknown as AddMessageInput);
          return sendJson(response, 200, review);
        }
        const statusId = request.method === "PATCH" ? annotationId(pathname) : undefined;
        if (statusId !== undefined) {
          const review = store.setStatus(statusId, await readJson(request) as unknown as SetStatusInput);
          return sendJson(response, 200, review);
        }
        throw new HttpError(404, "route not found");
      } catch (error) {
        if (response.headersSent) return response.end();
        if (error instanceof HttpError) return sendError(response, error.status, error.message);
        if (isAnnotationMissing(error)) return sendError(response, 404, "annotation not found");
        if (isJobMissing(error)) return sendError(response, 404, "job not found");
        return sendError(response, 400, error instanceof Error ? error.message : "bad request");
      }
    })();
  });
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = async (): Promise<void> => {
    shutdownPromise ??= jobManager.close().finally(() => lease.release());
    await shutdownPromise;
  };
  server.once("close", () => { void shutdown(); });
  const close = async (): Promise<void> => {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await shutdown();
  };
  return { server, store, jobManager, uiRoot, lease, close };
}
