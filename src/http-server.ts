import { lookup as dnsLookup } from "node:dns/promises";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createBundledBridgeCatalog, type BundledBridgeAdapter } from "./bundled-plugin-catalog.js";
import { fileSha256 } from "./file-utils.js";
import { createIssueTaskCapability, type GitHubIssueDraft } from "./github-issue.js";
import { JobManager, type JobManagerOptions } from "./job-manager.js";
import { resolveTarget } from "./paths.js";
import { installedPluginDirectory, listPlugins } from "./plugin-registry.js";
import { loadPluginCustomCommandProvider, loadPluginIssueProvider, loadTrustedPluginAnnotationFlowProvider, type PluginIssueResult } from "./plugin-runtime.js";
import { effectivePluginSettings, pluginSettingsRevision, readPluginSettings, updatePluginSettings } from "./plugin-settings.js";
import { createReviewCapability } from "./review-capability.js";
import type { ReviewStore } from "./review-store.js";
import { loadPluginUiSurface, resolvePluginBrowserModule } from "./plugin-ui-surface.js";
import { acquireServerLease, type ServerLease } from "./server-lease.js";
import type { AddMessageInput, CreateAnnotationInput, SetStatusInput } from "./types.js";
import { loadWorkspaceSettings } from "./workspace-settings.js";

export const MAX_REQUEST_BODY = 1024 * 1024;
export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

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

export interface VisualReviewServerOptions {
  projectRoot: string;
  projectDirectory?: string;
  target: string;
  allowScripts?: boolean;
  allowAiJobsWithScripts?: boolean;
  jobManager?: JobManagerOptions;
  issueCreator?: (draft: GitHubIssueDraft) => Promise<PluginIssueResult>;
  /** One-beta rollback switch. Declarative UI is the default. */
  legacyUi?: boolean;
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
    if (!host || origin !== `http://${host}`) throw new HttpError(403, "plugin bridge origin is not allowed");
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

function serveBridgeEvents(request: IncomingMessage, response: ServerResponse, pluginId: string, projectRoot: string): void {
  if (!pluginEnabled(pluginId, projectRoot)) throw new HttpError(404, "plugin event stream is unavailable");
  setSecurityHeaders(response);
  response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
  response.write(`id: host:0\ndata: ${JSON.stringify({ protocol: "plugin-bridge/1", event_id: "host:0", seq: 0, plugin_id: pluginId, type: "resync.required", resources: [] })}\n\n`);
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 20_000);
  heartbeat.unref();
  request.once("close", () => clearInterval(heartbeat));
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

function pluginManagementPayload(projectRoot: string): object {
  const settings = readPluginSettings(projectRoot);
  return {
    revision: pluginSettingsRevision(settings),
    plugins: listPlugins(projectRoot).map(({ id, version, manifest }) => {
      const effective = effectivePluginSettings(manifest, projectRoot);
      const configuration = (manifest.configuration ?? []).map((field) => ({
        ...field,
        ...(field.source === "environment" ? { present: Boolean(field.environment && process.env[field.environment]) } : {}),
        value: field.source === "workspace" ? effective.configuration[field.key] ?? null : null,
      }));
      return {
        id,
        version,
        title: manifest.display?.title ?? id,
        summary: manifest.display?.summary ?? `Visual Review plugin: ${id}`,
        capabilities: pluginCapabilities(manifest),
        enabled: effective.enabled,
        missing: effective.missing,
        configuration,
        has_readme: Boolean(manifest.display?.readme ?? existsSync(path.join(installedPluginDirectory(id, projectRoot), "README.md"))),
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
      throw new Error("GitHub Issue provider plugin 'github-issue' is not installed. Install it with: visual-review plugin install @nakak10/visual-review-plugin-github-issue");
    }
    throw error;
  }
}

export function assertLoopbackHost(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) throw new Error("host must be 127.0.0.1 or ::1");
}

export function createVisualReviewServer(options: VisualReviewServerOptions): VisualReviewServer {
  // Deprecated HTTP routes are transport adapters over the review plugin capability.
  const reviewCapability = createReviewCapability(options.target, {
    projectRoot: options.projectRoot,
    ...(options.projectDirectory ? { projectDirectory: options.projectDirectory } : {}),
  });
  const store = reviewCapability.store;
  const customCommandProvider = async () => (await loadPluginCustomCommandProvider("custom-command", store.target.projectRoot)).provider;
  const jobManager = new JobManager(store, {
    ...options.jobManager,
    customCommandResolver: async (runnerId) => (await customCommandProvider()).resolve(store.target.projectRoot, runnerId),
  });
  const issueCreator = options.issueCreator ?? ((draft: GitHubIssueDraft) => createIssueWithInstalledPlugin(store.target.projectRoot, draft));
  const issueTask = createIssueTaskCapability(
    { apiVersion: 1, store },
    { provider: { createIssue: (_projectRoot, draft) => issueCreator(draft) } },
  );
  const commandJournal = new Map<string, { payload: string; result: Promise<BridgeAdapterResult>; at: number }>();
  const uiRoot = defaultUiRoot();
  const settingsUiRoot = pluginSettingsUiRoot();
  const pluginManagementVisible = loadWorkspaceSettings(store.target.projectRoot).ui?.plugin_management === true;
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
    customCommands: customCommandProvider,
    issueTask,
    allowScripts,
    aiJobsEnabled,
    pluginManagementVisible,
  });
  const bridgeAdapter = (pluginId: string): BundledBridgeAdapter | undefined =>
    pluginEnabled(pluginId, store.target.projectRoot) ? bundledBridgeCatalog.get(pluginId) : undefined;
  try {
    if (aiJobsEnabled && pluginEnabled("annotation-workflow", store.target.projectRoot)) jobManager.start();
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
          return sendJson(response, 200, loadPluginUiSurface(store.target.projectRoot));
        }
        const browserModule = /^\/api\/plugin-host\/v1\/plugins\/([a-z0-9._-]+)\/ui-modules\/([a-z][a-z0-9-]{0,62})$/.exec(pathname);
        if (request.method === "GET" && browserModule?.[1] && browserModule[2]) {
          try { return serveFile(response, resolvePluginBrowserModule(browserModule[1], browserModule[2], store.target.projectRoot)); }
          catch { throw new HttpError(404, "plugin UI runtime is unavailable"); }
        }
        const bridgeQuery = /^\/api\/plugin-host\/v1\/plugins\/([a-z0-9._-]+)\/queries\/([a-z][a-z0-9_.-]*)$/.exec(pathname);
        if (request.method === "POST" && bridgeQuery?.[1] && bridgeQuery[2]) {
          assertBridgeRequestOrigin(request);
          const payload = await readBridgeJson(request);
          const result = await delegateBridge(bridgeAdapter(bridgeQuery[1]), "query", bridgeQuery[2], payload);
          return sendJson(response, result.ok ? 200 : bridgeStatus(result.error.code), result);
        }
        const bridgeCommand = /^\/api\/plugin-host\/v1\/plugins\/([a-z0-9._-]+)\/commands\/([a-z][a-z0-9_.-]*)$/.exec(pathname);
        if (request.method === "POST" && bridgeCommand?.[1] && bridgeCommand[2]) {
          assertBridgeRequestOrigin(request);
          const payload = await readBridgeJson(request);
          const idempotencyKey = typeof payload.idempotency_key === "string" && payload.idempotency_key ? `${bridgeCommand[1]}:${payload.idempotency_key}` : null;
          const payloadHash = JSON.stringify({ name: bridgeCommand[2], input: payload.input, expected_revision: payload.expected_revision ?? null });
          let operation: Promise<BridgeAdapterResult>;
          const recorded = idempotencyKey ? commandJournal.get(idempotencyKey) : undefined;
          if (recorded && recorded.payload !== payloadHash) operation = Promise.resolve(bridgeError(payload, "CONFLICT", "idempotency key was reused with a different payload"));
          else if (recorded) operation = recorded.result;
          else {
            operation = delegateBridge(bridgeAdapter(bridgeCommand[1]), "command", bridgeCommand[2], payload);
            if (idempotencyKey) {
              commandJournal.set(idempotencyKey, { payload: payloadHash, result: operation, at: Date.now() });
              if (commandJournal.size > 10_000) commandJournal.delete(commandJournal.keys().next().value as string);
            }
          }
          const result = await operation;
          return sendJson(response, result.ok ? 200 : bridgeStatus(result.error.code), result);
        }
        const bridgeEvents = /^\/api\/plugin-host\/v1\/plugins\/([a-z0-9._-]+)\/events$/.exec(pathname);
        if (request.method === "GET" && bridgeEvents?.[1]) return serveBridgeEvents(request, response, bridgeEvents[1], store.target.projectRoot);
        if (pathname.startsWith("/settings/") || pathname.startsWith("/api/settings/plugins")) {
          if (!pluginManagementVisible) throw new HttpError(404, "plugin management is hidden by workspace settings");
          if (request.method === "GET" && pathname === "/settings/plugins") return serveFile(response, legacyUi ? path.join(settingsUiRoot, "index.html") : path.join(uiRoot, "renderer.html"));
          if (request.method === "GET" && pathname === "/settings/legacy") return serveFile(response, path.join(settingsUiRoot, "index.html"));
          if (request.method === "GET" && ["/settings/settings.css", "/settings/settings.js"].includes(pathname)) {
            return serveFile(response, path.join(settingsUiRoot, path.basename(pathname)));
          }
          if (request.method === "GET" && pathname === "/api/settings/plugins") return sendJson(response, 200, pluginManagementPayload(store.target.projectRoot));
          const readmeMatch = /^\/api\/settings\/plugins\/([a-z0-9._-]+)\/readme$/.exec(pathname);
          if (request.method === "GET" && readmeMatch?.[1]) return sendJson(response, 200, { readme: readInstalledPluginReadme(readmeMatch[1], store.target.projectRoot) });
          const updateMatch = /^\/api\/settings\/plugins\/([a-z0-9._-]+)$/.exec(pathname);
          if (request.method === "PUT" && updateMatch?.[1]) {
            const plugin = listPlugins(store.target.projectRoot).find(({ id }) => id === updateMatch[1]);
            if (!plugin) throw new HttpError(404, "plugin not found");
            const payload = await readJson(request);
            if (typeof payload.revision !== "string" || typeof payload.enabled !== "boolean" || typeof payload.configuration !== "object" || payload.configuration === null || Array.isArray(payload.configuration)) throw new HttpError(400, "plugin settings update is invalid");
            try {
              updatePluginSettings(plugin.id, plugin.manifest, { revision: payload.revision, enabled: payload.enabled, configuration: payload.configuration as Record<string, unknown> }, store.target.projectRoot);
              if (plugin.id === "annotation-workflow") {
                if (payload.enabled && aiJobsEnabled) jobManager.start();
                else await jobManager.close();
              }
            } catch (error) {
              if (error instanceof Error && error.message === "plugin settings revision conflict") throw new HttpError(409, error.message);
              throw error;
            }
            return sendJson(response, 200, pluginManagementPayload(store.target.projectRoot));
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
            review: store.loadActive(),
            features: { plugin_management: pluginManagementVisible },
          });
        }
        if (request.method === "GET" && pathname === "/api/archive") {
          const offset = Number(url.searchParams.get("offset") ?? "0");
          const limit = Number(url.searchParams.get("limit") ?? "24");
          if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, "offset must be a nonnegative integer");
          if (!Number.isInteger(limit) || limit < 1 || limit > 24) throw new HttpError(400, "limit must be an integer from 1 to 24");
          const review = store.load();
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
          const customCommandEnabled = pluginEnabled("custom-command", store.target.projectRoot);
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
          const state = jobManager.list();
          return sendJson(response, 200, {
            ...state,
            batches: state.batches.map(({ custom_command: _legacyTemplate, ...batch }) => batch),
            jobs: state.jobs.map(({ custom_name: _legacyName, ...job }) => job),
          });
        }
        if ((request.method === "GET" || request.method === "POST" || request.method === "DELETE") && pathname.startsWith("/api/jobs/custom-commands")
          && !pluginEnabled("custom-command", store.target.projectRoot)) throw new HttpError(409, "custom command plugin is disabled");
        if (request.method === "GET" && pathname === "/api/jobs/custom-commands") {
          return sendJson(response, 200, { runners: (await customCommandProvider()).list(store.target.projectRoot) });
        }
        if (request.method === "POST" && pathname === "/api/jobs/custom-commands") {
          const input = await readJson(request);
          if (typeof input.name !== "string" || typeof input.command !== "string") throw new HttpError(400, "name and command must be strings");
          return sendJson(response, 201, await (await customCommandProvider()).add(store.target.projectRoot, input.name, input.command));
        }
        const customRunnerMatch = /^\/api\/jobs\/custom-commands\/([^/]+)$/.exec(pathname);
        const customRunnerTestMatch = /^\/api\/jobs\/custom-commands\/([^/]+)\/test$/.exec(pathname);
        if (request.method === "POST" && customRunnerTestMatch?.[1]) {
          const result = await (await customCommandProvider()).test(store.target.projectRoot, decodeURIComponent(customRunnerTestMatch[1]));
          return sendJson(response, 200, { ok: true, ...result });
        }
        if (request.method === "DELETE" && customRunnerMatch?.[1]) {
          (await customCommandProvider()).remove(store.target.projectRoot, decodeURIComponent(customRunnerMatch[1]));
          return sendJson(response, 200, { ok: true });
        }
        if (request.method === "POST" && pathname === "/api/jobs/batch") {
          const input = await readJson(request);
          if (input.cli === "custom") {
            if (!pluginEnabled("custom-command", store.target.projectRoot)) throw new HttpError(409, "custom command plugin is disabled");
            if (typeof input.runner_id !== "string") throw new HttpError(400, "runner_id is required for custom commands");
            (await customCommandProvider()).resolve(store.target.projectRoot, input.runner_id);
          }
          return sendJson(response, 200, jobManager.enqueue(input));
        }
        if (request.method === "POST" && pathname === "/api/jobs/custom-command/test") {
          throw new HttpError(404, "route not found");
        }
        if (request.method === "POST" && pathname === "/api/issues/request") {
          const installed = listPlugins(store.target.projectRoot).some(({ id }) => id === "github-issue");
          if (installed && !pluginEnabled("github-issue", store.target.projectRoot)) throw new HttpError(409, "GitHub Issue plugin is disabled");
          const payload = await readJson(request);
          store.createIssueRequest(payload as unknown as CreateAnnotationInput);
          return sendJson(response, 200, store.loadActive());
        }
        if (request.method === "POST" && pathname === "/api/issues") {
          const installed = listPlugins(store.target.projectRoot).some(({ id }) => id === "github-issue");
          if (installed && !pluginEnabled("github-issue", store.target.projectRoot)) throw new HttpError(409, "GitHub Issue plugin is disabled");
          const payload = await readJson(request);
          if (typeof payload.annotation_id !== "string" || !payload.annotation_id) throw new HttpError(400, "annotation_id is required");
          let result: PluginIssueResult;
          try { result = await issueTask.create(payload.annotation_id, payload); }
          catch (error) {
            if (isAnnotationMissing(error)) throw new HttpError(404, (error as Error).message);
            if (error instanceof Error && error.message === "Issue draft is not ready for creation") throw new HttpError(409, error.message);
            throw error;
          }
          return sendJson(response, 200, { ...result, review: store.loadActive() });
        }
        const cancelId = request.method === "POST" ? jobId(pathname) : undefined;
        if (cancelId !== undefined) {
          const { custom_name: _legacyName, ...job } = jobManager.cancel(cancelId);
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
