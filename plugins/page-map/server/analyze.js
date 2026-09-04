import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { extractTransitions } from "./html-links.js";

const DEFAULT_LIMITS = Object.freeze({ max_files: 500, max_file_bytes: 1024 * 1024, max_total_ms: 5000 });
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const SENSITIVE_PREFIXES = ["credential", "secret"];

/** Per-adapter-instance analysis cache. Re-parses a file only when its size or mtime changed. */
export function createAnalysisCache() {
  const entries = new Map();
  let hits = 0;
  let misses = 0;
  return Object.freeze({
    get(absolutePath, mtimeMs, size) {
      const entry = entries.get(absolutePath);
      if (entry && entry.mtimeMs === mtimeMs && entry.size === size) {
        hits += 1;
        return entry.result;
      }
      misses += 1;
      return undefined;
    },
    set(absolutePath, mtimeMs, size, result) {
      entries.set(absolutePath, { mtimeMs, size, result });
    },
    clear() {
      entries.clear();
      hits = 0;
      misses = 0;
    },
    stats() {
      return { hits, misses };
    },
  });
}

function isHiddenOrSensitive(name) {
  if (name.startsWith(".")) return true;
  const lower = name.toLowerCase();
  return SENSITIVE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function extractTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (!match) return "";
  return match[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

function stripQueryHash(value) {
  const index = value.search(/[?#]/);
  return index >= 0 ? value.slice(0, index) : value;
}

/** Resolves one raw transition target against POSIX repo-relative paths only - never touches
 * the filesystem for `outside`/`external` targets. */
function classifyTarget(rawTarget, sourceDirRepoRel, scanRootRepoRel) {
  const raw = String(rawTarget ?? "");
  if (/^https?:\/\//i.test(raw)) return { type: "external", url: raw };
  if (raw.startsWith("//")) return { type: "external", url: `https:${raw}` };
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return { type: "external", url: raw };

  const pathPart = stripQueryHash(raw);
  if (!pathPart) return null;
  const isAbsolute = pathPart.startsWith("/");
  const base = isAbsolute ? scanRootRepoRel : sourceDirRepoRel;
  const joined = isAbsolute ? pathPart.slice(1) : pathPart;
  const combined = path.posix.normalize(path.posix.join(base, joined));
  if (combined === ".." || combined.startsWith("../")) return { type: "outside", path: null };
  const normalizedScanRoot = scanRootRepoRel === "" ? "" : scanRootRepoRel;
  const inScanRoot = combined === normalizedScanRoot || combined.startsWith(`${normalizedScanRoot}/`) || normalizedScanRoot === "";
  return inScanRoot ? { type: "internal", path: combined } : { type: "outside", path: combined };
}

function walk(root, projectRoot, limits, deadline, state) {
  if (Date.now() > deadline || state.files.length >= limits.max_files) {
    state.truncated = true;
    return;
  }
  let dirents;
  try {
    dirents = readdirSync(root, { withFileTypes: true });
  } catch {
    state.incomplete = true;
    if (!state.warnings.includes("directoryを読み取れなかったため、解析を完了できませんでした")) state.warnings.push("directoryを読み取れなかったため、解析を完了できませんでした");
    return;
  }
  for (const dirent of dirents) {
    if (Date.now() > deadline) {
      state.truncated = true;
      state.warnings.push("解析の制限時間に達したため、一部のファイルをスキップしました");
      return;
    }
    if (isHiddenOrSensitive(dirent.name)) continue;
    const absolutePath = path.join(root, dirent.name);
    let stat;
    try {
      stat = lstatSync(absolutePath);
    } catch {
      state.incomplete = true;
      if (!state.warnings.includes("一部のファイルを読み取れなかったため、解析結果が不完全です")) state.warnings.push("一部のファイルを読み取れなかったため、解析結果が不完全です");
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      walk(absolutePath, projectRoot, limits, deadline, state);
      continue;
    }
    if (!stat.isFile()) continue;
    const extension = path.extname(dirent.name).toLowerCase();
    if (!HTML_EXTENSIONS.has(extension)) continue;
    if (state.files.length >= limits.max_files) {
      state.truncated = true;
      state.warnings.push(`ファイル数の上限（${limits.max_files}）に達したため、一部のファイルをスキップしました`);
      return;
    }
    state.files.push(absolutePath);
  }
}

/**
 * Static-only analysis of the HTML files below the entry file's directory. Never opens a
 * browser page, never fetches a network resource, and never follows a symlink.
 */
export function analyzeSite({ projectRoot, entryPath, limits: limitsOverride = {}, cache }) {
  const startedAt = Date.now();
  const limits = { ...DEFAULT_LIMITS, ...limitsOverride };
  const scanRootRepoRel = path.posix.dirname(entryPath);
  const scanRootAbsolute = path.join(projectRoot, scanRootRepoRel);
  const warnings = [];
  const state = { files: [], truncated: false, incomplete: false, warnings };
  const deadline = startedAt + limits.max_total_ms;

  if (existsSync(scanRootAbsolute)) walk(scanRootAbsolute, projectRoot, limits, deadline, state);
  else { state.incomplete = true; warnings.push("公開directoryが見つかりません"); }

  const pages = new Map(); // repoRelPath -> { path, title, exists, in_count, out_count, reachable }
  const edges = [];
  const unknown = [];
  const externals = new Map(); // url -> count

  const ensurePage = (repoRelPath, defaults = {}) => {
    let page = pages.get(repoRelPath);
    if (!page) {
      page = { path: repoRelPath, title: "", exists: undefined, in_count: 0, out_count: 0, reachable: false, ...defaults };
      pages.set(repoRelPath, page);
    }
    return page;
  };

  for (const absolutePath of state.files) {
    const repoRelPath = path.relative(projectRoot, absolutePath).split(path.sep).join("/");
    let stat;
    try {
      stat = statSync(absolutePath);
    } catch {
      continue;
    }
    const page = ensurePage(repoRelPath, { exists: true });
    if (stat.size > limits.max_file_bytes) {
      state.truncated = true;
      warnings.push(`ファイルが大きすぎるため解析をスキップしました: ${repoRelPath}`);
      continue;
    }
    const cached = cache?.get(absolutePath, stat.mtimeMs, stat.size);
    let parsed;
    if (cached) {
      parsed = cached;
    } else {
      let html;
      try {
        html = readFileSync(absolutePath, "utf8");
      } catch {
        warnings.push(`ファイルを読み込めませんでした: ${repoRelPath}`);
        continue;
      }
      const { transitions, unknown: unknownHere } = extractTransitions(html, { filePath: repoRelPath });
      parsed = { title: extractTitle(html), transitions, unknown: unknownHere };
      cache?.set(absolutePath, stat.mtimeMs, stat.size, parsed);
    }
    page.title = parsed.title;
    const sourceDirRepoRel = path.posix.dirname(repoRelPath);

    for (const transition of parsed.transitions) {
      const target = transition.self ? repoRelPath : transition.target;
      const classified = transition.self
        ? { type: "internal", path: repoRelPath }
        : classifyTarget(target, sourceDirRepoRel, scanRootRepoRel);
      if (!classified) continue;
      page.out_count += 1;
      if (classified.type === "external") {
        externals.set(classified.url, (externals.get(classified.url) ?? 0) + 1);
        edges.push({ from: repoRelPath, to: classified.url, kind: transition.kind, label: transition.label, line: transition.line });
        continue;
      }
      if (classified.type === "outside") {
        edges.push({ from: repoRelPath, to: classified.path ?? "..", kind: transition.kind, label: transition.label, line: transition.line });
        continue;
      }
      const targetPage = ensurePage(classified.path);
      targetPage.in_count += 1;
      edges.push({ from: repoRelPath, to: classified.path, kind: transition.kind, label: transition.label, line: transition.line });
    }
    for (const item of parsed.unknown) unknown.push({ from: repoRelPath, kind: item.kind, line: item.line, snippet: item.snippet });
  }

  // Internal targets that were never walked (missing files, or non-HTML internal assets) still
  // become terminal graph nodes so the UI can show them without ever reading their contents.
  for (const page of pages.values()) {
    if (page.exists !== undefined) continue;
    const absoluteTarget = path.join(projectRoot, page.path);
    try {
      const stat = lstatSync(absoluteTarget);
      page.exists = stat.isFile() && !stat.isSymbolicLink();
    } catch {
      page.exists = false;
    }
  }

  // Reachability: BFS from the entry over internal edges only.
  const adjacency = new Map();
  for (const edge of edges) {
    if (!pages.has(edge.to) || edge.from === edge.to) continue;
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge.to);
  }
  const queue = [entryPath];
  const visited = new Set();
  if (pages.has(entryPath)) visited.add(entryPath);
  else ensurePage(entryPath, { exists: existsSync(path.join(projectRoot, entryPath)) });
  visited.add(entryPath);
  while (queue.length) {
    const current = queue.shift();
    for (const next of adjacency.get(current) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  for (const page of pages.values()) page.reachable = visited.has(page.path) || page.path === entryPath;

  const sortedPages = [...pages.values()].sort((a, b) => a.path.localeCompare(b.path));
  const sortedExternals = [...externals.entries()].map(([url, from_count]) => ({ url, from_count })).sort((a, b) => b.from_count - a.from_count);

  const hasHtmlFiles = state.files.length > 0;
  const incomplete = !hasHtmlFiles && (state.incomplete || state.truncated);
  return {
    analysis_state: hasHtmlFiles ? "ready" : incomplete ? "incomplete" : "empty",
    analysis_reason: hasHtmlFiles ? "none" : incomplete ? "scan_incomplete" : "no_html_files",
    generated_at: new Date().toISOString(),
    scan_root: scanRootRepoRel,
    entry_path: entryPath,
    truncated: state.truncated,
    warnings,
    stats: {
      files: state.files.length,
      pages: sortedPages.length,
      edges: edges.length,
      unknown: unknown.length,
      duration_ms: Date.now() - startedAt,
    },
    pages: sortedPages,
    edges,
    unknown,
    externals: sortedExternals,
  };
}
