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
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export function normalizeLoopbackUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("target URL must be a valid loopback HTTP URL"); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !LOOPBACK_HOSTNAMES.has(hostname) || url.username || url.password) {
    throw new Error("target URL must use HTTP on localhost, 127.0.0.1, or ::1 without credentials");
  }
  url.hash = "";
  return url.toString();
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
    const liveUrl = normalizeLoopbackUrl(target);
    return { projectRoot: root, absolutePath: liveUrl, entryPath: liveUrl, kind: "html", liveUrl };
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
  const expectedPrefix = kind === "html" ? [".code", "htmls"] : ["assets"];
  if (!expectedPrefix.every((part, index) => parts[index] === part)) {
    throw new Error("target is outside its configured public root");
  }
  const publicParts = parts.slice(expectedPrefix.length);
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

export function reviewFilePath(target: ResolvedTarget): string {
  const result = path.join(
    target.projectRoot,
    ".code",
    "visual-reviews",
    reviewDirectoryName(target.entryPath),
    "review.json",
  );
  let current = target.projectRoot;
  for (const part of path.relative(target.projectRoot, result).split(path.sep)) {
    current = path.join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error("review storage path must not contain symbolic links");
    }
  }
  return result;
}
