import { lookup as dnsLookup } from "node:dns/promises";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AiCapabilityV1 } from "../packages/plugin-sdk/index.js";
import { createBundledBridgeCatalog, isBundledAiBridgeOperation, type BundledBridgeAdapter, type BundledBridgeRequest } from "./bundled-plugin-catalog.js";
import { bundledPluginsRoot } from "./bundled-plugins-root.js";
import { CapabilityRegistry } from "./capability-registry.js";
import { fileSha256 } from "./file-utils.js";
import { createIssueTaskCapability, type GitHubIssueDraft } from "./github-issue.js";
import { JobManager, type JobManagerOptions } from "./job-manager.js";
import { layoutSettingsRevision, readLayoutSettings, updateLayoutSettings, type LayoutSettingsUpdateInput } from "./layout-settings.js";
import { createLocalWorkspaceStorageProvider } from "./local-storage-provider.js";
import { resolveTarget } from "./paths.js";
import { installPlugin, installedPluginDirectory, listPlugins, removePlugin, type InstalledPlugin } from "./plugin-registry.js";
import { deletePluginCredential, readPluginCredentialPresence, setPluginCredential } from "./plugin-credentials.js";
import { loadPluginCustomCommandProvider, loadPluginIssueProvider, loadTrustedPluginAnnotationFlowProvider, loadWorkspaceStorageProviderV1, type PluginIssueResult } from "./plugin-runtime.js";
import { effectivePluginSettings, pluginSettingsRevision, readPluginSettings, updatePluginSettings } from "./plugin-settings.js";
import { createReviewCapability } from "./review-capability.js";
import type { ReviewStore } from "./review-store.js";
import { createRunnerRegistry } from "./runner-registry.js";
import { loadPluginUiSurface, resolvePluginBrowserModule } from "./plugin-ui-surface.js";
import { createPluginHostRuntime } from "./plugin-host-runtime.js";
import { createProcessSupervisor } from "./process-supervisor.js";
import { acquireServerLease, type ServerLease } from "./server-lease.js";
import { transferWorkspaceStorage, type StorageTransferResult } from "./storage-transfer.js";
import type { WorkspaceStorageProviderV1 } from "./storage-provider.js";
import type { AddMessageInput, CreateAnnotationInput, SetStatusInput } from "./types.js";
import { loadWorkspaceSettings } from "./workspace-settings.js";

export const MAX_REQUEST_BODY = 1024 * 1024;
export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
export const DEFAULT_STORAGE_PREFLIGHT_TIMEOUT_MS = 10_000;

const SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
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

export interface VrevServerOptions {
  projectRoot: string;
  projectDirectory?: string;
  target: string;
  allowScripts?: boolean;
  allowAiJobsWithScripts?: boolean;
  jobManager?: JobManagerOptions;
  issueCreator?: (draft: GitHubIssueDraft) => Promise<PluginIssueResult>;
  /** One-beta rollback switch. Declarative UI is the default. */
  legacyUi?: boolean;
  /** Timeout for the storage-backend connectivity preflight run when enabling a storage provider plugin. Defaults to 10s; tests may override it. */
  storagePreflightTimeoutMs?: number;
}

export interface VrevServer {
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
      const bridge = `<base href="/live/"><script>window.__vrevUrl=(value)=>{const url=new URL(value,window.location.href);if(url.origin===window.location.origin&&!url.pathname.startsWith('/live'))url.pathname='/live'+(url.pathname.startsWith('/')?url.pathname:'/'+url.pathname);return url.href}</script>`;
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
    result = result.replace(/window\.location\.(replace|assign)\(([^()\n;]+)\)/g, "window.location.$1(window.__vrevUrl($2))");
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

const MAX_BRIDGE_ACTION_BODY = 32 * 1024;
type BridgeAdapterResult = { ok: true; revision?: string; data: unknown; effects?: unknown[] } | { ok: false; revision?: string; error: { code: string; message: string; retryable: boolean; request_id: string; fields?: Record<string, string> } };

async function readBridgeJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = request.headers["content-length"];
  if (declared !== undefined && Number(declared) > MAX_BRIDGE_ACTION_BODY) throw new HttpError(413, "plugin bridge request is too large");
  const value = await readJson(request);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_BRIDGE_ACTION_BODY) throw new HttpError(413, "plugin bridge request is too large");
  if (value.protocol !== "plugin-bridge/1" || typeof value.request_id !== "string" || !value.request_id || typeof value.input !== "object" || value.input === null || Array.isArray(value.input)) {
    throw new HttpError(400, "invalid plugin bridge envelope");
  }
  return value;
}

function bridgeError(request: Record<string, unknown>, code: string, message: string, retryable = false): BridgeAdapterResult {
  return { ok: false, error: { code, message, retryable, request_id: typeof request.request_id === "string" ? request.request_id : "unknown" } };
}

function assertBridgeRequestOrigin(request: IncomingMessage): void {
  const origin = request.headers.origin;
  if (origin === "null") throw new HttpError(403, "sandboxed target cannot access plugin bridge actions");
  if (typeof origin === "string") {
    const host = request.headers.host;
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new HttpError(403, "plugin bridge origin is not allowed"); }
    if (!host || !["http:", "https:"].includes(parsed.protocol) || parsed.host !== host || parsed.username || parsed.password || parsed.pathname !== "/") {
      throw new HttpError(403, "plugin bridge origin is not allowed");
    }
  }
}

function bridgeStatus(code: string): number {
  return ({ BAD_REQUEST: 400, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, PAYLOAD_TOO_LARGE: 413, VALIDATION_FAILED: 422, RATE_LIMITED: 429, PLUGIN_PROTOCOL_ERROR: 502, PLUGIN_UNAVAILABLE: 503, TIMEOUT: 504 } as Record<string, number>)[code] ?? 500;
}

async function delegateBridge(
  adapter: BundledBridgeAdapter | undefined,
  kind: "query" | "command",
  name: string,
  request: Record<string, unknown>,
): Promise<BridgeAdapterResult> {
  if (!adapter) return bridgeError(request, "PLUGIN_UNAVAILABLE", "plugin is disabled or unavailable", true);
  if (kind === "command" && (typeof request.idempotency_key !== "string" || !request.idempotency_key)) {
    return bridgeError(request, "BAD_REQUEST", "idempotency_key is required");
  }
  try {
    return await adapter[kind](name, request as unknown as Parameters<BundledBridgeAdapter[typeof kind]>[1]);
  } catch (error) {
    if (isAnnotationMissing(error)) return bridgeError(request, "NOT_FOUND", "annotation not found");
    return bridgeError(request, "VALIDATION_FAILED", error instanceof Error ? error.message : "plugin operation failed");
  }
}

interface BridgeEventHub {
  readonly seq: number;
  subscribe(pluginId: string, response: ServerResponse): () => void;
  publish(resources: string[], revision?: string): void;
}

function createBridgeEventHub(): BridgeEventHub {
  let seq = 0;
  const subscribers = new Map<string, Set<ServerResponse>>();
  return {
    get seq() { return seq; },
    subscribe(pluginId, response) {
      let clients = subscribers.get(pluginId);
      if (!clients) { clients = new Set(); subscribers.set(pluginId, clients); }
      clients.add(response);
      return () => { clients?.delete(response); if (clients?.size === 0) subscribers.delete(pluginId); };
    },
    publish(resources, revision) {
      const unique = [...new Set(resources.filter((resource) => typeof resource === "string" && resource))];
      if (!unique.length) return;
      seq += 1;
      for (const [pluginId, clients] of subscribers) {
        const event = { protocol: "plugin-bridge/1", event_id: `host:${seq}`, seq, plugin_id: pluginId, type: "resources.invalidated", resources: unique, ...(revision ? { revision } : {}) };
        const frame = `id: ${event.event_id}\ndata: ${JSON.stringify(event)}\n\n`;
        for (const client of clients) if (!client.destroyed) client.write(frame);
      }
    },
  };
}

function serveBridgeEvents(request: IncomingMessage, response: ServerResponse, pluginId: string, projectRoot: string, hub: BridgeEventHub): void {
  if (!pluginEnabled(pluginId, projectRoot)) throw new HttpError(404, "plugin event stream is unavailable");
  setSecurityHeaders(response);
  response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  response.flushHeaders();
  response.write(`retry: 1000\nid: host:${hub.seq}\ndata: ${JSON.stringify({ protocol: "plugin-bridge/1", event_id: `host:${hub.seq}`, seq: hub.seq, plugin_id: pluginId, type: "resync.required", resources: [] })}\n\n`);
  const unsubscribe = hub.subscribe(pluginId, response);
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
  heartbeat.unref();
  request.once("close", () => { clearInterval(heartbeat); unsubscribe(); });
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

function bundledAnnotationWorkflowRoot(): string {
  return fileURLToPath(new URL("./bundled-plugins/annotation-workflow", import.meta.url));
}

function pluginSettingsUiRoot(): string {
  return fileURLToPath(new URL("./plugin-settings-ui", import.meta.url));
}

function pluginCapabilities(manifest: ReturnType<typeof listPlugins>[number]["manifest"]): string[] {
  return [
    ...(manifest.commands?.length ? ["commands"] : []),
    ...(manifest.storage_provider ? ["storage"] : []),
    ...(manifest.issue_provider ? ["issue"] : []),
    ...(manifest.annotation_flow_provider ? ["annotation-flow"] : []),
  ];
}

function pluginEnabled(id: string, projectRoot: string): boolean {
  const plugin = listPlugins(projectRoot).find((candidate) => candidate.id === id);
  if (!plugin) return false;
  const effective = effectivePluginSettings(plugin.manifest, projectRoot);
  return effective.enabled && effective.missing.length === 0;
}

/**
 * True when a plugin's recorded source resolves inside the CLI package's own
 * bundled-plugins copy. Provenance is judged purely from the source path so
 * this never branches on a specific plugin id (see the architecture test).
 */
function isBundledPluginSource(source: string): boolean {
  if (!path.isAbsolute(source)) return false;
  const relative = path.relative(bundledPluginsRoot(), path.resolve(source));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pluginManagementPayload(projectRoot: string): object {
  const settings = readPluginSettings(projectRoot);
  return {
    revision: pluginSettingsRevision(settings),
    plugins: listPlugins(projectRoot).map(({ id, version, manifest, source, installed_at, resolved, directory }) => {
      const effective = effectivePluginSettings(manifest, projectRoot);
      const hasCredentialField = (manifest.configuration ?? []).some((field) => field.source === "credential");
      const credentialPresence = hasCredentialField ? readPluginCredentialPresence(id, projectRoot) : {};
      const configuration = (manifest.configuration ?? []).map((field) => {
        if (field.source === "credential") {
          const presence = credentialPresence[field.key];
          return { ...field, present: Boolean(presence), updated_at: presence?.updated_at ?? null, fingerprint: presence?.fingerprint ?? null, value: null };
        }
        return {
          ...field,
          ...(field.source === "environment" ? { present: Boolean(field.environment && process.env[field.environment]) } : {}),
          value: field.source === "workspace" ? effective.configuration[field.key] ?? null : null,
        };
      });
      return {
        id,
        version,
        title: manifest.display?.title ?? id,
        summary: manifest.display?.summary ?? `Vrev plugin: ${id}`,
        capabilities: pluginCapabilities(manifest),
        enabled: effective.enabled,
        missing: effective.missing,
        configuration,
        has_readme: Boolean(manifest.display?.readme ?? existsSync(path.join(installedPluginDirectory(id, projectRoot), "README.md"))),
        source,
        installed_at,
        resolved: resolved ?? null,
        bundled: isBundledPluginSource(source),
        package_managed: directory !== undefined,
      };
    }),
  };
}

function readInstalledPluginReadme(id: string, projectRoot: string): string {
  const plugin = listPlugins(projectRoot).find((candidate) => candidate.id === id);
  if (!plugin) throw new HttpError(404, "plugin not found");
  const relative = plugin.manifest.display?.readme ?? "./README.md";
  const candidate = path.join(installedPluginDirectory(id, projectRoot), ...relative.slice(2).split("/"));
  if (!existsSync(candidate) || lstatSync(candidate).isSymbolicLink() || !statSync(candidate).isFile()) throw new HttpError(404, "plugin README not found");
  if (statSync(candidate).size > 256 * 1024) throw new HttpError(413, "plugin README is too large");
  return readFileSync(candidate, "utf8");
}

async function createIssueWithInstalledPlugin(projectRoot: string, draft: GitHubIssueDraft): Promise<PluginIssueResult> {
  try {
    const { provider } = await loadPluginIssueProvider("github-issue", projectRoot);
    return await provider.createIssue(projectRoot, draft);
  } catch (error) {
    if (error instanceof Error && error.message === "plugin is not installed: github-issue") {
      throw new Error("GitHub Issue provider plugin 'github-issue' is not installed. Add it to the workspace with: npm install --save-dev @vrev/github-issue");
    }
    throw error;
  }
}

/**
 * Verifies that a storage provider plugin's backend is actually reachable before enabling it,
 * by loading the provider with the just-written configuration and issuing a lightweight read.
 * Throws with a message safe to surface to the caller (no credential values are appended).
 */
async function verifyStorageProviderConnectivity(pluginId: string, projectRoot: string, timeoutMs: number): Promise<void> {
  const probe = (async () => {
    const { provider } = await loadWorkspaceStorageProviderV1(pluginId, projectRoot);
    await provider.list("reviews/");
  })();
  probe.catch(() => undefined); // avoid an unhandled rejection when the timeout wins the race below
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("backend への接続がタイムアウトしました")), timeoutMs);
  });
  try {
    await Promise.race([probe, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function assertLoopbackHost(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) throw new Error("host must be 127.0.0.1 or ::1");
}

export function createVrevServer(options: VrevServerOptions): VrevServer {
  // Deprecated HTTP routes are transport adapters over the review plugin capability.
  const reviewCapability = createReviewCapability(options.target, {
    projectRoot: options.projectRoot,
    ...(options.projectDirectory ? { projectDirectory: options.projectDirectory } : {}),
  });
  const store = reviewCapability.store;
  const customCommandProvider = async () => (await loadPluginCustomCommandProvider("ai", store.target.projectRoot)).provider;
  const runnerRegistry = createRunnerRegistry(store.target.projectRoot);
  const processSupervisor = options.jobManager?.executor ? {
    run(spec: { command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }) {
      const running = options.jobManager!.executor!({ ...spec, args: [...spec.args] });
      return { cancel: () => running.cancel(), result: running.result.then((result) => ({ exitCode: result.exitCode, reason: result.reason, stdout: result.output ?? "" })) };
    },
  } : createProcessSupervisor();
  const hostCapabilities = new CapabilityRegistry();
  hostCapabilities.register("review", 1, reviewCapability);
  hostCapabilities.register("host.process-supervisor", 1, processSupervisor);
  hostCapabilities.register("host.runner-registry", 1, runnerRegistry);
  let packagePluginHostReady: Promise<void> = Promise.resolve();
  const resolveAi = (): AiCapabilityV1 => {
    if (!pluginEnabled("ai", store.target.projectRoot)) throw new Error("AI package is disabled");
    return hostCapabilities.resolve<AiCapabilityV1>("ai", 1);
  };
  const ai: AiCapabilityV1 = Object.freeze({
    apiVersion: 1,
    async list(input: Parameters<AiCapabilityV1["list"]>[0]) {
      if (!pluginEnabled("ai", store.target.projectRoot)) return [];
      await packagePluginHostReady;
      return resolveAi().list(input);
    },
    invoke(input: Parameters<AiCapabilityV1["invoke"]>[0]) {
      let delegated: ReturnType<AiCapabilityV1["invoke"]> | undefined;
      let cancelled = false;
      const result = (async () => {
        await packagePluginHostReady;
        if (cancelled) return { status: "cancelled" as const, output: "", exit_code: null, message: "AI invocation was cancelled", retryable: true };
        delegated = resolveAi().invoke(input);
        if (cancelled) delegated.cancel();
        return delegated.result;
      })();
      return { result, cancel() { cancelled = true; delegated?.cancel(); } };
    },
  });
  const jobManager = new JobManager(store, {
    ...options.jobManager,
    ai,
  });
  const issueCreator = options.issueCreator ?? ((draft: GitHubIssueDraft) => createIssueWithInstalledPlugin(store.target.projectRoot, draft));
  const issueTask = createIssueTaskCapability(
    reviewCapability,
    { provider: { createIssue: (_projectRoot, draft) => issueCreator(draft) } },
  );
  const commandJournal = new Map<string, { payload: string; result: Promise<BridgeAdapterResult>; at: number }>();
  const bridgeEventHub = createBridgeEventHub();
  const publishEffects = (result: BridgeAdapterResult): BridgeAdapterResult => {
    if (result.ok) {
      const resources = (result.effects ?? []).flatMap((effect) => {
        if (!effect || typeof effect !== "object" || (effect as { type?: unknown }).type !== "resource.invalidate") return [];
        const values = (effect as { resources?: unknown }).resources;
        return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [];
      });
      bridgeEventHub.publish(resources, result.revision);
    }
    return result;
  };
  const storagePreflightTimeoutMs = options.storagePreflightTimeoutMs ?? DEFAULT_STORAGE_PREFLIGHT_TIMEOUT_MS;
  const uiRoot = defaultUiRoot();
  const settingsUiRoot = pluginSettingsUiRoot();
  const pluginManagementVisible = loadWorkspaceSettings(store.target.projectRoot).ui?.plugin_management !== false;
  for (const name of ["index.html", "renderer.html", "renderer.css", "renderer.js", "reviewer.css", "reviewer.js", "jobs.js"]) {
    if (!existsSync(path.join(uiRoot, name))) {
      throw new Error(`built UI asset missing: ${path.join(uiRoot, name)}; run npm run build first`);
    }
  }
  for (const name of ["index.html", "settings.css", "settings.js"]) {
    if (!existsSync(path.join(settingsUiRoot, name))) throw new Error(`built plugin settings asset missing: ${path.join(settingsUiRoot, name)}; run npm run build first`);
  }
  const lease = acquireServerLease(store.path);
  const publicTarget = store.target.urlMode === "public";
  const allowScripts = !publicTarget && (options.allowScripts === true || store.target.liveUrl !== undefined);
  const aiJobsEnabled = !allowScripts || options.allowAiJobsWithScripts === true;
  const bundledBridgeCatalog = createBundledBridgeCatalog({
    review: reviewCapability,
    workflowManager: jobManager,
    ai,
    issueTask,
    allowScripts,
    aiJobsEnabled,
    pluginManagementVisible,
  });
  const createPackagePluginHost = () => createPluginHostRuntime({
    workspaceRoot: store.target.projectRoot,
    workspaceId: store.target.projectRoot,
    target: { id: store.entryPath, source: options.target },
    capabilities: hostCapabilities,
    runnerRegistry,
    principal: "human-ui",
    authorizeOperation: ({ permission }) => aiJobsEnabled || (permission !== "ai.execute" && permission !== "external.execute"),
    excludePluginIds: [...bundledBridgeCatalog.keys()],
  });
  let packagePluginHost = createPackagePluginHost();
  const packageBridgeAdapters = new Map<string, BundledBridgeAdapter>();
  let packageHostReconciliation = Promise.resolve();
  const reconcilePackagePluginHost = (): Promise<void> => {
    packageHostReconciliation = packageHostReconciliation.then(async () => {
      await packagePluginHost.stop("reload");
      packagePluginHost = createPackagePluginHost();
      packageBridgeAdapters.clear();
      packagePluginHostReady = packagePluginHost.start().catch(() => undefined);
      await packagePluginHostReady;
    });
    return packageHostReconciliation;
  };
  const bridgeAdapter = (pluginId: string): BundledBridgeAdapter | undefined => {
    if (!pluginEnabled(pluginId, store.target.projectRoot)) return undefined;
    const bundled = bundledBridgeCatalog.get(pluginId);
    if (bundled) return bundled;
    let adapter = packageBridgeAdapters.get(pluginId);
    if (!adapter) {
      adapter = {
        query: (name, request) => packagePluginHost.query(pluginId, name, { protocol: "plugin-bridge/1", request_id: request.request_id, input: request.input }),
        command: (name, request) => packagePluginHost.sendAction(pluginId, name, { protocol: "plugin-bridge/1", request_id: request.request_id, idempotency_key: (request as BundledBridgeRequest & { idempotency_key?: string }).idempotency_key ?? "", ...((typeof request.expected_revision === "string" || request.expected_revision === null) ? { expected_revision: request.expected_revision } : {}), input: request.input }),
      } as BundledBridgeAdapter;
      packageBridgeAdapters.set(pluginId, adapter);
    }
    return adapter;
  };
  try {
    // start() is async; server creation stays synchronous, so startup reconciliation runs in the background
    // and any failure there is swallowed rather than aborting server creation.
    packagePluginHostReady = packagePluginHost.start().catch(() => undefined);
    if (aiJobsEnabled && pluginEnabled("annotation-workflow", store.target.projectRoot)) void jobManager.start().catch(() => undefined);
  } catch (error) {
    lease.release();
    throw error;
  }
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://localhost");
        const pathname = url.pathname;
        if (!aiJobsEnabled && (pathname === "/api/jobs" || pathname === "/api/jobs/batch" || pathname.startsWith("/api/jobs/custom-command") || pathname === "/api/issues/request" || pathname === "/api/issues" || /^\/api\/jobs\/[^/]+\/cancel$/.test(pathname))) {
          throw new HttpError(403, "AI jobs are disabled while target scripts are allowed");
        }
        const legacyUi = options.legacyUi === true || process.env.VISUAL_REVIEW_LEGACY_UI === "1";
        if (request.method === "GET" && pathname === "/") return serveFile(response, path.join(uiRoot, legacyUi ? "index.html" : "renderer.html"));
        if (request.method === "GET" && pathname === "/legacy") return serveFile(response, path.join(uiRoot, "index.html"));
        if (request.method === "GET" && pathname === "/api/plugin-host/v1/surfaces/review") {
          return sendJson(response, 200, { ...loadPluginUiSurface(store.target.projectRoot), page: { title: store.entryPath } });
        }
        const browserModule = /^\/api\/plugin-host\/v1\/plugins\/([a-z0-9._-]+)\/ui-modules\/([a-z][a-z0-9-]{0,62})$/.exec(pathname);
        if (request.method === "GET" && browserModule?.[1] && browserModule[2]) {
          try { return serveFile(response, resolvePluginBrowserModule(browserModule[1], browserModule[2], store.target.projectRoot)); }
          catch { throw new HttpError(404, "plugin UI runtime is unavailable"); }
        }
        const bridgeQuery = /^\/api\/plugin-host\/v1\/plugins\/([a-z0-9._-]+)\/queries\/([a-z][a-z0-9_.-]*)$/.exec(pathname);
        if (request.method === "POST" && bridgeQuery?.[1] && bridgeQuery[2]) {
          if (!aiJobsEnabled && isBundledAiBridgeOperation(bridgeQuery[1], bridgeQuery[2])) throw new HttpError(403, "AI operations are disabled while target scripts are allowed");
          assertBridgeRequestOrigin(request);
          const payload = await readBridgeJson(request);
          const result = await delegateBridge(bridgeAdapter(bridgeQuery[1]), "query", bridgeQuery[2], payload);
          return sendJson(response, result.ok ? 200 : bridgeStatus(result.error.code), result);
        }
        const bridgeCommand = /^\/api\/plugin-host\/v1\/plugins\/([a-z0-9._-]+)\/commands\/([a-z][a-z0-9_.-]*)$/.exec(pathname);
        if (request.method === "POST" && bridgeCommand?.[1] && bridgeCommand[2]) {
          if (!pluginEnabled("ai", store.target.projectRoot) && ((bridgeCommand[1] === "annotation-workflow" && (bridgeCommand[2] === "jobs.enqueue" || bridgeCommand[2] === "jobs.retry")) || (bridgeCommand[1] === "github-issue" && bridgeCommand[2] === "issue.draft"))) throw new HttpError(409, "AI package is disabled");
          if (!aiJobsEnabled && isBundledAiBridgeOperation(bridgeCommand[1], bridgeCommand[2])) throw new HttpError(403, "AI operations are disabled while target scripts are allowed");
          assertBridgeRequestOrigin(request);
          const payload = await readBridgeJson(request);
          const idempotencyKey = typeof payload.idempotency_key === "string" && payload.idempotency_key ? `${bridgeCommand[1]}:${payload.idempotency_key}` : null;
          const payloadHash = JSON.stringify({ name: bridgeCommand[2], input: payload.input, expected_revision: payload.expected_revision ?? null });
          let operation: Promise<BridgeAdapterResult>;
          const recorded = idempotencyKey ? commandJournal.get(idempotencyKey) : undefined;
          if (recorded && recorded.payload !== payloadHash) operation = Promise.resolve(bridgeError(payload, "CONFLICT", "idempotency key was reused with a different payload"));
          else if (recorded) operation = recorded.result;
          else {
            operation = delegateBridge(bridgeAdapter(bridgeCommand[1]), "command", bridgeCommand[2], payload).then(publishEffects);
            if (idempotencyKey) {
              commandJournal.set(idempotencyKey, { payload: payloadHash, result: operation, at: Date.now() });
              if (commandJournal.size > 10_000) commandJournal.delete(commandJournal.keys().next().value as string);
            }
          }
          const result = await operation;
          return sendJson(response, result.ok ? 200 : bridgeStatus(result.error.code), result);
        }
        const bridgeEvents = /^\/api\/plugin-host\/v1\/plugins\/([a-z0-9._-]+)\/events$/.exec(pathname);
        if (request.method === "GET" && bridgeEvents?.[1]) return serveBridgeEvents(request, response, bridgeEvents[1], store.target.projectRoot, bridgeEventHub);
        if (request.method === "GET" && pathname === "/settings") return serveFile(response, path.join(uiRoot, "renderer.html"));
        if (request.method === "GET" && pathname === "/api/settings/layout") {
          const settings = readLayoutSettings(store.target.projectRoot);
          return sendJson(response, 200, { revision: layoutSettingsRevision(settings), settings, features: { plugin_management: pluginManagementVisible } });
        }
        if (request.method === "PUT" && pathname === "/api/settings/layout") {
          const payload = await readJson(request);
          if (typeof payload.revision !== "string") throw new HttpError(400, "layout settings update is invalid");
          try {
            const updated = updateLayoutSettings(payload as unknown as LayoutSettingsUpdateInput, store.target.projectRoot);
            return sendJson(response, 200, { revision: updated.revision, settings: updated.settings, features: { plugin_management: pluginManagementVisible } });
          } catch (error) {
            if (error instanceof Error && error.message === "layout settings revision conflict") throw new HttpError(409, error.message);
            throw error;
          }
        }
        if (pathname.startsWith("/settings/") || pathname.startsWith("/api/settings/plugins")) {
          if (!pluginManagementVisible) throw new HttpError(404, "plugin management is hidden by workspace settings");
          if (request.method === "GET" && pathname === "/settings/plugins") return serveFile(response, legacyUi ? path.join(settingsUiRoot, "index.html") : path.join(uiRoot, "renderer.html"));
          if (request.method === "GET" && pathname === "/settings/legacy") return serveFile(response, path.join(settingsUiRoot, "index.html"));
          if (request.method === "GET" && ["/settings/settings.css", "/settings/settings.js"].includes(pathname)) {
            return serveFile(response, path.join(settingsUiRoot, path.basename(pathname)));
          }
          if (request.method === "GET" && pathname === "/api/settings/plugins") return sendJson(response, 200, pluginManagementPayload(store.target.projectRoot));
          if (request.method === "POST" && pathname === "/api/settings/plugins") {
            const payload = await readJson(request);
            if (typeof payload.source !== "string" || !payload.source.length || payload.source.length > 2048) throw new HttpError(400, "plugin source is invalid");
            let installed: Awaited<ReturnType<typeof installPlugin>>;
            try {
              installed = await installPlugin(payload.source, store.target.projectRoot);
            } catch (error) {
              const message = error instanceof Error ? error.message : "plugin install failed";
              throw new HttpError(message.startsWith("plugin is already installed") ? 409 : 400, message);
            }
            // Newly installed third-party plugins never auto-enable from the HTTP install route,
            // even when the default effective state (with no workspace override) is enabled.
            // Retry a few times if another request updates plugin settings concurrently.
            for (let attempt = 0; attempt < 5; attempt += 1) {
              const effective = effectivePluginSettings(installed.plugin.manifest, store.target.projectRoot);
              if (!effective.enabled) break;
              const settings = readPluginSettings(store.target.projectRoot);
              try {
                updatePluginSettings(installed.plugin.id, installed.plugin.manifest, { revision: pluginSettingsRevision(settings), enabled: false, configuration: {} }, store.target.projectRoot);
                break;
              } catch (error) {
                if (!(error instanceof Error) || error.message !== "plugin settings revision conflict" || attempt === 4) throw error;
              }
            }
            await reconcilePackagePluginHost();
            return sendJson(response, 201, {
              installed: {
                id: installed.plugin.id,
                version: installed.plugin.version,
                source: installed.plugin.source,
                resolved: installed.plugin.resolved ?? null,
                warnings: installed.warnings,
              },
              ...pluginManagementPayload(store.target.projectRoot),
            });
          }
          const removeMatch = /^\/api\/settings\/plugins\/([a-z0-9._-]+)$/.exec(pathname);
          if (request.method === "DELETE" && removeMatch?.[1]) {
            const plugin: InstalledPlugin | undefined = listPlugins(store.target.projectRoot).find(({ id }) => id === removeMatch[1]);
            if (!plugin) throw new HttpError(404, "plugin not found");
            if (isBundledPluginSource(plugin.source)) throw new HttpError(409, "bundled plugin cannot be removed; disable it instead");
            removePlugin(plugin.id, store.target.projectRoot);
            await reconcilePackagePluginHost();
            return sendJson(response, 200, pluginManagementPayload(store.target.projectRoot));
          }
          const readmeMatch = /^\/api\/settings\/plugins\/([a-z0-9._-]+)\/readme$/.exec(pathname);
          if (request.method === "GET" && readmeMatch?.[1]) return sendJson(response, 200, { readme: readInstalledPluginReadme(readmeMatch[1], store.target.projectRoot) });
          const updateMatch = /^\/api\/settings\/plugins\/([a-z0-9._-]+)$/.exec(pathname);
          if (request.method === "PUT" && updateMatch?.[1]) {
            const plugin = listPlugins(store.target.projectRoot).find(({ id }) => id === updateMatch[1]);
            if (!plugin) throw new HttpError(404, "plugin not found");
            const payload = await readJson(request);
            if (typeof payload.revision !== "string" || typeof payload.enabled !== "boolean" || typeof payload.configuration !== "object" || payload.configuration === null || Array.isArray(payload.configuration)) throw new HttpError(400, "plugin settings update is invalid");
            const previousEntry = readPluginSettings(store.target.projectRoot).plugins[plugin.id];
            let updateResult: ReturnType<typeof updatePluginSettings>;
            try {
              updateResult = updatePluginSettings(plugin.id, plugin.manifest, { revision: payload.revision, enabled: payload.enabled, configuration: payload.configuration as Record<string, unknown> }, store.target.projectRoot);
            } catch (error) {
              if (error instanceof Error && error.message === "plugin settings revision conflict") throw new HttpError(409, error.message);
              throw error;
            }
            if (payload.enabled === true && plugin.manifest.storage_provider) {
              try {
                await verifyStorageProviderConnectivity(plugin.id, store.target.projectRoot, storagePreflightTimeoutMs);
              } catch (error) {
                const message = error instanceof Error ? error.message : "unknown error";
                try {
                  updatePluginSettings(
                    plugin.id,
                    plugin.manifest,
                    {
                      revision: updateResult.revision,
                      enabled: previousEntry?.enabled ?? false,
                      configuration: previousEntry?.configuration ?? {},
                    },
                    store.target.projectRoot,
                  );
                } catch (rollbackError) {
                  const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : "unknown error";
                  throw new HttpError(500, `storageバックエンドへの接続確認に失敗し、さらに設定のロールバックにも失敗しました: ${rollbackMessage}`);
                }
                throw new HttpError(
                  409,
                  `ストレージbackendへ接続できないため有効化できません: ${message} 認証情報や設定を登録してから再度有効にしてください。`,
                );
              }
            }
            if (plugin.id === "annotation-workflow") {
              if (payload.enabled && aiJobsEnabled) await jobManager.start();
              else await jobManager.close();
            }
            await reconcilePackagePluginHost();
            return sendJson(response, 200, pluginManagementPayload(store.target.projectRoot));
          }
          const credentialMatch = /^\/api\/settings\/plugins\/([a-z0-9._-]+)\/credentials\/([a-z][a-z0-9_]{0,63})$/.exec(pathname);
          if (credentialMatch?.[1] && credentialMatch[2]) {
            const plugin = listPlugins(store.target.projectRoot).find(({ id }) => id === credentialMatch[1]);
            if (!plugin) throw new HttpError(404, "plugin not found");
            const field = (plugin.manifest.configuration ?? []).find((candidate) => candidate.key === credentialMatch[2] && candidate.source === "credential");
            if (!field) throw new HttpError(404, "credential field not declared");
            if (request.method === "PUT") {
              const payload = await readJson(request);
              if (typeof payload.value !== "string") throw new HttpError(400, "credential value must be a string");
              if (Buffer.byteLength(payload.value, "utf8") > 64 * 1024) throw new HttpError(400, "credential value is too large");
              if (/\u0000/.test(payload.value)) throw new HttpError(400, "credential value must not contain NUL characters");
              if (field.format === "json") {
                let parsed: unknown;
                try { parsed = JSON.parse(payload.value); } catch { throw new HttpError(400, "credential value must be valid JSON"); }
                if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HttpError(400, "credential value must be a JSON object");
              }
              setPluginCredential(plugin.id, field.key, payload.value, store.target.projectRoot);
              await reconcilePackagePluginHost();
              return sendJson(response, 200, pluginManagementPayload(store.target.projectRoot));
            }
            if (request.method === "DELETE") {
              deletePluginCredential(plugin.id, field.key, store.target.projectRoot);
              await reconcilePackagePluginHost();
              return sendJson(response, 200, pluginManagementPayload(store.target.projectRoot));
            }
          }
          const storageTransferMatch = /^\/api\/settings\/plugins\/([a-z0-9._-]+)\/storage-transfer$/.exec(pathname);
          if (request.method === "POST" && storageTransferMatch?.[1]) {
            const plugin = listPlugins(store.target.projectRoot).find(({ id }) => id === storageTransferMatch[1]);
            if (!plugin) throw new HttpError(404, "plugin not found");
            if (!plugin.manifest.storage_provider) throw new HttpError(404, "plugin does not declare a storage provider");
            const payload = await readJson(request);
            if (
              (payload.direction !== "local-to-plugin" && payload.direction !== "plugin-to-local")
              || typeof payload.dry_run !== "boolean"
            ) throw new HttpError(400, "storage transfer request is invalid");
            const direction = payload.direction as "local-to-plugin" | "plugin-to-local";
            let pluginProvider: WorkspaceStorageProviderV1;
            try {
              pluginProvider = (await loadWorkspaceStorageProviderV1(plugin.id, store.target.projectRoot)).provider;
            } catch (error) {
              const message = error instanceof Error ? error.message : "plugin storage provider is unavailable";
              throw new HttpError(409, message);
            }
            const localProvider = createLocalWorkspaceStorageProvider(store.target.projectRoot);
            const prefix = "reviews/";
            let result: StorageTransferResult;
            try {
              result = await transferWorkspaceStorage({
                source: direction === "local-to-plugin" ? localProvider : pluginProvider,
                destination: direction === "local-to-plugin" ? pluginProvider : localProvider,
                prefix,
                direction,
                dryRun: payload.dry_run,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : "unknown error";
              throw new HttpError(502, `storage transfer failed: ${message}`);
            }
            return sendJson(response, 200, {
              direction: result.direction,
              dry_run: result.dry_run,
              written: result.written.slice(0, 200),
              written_total: result.written.length,
              deleted: result.deleted.slice(0, 200),
              deleted_total: result.deleted.length,
              unchanged: result.unchanged,
            });
          }
          throw new HttpError(404, "route not found");
        }
        if (request.method === "GET" && ["/renderer.css", "/renderer.js", "/reviewer.css", "/reviewer.js", "/jobs.js"].includes(pathname)) {
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
            review: await store.loadActive(),
            features: { plugin_management: pluginManagementVisible },
          });
        }
        if (request.method === "GET" && pathname === "/api/archive") {
          const offset = Number(url.searchParams.get("offset") ?? "0");
          const limit = Number(url.searchParams.get("limit") ?? "24");
          if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, "offset must be a nonnegative integer");
          if (!Number.isInteger(limit) || limit < 1 || limit > 24) throw new HttpError(400, "limit must be an integer from 1 to 24");
          const review = await store.load();
          const history = [...review.events].sort((left, right) => (
            Date.parse(right.at) - Date.parse(left.at)
            || right.revision - left.revision
          ));
          const resolved = review.annotations.filter(({ status }) => status === "resolved");
          return sendJson(response, 200, {
            annotations: resolved,
            annotation_total: resolved.length,
            events: history.slice(offset, offset + limit),
            history_total: history.length,
            revision: review.revision,
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
        if (request.method === "GET" && pathname === "/api/plugins/annotation-flow") {
          const installed = listPlugins(store.target.projectRoot).find(({ id }) => id === "annotation-workflow");
          const customCommandEnabled = pluginEnabled("ai", store.target.projectRoot);
          if (!installed) return sendJson(response, 200, { enabled: false, reason: "not-installed", policy: null, custom_command_enabled: customCommandEnabled });
          if (!pluginEnabled("annotation-workflow", store.target.projectRoot)) {
            return sendJson(response, 200, { enabled: false, reason: "disabled", policy: null, custom_command_enabled: customCommandEnabled });
          }
          const { policy } = await loadTrustedPluginAnnotationFlowProvider(
            "annotation-workflow",
            bundledAnnotationWorkflowRoot(),
            store.target.projectRoot,
          );
          return sendJson(response, 200, { enabled: true, reason: null, policy, custom_command_enabled: customCommandEnabled });
        }
        if (pathname.startsWith("/api/jobs") && !pluginEnabled("annotation-workflow", store.target.projectRoot)) {
          throw new HttpError(409, "annotation workflow plugin is disabled");
        }
        if (request.method === "GET" && pathname === "/api/jobs") {
          const state = await jobManager.list();
          return sendJson(response, 200, {
            ...state,
            batches: state.batches.map(({ custom_command: _legacyTemplate, ...batch }) => batch),
            jobs: state.jobs.map(({ custom_name: _legacyName, ...job }) => job),
          });
        }
        if ((request.method === "GET" || request.method === "POST" || request.method === "DELETE") && pathname.startsWith("/api/jobs/custom-commands")
          && !pluginEnabled("ai", store.target.projectRoot)) throw new HttpError(409, "AI package is disabled");
        if (request.method === "GET" && pathname === "/api/jobs/custom-commands") {
          return sendJson(response, 200, { runners: (await customCommandProvider()).list(store.target.projectRoot) });
        }
        if (request.method === "POST" && pathname === "/api/jobs/custom-commands") {
          assertBridgeRequestOrigin(request);
          const input = await readJson(request);
          if (typeof input.name !== "string" || typeof input.command !== "string") throw new HttpError(400, "name and command must be strings");
          return sendJson(response, 201, await (await customCommandProvider()).add(store.target.projectRoot, input.name, input.command));
        }
        const customRunnerMatch = /^\/api\/jobs\/custom-commands\/([^/]+)$/.exec(pathname);
        const customRunnerTestMatch = /^\/api\/jobs\/custom-commands\/([^/]+)\/test$/.exec(pathname);
        if (request.method === "POST" && customRunnerTestMatch?.[1]) {
          assertBridgeRequestOrigin(request);
          const result = await (await customCommandProvider()).test(store.target.projectRoot, decodeURIComponent(customRunnerTestMatch[1]));
          return sendJson(response, 200, { ok: true, ...result });
        }
        if (request.method === "DELETE" && customRunnerMatch?.[1]) {
          assertBridgeRequestOrigin(request);
          (await customCommandProvider()).remove(store.target.projectRoot, decodeURIComponent(customRunnerMatch[1]));
          return sendJson(response, 200, { ok: true });
        }
        if (request.method === "POST" && pathname === "/api/jobs/batch") {
          if (!pluginEnabled("ai", store.target.projectRoot)) throw new HttpError(409, "AI package is disabled");
          const input = await readJson(request);
          const result = await jobManager.enqueue(input);
          bridgeEventHub.publish(["jobs", "annotations", "history", "session"]);
          return sendJson(response, 200, result);
        }
        if (request.method === "POST" && pathname === "/api/jobs/custom-command/test") {
          throw new HttpError(404, "route not found");
        }
        if (request.method === "POST" && pathname === "/api/issues/request") {
          const installed = listPlugins(store.target.projectRoot).some(({ id }) => id === "github-issue");
          if (installed && !pluginEnabled("github-issue", store.target.projectRoot)) throw new HttpError(409, "GitHub Issue plugin is disabled");
          const payload = await readJson(request);
          await store.createIssueRequest(payload as unknown as CreateAnnotationInput);
          bridgeEventHub.publish(["session", "annotations", "history"]);
          return sendJson(response, 200, await store.loadActive());
        }
        if (request.method === "POST" && pathname === "/api/issues") {
          const installed = listPlugins(store.target.projectRoot).some(({ id }) => id === "github-issue");
          if (installed && !pluginEnabled("github-issue", store.target.projectRoot)) throw new HttpError(409, "GitHub Issue plugin is disabled");
          const payload = await readJson(request);
          if (typeof payload.annotation_id !== "string" || !payload.annotation_id) throw new HttpError(400, "annotation_id is required");
          let result: PluginIssueResult & { review?: unknown };
          try { result = await issueTask.create(payload.annotation_id, payload); }
          catch (error) {
            if (isAnnotationMissing(error)) throw new HttpError(404, (error as Error).message);
            if (error instanceof Error && error.message === "Issue draft is not ready for creation") throw new HttpError(409, error.message);
            throw error;
          }
          bridgeEventHub.publish(["session", "annotations", "history"]);
          return sendJson(response, 200, result);
        }
        const cancelId = request.method === "POST" ? jobId(pathname) : undefined;
        if (cancelId !== undefined) {
          const { custom_name: _legacyName, ...job } = await jobManager.cancel(cancelId);
          bridgeEventHub.publish(["jobs", "annotations", "history", "session"]);
          return sendJson(response, 200, job);
        }
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
          await store.createAnnotation(await readJson(request) as unknown as CreateAnnotationInput);
          bridgeEventHub.publish(["session", "annotations", "history"]);
          return sendJson(response, 200, await store.loadActive());
        }
        const messageId = request.method === "POST" ? annotationId(pathname, "/messages") : undefined;
        if (messageId !== undefined) {
          await store.addMessage(messageId, await readJson(request) as unknown as AddMessageInput);
          bridgeEventHub.publish(["session", "annotations", "history"]);
          return sendJson(response, 200, await store.loadActive());
        }
        const statusId = request.method === "PATCH" ? annotationId(pathname) : undefined;
        if (statusId !== undefined) {
          await store.setStatus(statusId, await readJson(request) as unknown as SetStatusInput);
          bridgeEventHub.publish(["session", "annotations", "history"]);
          return sendJson(response, 200, await store.loadActive());
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
  let stopBundledPromise: Promise<void> | undefined;
  const stopBundledAdapters = (): Promise<void> => {
    stopBundledPromise ??= Promise.all([...bundledBridgeCatalog.values()].map((adapter) => adapter.stop?.())).then(() => undefined);
    return stopBundledPromise;
  };
  const stopPackagePluginHost = async (): Promise<void> => {
    await packageHostReconciliation.catch(() => undefined);
    await packagePluginHost.stop();
  };
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = async (): Promise<void> => {
    shutdownPromise ??= Promise.all([jobManager.close(), stopPackagePluginHost(), stopBundledAdapters()]).then(() => undefined).finally(() => lease.release());
    await shutdownPromise;
  };
  server.once("close", () => { void shutdown(); });
  const close = async (): Promise<void> => {
    const stoppingAdapters = stopBundledAdapters();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await stoppingAdapters;
    await shutdown();
  };
  return { server, store, jobManager, uiRoot, lease, close };
}
