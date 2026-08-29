import { lookup as dnsLookup } from "node:dns/promises";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { testCustomCommand } from "./custom-command-test.js";
import { fileSha256 } from "./file-utils.js";
import { JobManager, type JobManagerOptions } from "./job-manager.js";
import { resolveTarget } from "./paths.js";
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

const LOOPBACK_TARGET_POLICY = [
  "default-src 'self' data: blob: http: https: ws: wss:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: blob: http: https:",
  "font-src 'self' data: https:",
  "media-src 'self' data: blob: http: https:",
  "connect-src 'self' http: https: ws: wss:",
  "frame-src 'self' http: https:",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' http: https:",
].join("; ");

const PUBLIC_TARGET_POLICY = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'self' https: 'unsafe-inline'",
  "img-src 'self' https: data:",
  "font-src 'self' https: data:",
  "media-src 'self' https: data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'self'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const PRIVATE_ADDRESSES = new BlockList();
for (const [address, prefix, family] of [
  ["0.0.0.0", 8, "ipv4"], ["10.0.0.0", 8, "ipv4"], ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"], ["169.254.0.0", 16, "ipv4"], ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"], ["192.0.2.0", 24, "ipv4"], ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"], ["198.51.100.0", 24, "ipv4"], ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"], ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"], ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"], ["fe80::", 10, "ipv6"], ["ff00::", 8, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
] as const) PRIVATE_ADDRESSES.addSubnet(address, prefix, family);

const MAX_PROXY_RESPONSE = 20 * 1024 * 1024;

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
  projectDirectory?: string;
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

function setSecurityHeaders(response: ServerResponse, policy = SECURITY_POLICY): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", policy);
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

function rewriteLiveText(content: string, contentTypeValue: string, origin: string, publicTarget: boolean): string {
  const upstream = new URL(origin);
  const port = upstream.port ? `:${upstream.port}` : "";
  let result = content.replaceAll(origin, "/live");
  if (!publicTarget) {
    for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
      result = result.replaceAll(`http://${hostname}${port}`, "/live");
    }
  }
  if (contentTypeValue.includes("text/html")) {
    if (!publicTarget && !/<base\b/i.test(result)) {
      const bridge = `<base href="/live/"><script>window.__visualReviewUrl=(value)=>{const url=new URL(value,window.location.href);if(url.origin===window.location.origin&&!url.pathname.startsWith('/live'))url.pathname='/live'+(url.pathname.startsWith('/')?url.pathname:'/'+url.pathname);return url.href}</script>`;
      result = result.replace(/<head(\s[^>]*)?>/i, (match) => `${match}${bridge}`);
    }
    result = result.replace(/\b(src|href|action)=(['"])\/(?!\/|live\/)/gi, (_match, name: string, quote: string) => `${name}=${quote}/live/`);
    if (publicTarget) {
      result = result.replace(/<meta\b[^>]*http-equiv=(['"])refresh\1[^>]*>/gi, "");
      result = result.replace(/(<a\b[^>]*\bhref=)(['"])(https?:\/\/[^'"]+)\2/gi, (_match, prefix: string, quote: string, value: string) => {
        try { return new URL(value).origin === origin ? `${prefix}${quote}/live${new URL(value).pathname}${new URL(value).search}${new URL(value).hash}${quote}` : `${prefix}${quote}#${quote}`; }
        catch { return `${prefix}${quote}#${quote}`; }
      });
    }
  }
  if (contentTypeValue.includes("text/css")) {
    result = result.replace(/url\((['"]?)\/(?!\/|live\/)/gi, (_match, quote: string) => `url(${quote}/live/`);
  }
  if (contentTypeValue.includes("javascript")) {
    result = result.replace(/(\b(?:from|import)\s*(?:\(\s*)?)(['"`])\/(?!\/|live\/)/g, "$1$2/live/");
    result = result.replace(/(\b(?:fetch|EventSource|Worker|SharedWorker|URL)\s*\(\s*)(['"`])\/(?!\/|live\/)/g, "$1$2/live/");
    result = result.replaceAll("window.location.pathname", `(window.location.pathname.replace(/^\\/live(?=\\/|$)/, "") || "/")`);
    result = result.replace(/window\.location\.(replace|assign)\(([^()\n;]+)\)/g, "window.location.$1(window.__visualReviewUrl($2))");
    result = result.replace(/((?:window\.)?location\.href\s*=\s*)(['"`])\/(?!\/|live\/)/g, "$1$2/live/");
  }
  return result;
}

function mappedIpv4(address: string): string | null {
  const tail = /^::ffff:(.+)$/i.exec(address)?.[1];
  if (!tail) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) return tail;
  const groups = tail.split(":");
  if (groups.length !== 2 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  const value = `${groups[0]!.padStart(4, "0")}${groups[1]!.padStart(4, "0")}`;
  return [0, 2, 4, 6].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)).join(".");
}

async function resolvePublicAddress(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  const blocked = ({ address, family }: { address: string; family: number }): boolean => {
    const mapped = family === 6 ? mappedIpv4(address) : null;
    return mapped ? PRIVATE_ADDRESSES.check(mapped, "ipv4") : PRIVATE_ADDRESSES.check(address, family === 6 ? "ipv6" : "ipv4");
  };
  if (addresses.length === 0 || addresses.some(blocked)) {
    throw new HttpError(403, "public target resolved to a non-public address");
  }
  const selected = addresses[0]!;
  return { address: selected.address, family: selected.family === 6 ? 6 : 4 };
}

async function proxyLiveRequest(request: IncomingMessage, response: ServerResponse, liveUrl: string, requestUrl: URL, publicTarget: boolean): Promise<void> {
  if (requestUrl.pathname !== "/live" && !requestUrl.pathname.startsWith("/live/")) throw new HttpError(404, "file not found");
  if (publicTarget && request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "public targets are read-only");
  const target = new URL(liveUrl);
  const origin = target.origin;
  const suffix = requestUrl.pathname.slice("/live".length) || "/";
  const upstream = new URL(origin);
  upstream.pathname = suffix;
  upstream.search = requestUrl.search;
  if (upstream.origin !== origin) throw new HttpError(400, "invalid live target path");
  const pinned = publicTarget ? await resolvePublicAddress(upstream.hostname) : null;
  await new Promise<void>((resolve, reject) => {
    const headers: Record<string, string> = { host: upstream.host, "accept-encoding": "identity" };
    for (const name of ["accept", "accept-language", "user-agent"]) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    if (!publicTarget && typeof request.headers["content-type"] === "string") headers["content-type"] = request.headers["content-type"];
    const transport = upstream.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = transport(upstream, {
      method: request.method,
      headers,
      lookup: pinned ? ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
        if (options.all) callback(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      }) as never : undefined,
    }, (incoming) => {
      const contentTypeValue = String(incoming.headers["content-type"] ?? "application/octet-stream");
      const textual = /text\/|javascript|json|xml|svg/i.test(contentTypeValue);
      const responseHeaders = { ...incoming.headers };
      for (const name of ["content-length", "content-encoding", "transfer-encoding", "content-security-policy", "x-frame-options", "set-cookie", "set-cookie2", "refresh"]) delete responseHeaders[name];
      const location = incoming.headers.location;
      if (location) {
        const resolved = new URL(location, upstream);
        if (resolved.origin !== origin) {
          incoming.resume();
          reject(new HttpError(502, "public target attempted a cross-origin redirect"));
          return;
        }
        responseHeaders.location = `/live${resolved.pathname}${resolved.search}${resolved.hash}`;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > MAX_PROXY_RESPONSE) incoming.destroy(new Error("proxy response exceeds 20 MiB"));
        else chunks.push(Buffer.from(chunk));
      });
      incoming.once("error", reject);
      incoming.once("end", () => {
        const body = Buffer.concat(chunks);
        const rewritten = textual ? Buffer.from(rewriteLiveText(body.toString("utf8"), contentTypeValue, origin, publicTarget)) : body;
        setSecurityHeaders(response, publicTarget ? PUBLIC_TARGET_POLICY : LOOPBACK_TARGET_POLICY);
        if (!publicTarget && contentTypeValue.includes("text/html")) responseHeaders["clear-site-data"] = '"cache"';
        responseHeaders["content-length"] = String(rewritten.byteLength);
        response.writeHead(incoming.statusCode ?? 502, responseHeaders);
        response.end(request.method === "HEAD" ? undefined : rewritten);
        resolve();
      });
    });
    outgoing.setTimeout(15_000, () => outgoing.destroy(new Error("proxy request timed out")));
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
  const htmlMarker = parts.findIndex((part, index) => part === ".code" && parts[index + 1] === "htmls");
  const assetMarker = parts.findIndex((part) => part === "assets");
  const prefixLength = htmlMarker >= 0 ? htmlMarker + 2 : assetMarker >= 0 ? assetMarker + 1 : 0;
  if (prefixLength === 0 || parts.length === prefixLength) throw new HttpError(404, "file not found");
  const projectParts = parts.slice(0, htmlMarker >= 0 ? htmlMarker : assetMarker);
  if (projectParts.some((part) => part.startsWith(".") || SENSITIVE_PREFIXES.some((prefix) => part.toLowerCase().startsWith(prefix)))) throw new HttpError(404, "file not found");
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
  const store = new ReviewStore(options.target, { projectRoot: options.projectRoot, ...(options.projectDirectory ? { projectDirectory: options.projectDirectory } : {}) });
  const jobManager = new JobManager(store, options.jobManager);
  const uiRoot = defaultUiRoot();
  for (const name of ["index.html", "reviewer.css", "reviewer.js", "jobs.js"]) {
    if (!existsSync(path.join(uiRoot, name))) {
      throw new Error(`built UI asset missing: ${path.join(uiRoot, name)}; run npm run build first`);
    }
  }
  const lease = acquireServerLease(store.path);
  const publicTarget = store.target.urlMode === "public";
  const allowScripts = !publicTarget && (options.allowScripts === true || store.target.liveUrl !== undefined);
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
        if (!aiJobsEnabled && (pathname === "/api/jobs" || pathname === "/api/jobs/batch" || pathname === "/api/jobs/custom-command/test" || /^\/api\/jobs\/[^/]+\/cancel$/.test(pathname))) {
          throw new HttpError(403, "AI jobs are disabled while target scripts are allowed");
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
              url_mode: store.target.urlMode ?? null,
              url: store.target.liveUrl
                ? `/live${new URL(store.target.liveUrl).pathname}${new URL(store.target.liveUrl).search}`
                : `/target/${store.entryPath.split("/").map(encodeURIComponent).join("/")}`,
            },
            review: store.loadActive(),
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
            const page = resolveTarget(pagePath, store.target.projectRoot);
            if (store.target.kind === "image" && page.absolutePath !== store.targetPath) throw new Error("outside session");
            if (store.target.kind === "html" && page.kind !== "html") throw new Error("outside session");
            return sendJson(response, 200, { path: page.entryPath, sha256: fileSha256(page.absolutePath) });
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
        if (request.method === "POST" && pathname === "/api/jobs/custom-command/test") {
          const input = await readJson(request);
          if (typeof input.command !== "string") throw new HttpError(400, "command must be a string");
          const probe = await testCustomCommand(input.command);
          return sendJson(response, 200, { ok: true, duration_ms: probe.durationMs });
        }
        const cancelId = request.method === "POST" ? jobId(pathname) : undefined;
        if (cancelId !== undefined) return sendJson(response, 200, jobManager.cancel(cancelId));
        if (store.target.liveUrl && (pathname === "/live" || pathname.startsWith("/live/"))) {
          await proxyLiveRequest(request, response, store.target.liveUrl, url, publicTarget);
          return;
        }
        if (request.method === "GET" && pathname.startsWith("/target/")) {
          return serveFile(response, resolvePublicFile(store.target.projectRoot, decodePath(pathname.slice(8))));
        }
        if (request.method === "GET" && pathname.startsWith("/assets/")) {
          return serveFile(response, resolvePublicFile(store.target.projectRoot, `assets/${decodePath(pathname.slice(8))}`));
        }
        if (request.method === "POST" && pathname === "/api/annotations") {
          store.createAnnotation(await readJson(request) as unknown as CreateAnnotationInput);
          return sendJson(response, 200, store.loadActive());
        }
        const messageId = request.method === "POST" ? annotationId(pathname, "/messages") : undefined;
        if (messageId !== undefined) {
          store.addMessage(messageId, await readJson(request) as unknown as AddMessageInput);
          return sendJson(response, 200, store.loadActive());
        }
        const statusId = request.method === "PATCH" ? annotationId(pathname) : undefined;
        if (statusId !== undefined) {
          store.setStatus(statusId, await readJson(request) as unknown as SetStatusInput);
          return sendJson(response, 200, store.loadActive());
        }
        if (store.target.liveUrl && !publicTarget) {
          const fallbackUrl = new URL(url.href);
          fallbackUrl.pathname = `/live${pathname}`;
          await proxyLiveRequest(request, response, store.target.liveUrl, fallbackUrl, false);
          return;
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
