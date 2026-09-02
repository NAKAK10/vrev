import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type PluginSourceGitHost = "github" | "gitlab" | "bitbucket" | "gist" | "url";

export type ParsedPluginSource =
  | { kind: "local"; path: string }
  | { kind: "npm"; spec: string; name: string; range: string | null; pinned: boolean }
  | { kind: "git"; spec: string; host: PluginSourceGitHost; ref: string | null; pinned: boolean; warnings: string[] };

const NPM_EXACT_VERSION = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const GIT_SCHEME_PREFIX = /^(?:git\+|git:\/\/|ssh:\/\/|github:|gitlab:|bitbucket:|gist:)/i;
const EXPLICIT_GIT_PREFIX = /^(github:|gitlab:|bitbucket:|gist:)/i;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/**
 * Rejects control characters, blank values, and credentials embedded in URL
 * userinfo or credential-shaped query parameters. Shared by every source kind.
 */
export function validateSourceSyntax(source: string): void {
  if (!source.trim() || source !== source.trim() || /[\0-\x1f\x7f]/.test(source)) throw new Error("plugin source must be a nonblank value without control characters");
  const candidate = source.replace(/^git\+/, "");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    let url: URL;
    try { url = new URL(candidate); } catch { throw new Error("plugin source URL is invalid"); }
    if (url.username || url.password) throw new Error("plugin source URL must not contain credentials");
    for (const key of url.searchParams.keys()) {
      if (/(?:auth|token|secret|password|api[-_]?key)/i.test(key)) throw new Error("plugin source URL must not contain credential parameters");
    }
  }
}

function isRelativeMarker(candidate: string): boolean {
  return candidate.startsWith("./") || candidate.startsWith("../") || candidate.startsWith("~/") || WINDOWS_DRIVE.test(candidate);
}

function resolveLocalCandidate(candidate: string, cwd: string): string {
  return candidate.startsWith("~/") ? path.resolve(os.homedir(), candidate.slice(2)) : path.resolve(cwd, candidate);
}

function splitRef(spec: string): [string, string | null] {
  const index = spec.indexOf("#");
  if (index < 0) return [spec, null];
  const ref = spec.slice(index + 1);
  return [spec.slice(0, index), ref || null];
}

function isGitHubShorthand(spec: string): boolean {
  const [withoutRef] = splitRef(spec);
  if (withoutRef.startsWith("@")) return false;
  const parts = withoutRef.split("/");
  if (parts.length !== 2) return false;
  return parts.every((part) => part && part !== "." && part !== ".." && /^[A-Za-z0-9._-]+$/.test(part));
}

function detectGitHost(spec: string, explicitPrefix: string | null): PluginSourceGitHost {
  if (explicitPrefix === "github:") return "github";
  if (explicitPrefix === "gitlab:") return "gitlab";
  if (explicitPrefix === "bitbucket:") return "bitbucket";
  if (explicitPrefix === "gist:") return "gist";
  try {
    const url = new URL(spec.replace(/^git\+/i, ""));
    const host = url.hostname.toLowerCase();
    if (host === "github.com") return "github";
    if (host === "gitlab.com") return "gitlab";
    if (host === "bitbucket.org") return "bitbucket";
    if (host === "gist.github.com") return "gist";
  } catch {
    // Not a URL, e.g. an scp-like ssh reference or a GitHub shorthand spec.
  }
  return "url";
}

function parseGitSource(source: string): (ParsedPluginSource & { kind: "git" }) | null {
  const explicitPrefixMatch = EXPLICIT_GIT_PREFIX.exec(source);
  const explicitPrefix = explicitPrefixMatch ? explicitPrefixMatch[0].toLowerCase() : null;
  let isGit = GIT_SCHEME_PREFIX.test(source);
  if (!isGit && /^https?:\/\//i.test(source)) {
    try {
      const url = new URL(source);
      isGit = ["github.com", "gitlab.com", "bitbucket.org"].includes(url.hostname.toLowerCase());
    } catch {
      isGit = false;
    }
  }
  const isShorthand = !isGit && isGitHubShorthand(source);
  if (isShorthand) isGit = true;
  if (!isGit) return null;
  const [, ref] = splitRef(source);
  if (ref === null) throw new Error(`git plugin source must pin a tag or commit SHA with #<ref>: ${source}`);
  const host = isShorthand ? "github" : detectGitHost(source, explicitPrefix);
  return { kind: "git", spec: source, host, ref, pinned: true, warnings: [] };
}

function parseNpmSource(source: string): ParsedPluginSource & { kind: "npm" } {
  let name: string;
  let range: string | null;
  if (source.startsWith("@")) {
    const at = source.indexOf("@", 1);
    if (at < 0) { name = source; range = null; } else { name = source.slice(0, at); range = source.slice(at + 1) || null; }
  } else {
    const at = source.indexOf("@");
    if (at < 0) { name = source; range = null; } else { name = source.slice(0, at); range = source.slice(at + 1) || null; }
  }
  const pinned = range !== null && NPM_EXACT_VERSION.test(range);
  return { kind: "npm", spec: source, name, range, pinned };
}

/**
 * Classifies an install source into local/npm/git without touching the network
 * or executing anything. `file:` is only treated as a local shorthand when it is
 * followed by an explicit relative marker (`./`, `../`, `~/`, a drive letter); a
 * bare `file:/absolute/path` is npm's own protocol form and is left for `npm pack`.
 */
export function parsePluginSource(source: string, cwd: string): ParsedPluginSource {
  validateSourceSyntax(source);
  const fileStripped = source.startsWith("file:") ? source.slice(5) : null;
  let localRaw: string | null = null;
  if (fileStripped !== null && isRelativeMarker(fileStripped)) localRaw = fileStripped;
  else if (isRelativeMarker(source) || source.startsWith("/")) localRaw = source;
  if (localRaw !== null) {
    const resolved = resolveLocalCandidate(localRaw, cwd);
    if (!existsSync(resolved)) throw new Error(`local plugin path does not exist: ${resolved}`);
    return { kind: "local", path: resolved };
  }
  const fallbackResolved = path.resolve(cwd, source);
  if (existsSync(fallbackResolved)) return { kind: "local", path: fallbackResolved };
  const git = parseGitSource(source);
  if (git) return git;
  return parseNpmSource(source);
}
