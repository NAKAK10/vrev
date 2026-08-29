import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import type { TargetKind } from "./types.js";

export const HTML_EXTENSIONS = new Set([".htm", ".html"]);
export const IMAGE_EXTENSIONS = new Set([
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
]);

const SENSITIVE_PREFIXES = ["credential", "secret"];

export interface ResolvedTarget {
  projectRoot: string;
  absolutePath: string;
  entryPath: string;
  kind: TargetKind;
  liveUrl?: string;
  urlMode?: "loopback" | "public";
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export function normalizeTargetUrl(value: string): { url: string; mode: "loopback" | "public" } {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("target URL must be a valid HTTP URL"); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (url.username || url.password) throw new Error("target URL must not contain credentials");
  const loopback = LOOPBACK_HOSTNAMES.has(hostname);
  if ((loopback && url.protocol !== "http:") || (!loopback && url.protocol !== "https:")) {
    throw new Error("target URL must use HTTP on loopback or HTTPS on a public host");
  }
  if (!loopback && (hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname === "metadata.google.internal")) {
    throw new Error("public target hostname is not allowed");
  }
  url.hash = "";
  return { url: url.toString(), mode: loopback ? "loopback" : "public" };
}

export function normalizeLoopbackUrl(value: string): string {
  const normalized = normalizeTargetUrl(value);
  if (normalized.mode !== "loopback") throw new Error("target URL must use HTTP on localhost, 127.0.0.1, or ::1 without credentials");
  return normalized.url;
}

export function findWorkspaceRoot(start = process.cwd()): string {
  let current = realpathSync(path.resolve(start));
  while (true) {
    if (existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return realpathSync(path.resolve(start));
    current = parent;
  }
}

export function resolveProjectRoot(projectRoot = process.cwd()): string {
  if (!path.isAbsolute(projectRoot)) {
    throw new Error("projectRoot must be absolute");
  }
  return realpathSync(projectRoot);
}

function relativeParts(relativePath: string): string[] {
  if (
    !relativePath.trim() ||
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    relativePath.includes("\\")
  ) {
    throw new Error("target path must be a repository-relative POSIX path");
  }
  const parts = relativePath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("target path contains traversal or empty components");
  }
  return parts;
}

function assertPublicParts(parts: string[]): void {
  if (
    parts.some(
      (part) =>
        part.startsWith(".") ||
        SENSITIVE_PREFIXES.some((prefix) => part.toLowerCase().startsWith(prefix)),
    )
  ) {
    throw new Error("target path contains a hidden or sensitive component");
  }
}

function assertNoSymlinks(root: string, parts: string[]): void {
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error("target path must not contain symbolic links");
    }
  }
}

export function resolveTarget(
  target: string,
  projectRoot = process.cwd(),
): ResolvedTarget {
  const root = resolveProjectRoot(projectRoot);
  if (/^https?:\/\//i.test(target)) {
    const normalized = normalizeTargetUrl(target);
    return { projectRoot: root, absolutePath: normalized.url, entryPath: normalized.url, kind: "html", liveUrl: normalized.url, urlMode: normalized.mode };
  }
  const parts = relativeParts(target);
  const extension = path.extname(parts.at(-1)!).toLowerCase();
  const kind: TargetKind = HTML_EXTENSIONS.has(extension)
    ? "html"
    : IMAGE_EXTENSIONS.has(extension)
      ? "image"
      : (() => {
          throw new Error("unsupported target extension");
        })();
  const markerIndex = kind === "html"
    ? parts.findIndex((part, index) => part === ".code" && parts[index + 1] === "htmls")
    : parts.findIndex((part) => part === "assets");
  if (markerIndex < 0) throw new Error("target is outside its configured public root");
  const prefixLength = markerIndex + (kind === "html" ? 2 : 1);
  const projectParts = parts.slice(0, markerIndex);
  assertPublicParts(projectParts);
  const publicParts = parts.slice(prefixLength);
  if (publicParts.length === 0) {
    throw new Error("target must name a file below its public root");
  }
  assertPublicParts(publicParts);
  assertNoSymlinks(root, parts);
  const absolutePath = realpathSync(path.join(root, ...parts));
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("target path is outside the project");
  }
  if (!statSync(absolutePath).isFile()) {
    throw new Error("target is not a file");
  }
  return { projectRoot: root, absolutePath, entryPath: parts.join("/"), kind };
}

export function reviewDirectoryName(entryPath: string): string {
  const stem = path.posix.parse(entryPath).name;
  const safeStem =
    stem
      .replace(/[^\p{L}\p{N}_.-]+/gu, "-")
      .replace(/^[-._]+|[-._]+$/g, "") || "target";
  const digest = createHash("sha256").update(entryPath, "utf8").digest("hex");
  return `${safeStem}--${digest.slice(0, 12)}`;
}

function assertReviewStoragePath(target: ResolvedTarget, result: string): string {
  let current = target.projectRoot;
  for (const part of path.relative(target.projectRoot, result).split(path.sep)) {
    current = path.join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error("review storage path must not contain symbolic links");
    }
  }
  return result;
}

export function reviewFilePath(target: ResolvedTarget): string {
  return assertReviewStoragePath(target, path.join(target.projectRoot, ".vreview", "reviews", reviewDirectoryName(target.entryPath), "review.json"));
}

export function resolvedReviewFilePath(target: ResolvedTarget): string {
  return assertReviewStoragePath(target, path.join(target.projectRoot, ".vreview", "reviews", reviewDirectoryName(target.entryPath), "resolved.json"));
}

export function legacyReviewFilePath(target: ResolvedTarget): string {
  return path.join(target.projectRoot, ".code", "visual-reviews", reviewDirectoryName(target.entryPath), "review.json");
}
