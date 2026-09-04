import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

import { atomicWriteJson, readJson, withFileLock } from "./file-utils.js";
import type { ResolvedTarget } from "./paths.js";

export interface WorkspaceReviewReference {
  id: string;
  target: string;
  kind: "html" | "image";
  project_path: string;
  review_path: string;
  resolved_path: string;
  context_path: string;
}

export interface WorkspaceSettings {
  schema_version: 1;
  workspace: { root: "."; monorepo: boolean };
  ui?: { plugin_management?: boolean; allow_scripts?: boolean };
  projects: Array<{ id: string; path: string; reviews: WorkspaceReviewReference[] }>;
}

export interface WorkspaceUiSettingsUpdateInput {
  revision: string;
  allow_scripts: boolean;
}

function posixRelative(root: string, value: string): string {
  const relative = path.relative(root, value).split(path.sep).join("/");
  if (!relative || relative === ".") return ".";
  if (relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("workspace setting path is outside the workspace root");
  return relative;
}

function projectId(projectPath: string): string {
  return `project-${createHash("sha256").update(projectPath, "utf8").digest("hex").slice(0, 12)}`;
}

function hasWorkspaceDeclaration(root: string): boolean {
  if (["pnpm-workspace.yaml", "lerna.json", "nx.json", "turbo.json"].some((name) => existsSync(path.join(root, name)))) return true;
  const packagePath = path.join(root, "package.json");
  if (!existsSync(packagePath)) return false;
  try {
    const value = JSON.parse(readFileSync(packagePath, "utf8")) as { workspaces?: unknown };
    return Array.isArray(value.workspaces) || (typeof value.workspaces === "object" && value.workspaces !== null);
  } catch { return false; }
}

function loadSettings(settingsPath: string, monorepo: boolean): WorkspaceSettings {
  if (!existsSync(settingsPath)) return { schema_version: 1, workspace: { root: ".", monorepo }, projects: [] };
  const value = readJson(settingsPath) as Partial<WorkspaceSettings>;
  if (value.schema_version !== 1 || !value.workspace || !Array.isArray(value.projects)) throw new Error("unsupported .vrev/settings.json schema");
  if (value.ui !== undefined) {
    if (typeof value.ui !== "object" || value.ui === null) throw new Error("unsupported .vrev/settings.json ui schema");
    const ui = value.ui as Record<string, unknown>;
    if (Object.keys(ui).some((key) => key !== "plugin_management" && key !== "allow_scripts")
      || (ui.plugin_management !== undefined && typeof ui.plugin_management !== "boolean")
      || (ui.allow_scripts !== undefined && typeof ui.allow_scripts !== "boolean")) {
      throw new Error("unsupported .vrev/settings.json ui schema");
    }
  }
  return value as WorkspaceSettings;
}

export function loadWorkspaceSettings(workspaceRoot: string): WorkspaceSettings {
  const settingsPath = path.join(workspaceRoot, ".vrev", "settings.json");
  if (existsSync(settingsPath) && lstatSync(settingsPath).isSymbolicLink()) throw new Error(".vrev/settings.json must not be a symbolic link");
  return loadSettings(settingsPath, hasWorkspaceDeclaration(workspaceRoot));
}

export function workspaceSettingsRevision(settings: WorkspaceSettings): string {
  return createHash("sha256").update(JSON.stringify(settings), "utf8").digest("hex");
}

export function updateWorkspaceUiSettings(input: WorkspaceUiSettingsUpdateInput, workspaceRoot: string): { settings: WorkspaceSettings; revision: string } {
  const settingsPath = path.join(workspaceRoot, ".vrev", "settings.json");
  if (typeof input !== "object" || input === null || Object.keys(input).some((key) => key !== "revision" && key !== "allow_scripts")
    || typeof input.revision !== "string" || typeof input.allow_scripts !== "boolean") {
    throw new Error("workspace UI settings update is invalid");
  }
  if (existsSync(settingsPath) && lstatSync(settingsPath).isSymbolicLink()) throw new Error(".vrev/settings.json must not be a symbolic link");
  return withFileLock(settingsPath, () => {
    const settings = loadSettings(settingsPath, hasWorkspaceDeclaration(workspaceRoot));
    if (workspaceSettingsRevision(settings) !== input.revision) throw new Error("workspace settings revision conflict");
    settings.ui = { ...settings.ui, allow_scripts: input.allow_scripts };
    atomicWriteJson(settingsPath, settings);
    return { settings, revision: workspaceSettingsRevision(settings) };
  });
}

export function registerWorkspaceReview(target: ResolvedTarget, projectDirectory: string, reviewPath: string, resolvedPath: string): WorkspaceSettings {
  const root = target.projectRoot;
  const settingsPath = path.join(root, ".vrev", "settings.json");
  if (existsSync(settingsPath) && lstatSync(settingsPath).isSymbolicLink()) throw new Error(".vrev/settings.json must not be a symbolic link");
  const requestedProjectPath = posixRelative(root, realpathSync(projectDirectory));
  const reviewId = path.basename(path.dirname(reviewPath));
  const monorepo = requestedProjectPath !== "." || hasWorkspaceDeclaration(root);
  return withFileLock(settingsPath, () => {
    const settings = loadSettings(settingsPath, monorepo);
    settings.workspace.monorepo = settings.workspace.monorepo || monorepo;
    const existingOwner = settings.projects.find(({ reviews }) => reviews.some(({ id }) => id === reviewId));
    const projectPath = existingOwner?.path ?? requestedProjectPath;
    let project = existingOwner ?? settings.projects.find(({ path: candidate }) => candidate === projectPath);
    if (!project) {
      project = { id: projectId(projectPath), path: projectPath, reviews: [] };
      settings.projects.push(project);
    }
    const reviewDirectory = path.dirname(reviewPath);
    const reference: WorkspaceReviewReference = {
      id: path.basename(reviewDirectory),
      target: target.entryPath,
      kind: target.kind,
      project_path: projectPath,
      review_path: posixRelative(root, reviewPath),
      resolved_path: posixRelative(root, resolvedPath),
      context_path: posixRelative(root, path.join(reviewDirectory, "context.json")),
    };
    const index = project.reviews.findIndex(({ id }) => id === reference.id);
    if (index >= 0) project.reviews[index] = reference;
    else project.reviews.push(reference);
    const contextPath = path.join(reviewDirectory, "context.json");
    if (!existsSync(contextPath)) atomicWriteJson(contextPath, { schema_version: 1, discovery_status: "pending", primary_project: projectPath, related_scopes: [] });
    settings.projects.sort((left, right) => left.path.localeCompare(right.path));
    project.reviews.sort((left, right) => left.id.localeCompare(right.id));
    atomicWriteJson(settingsPath, settings);
    const ignorePath = path.join(root, ".vrev", ".gitignore");
    const requiredIgnores = ["**/job-state.json", "**/.server-lease.json", "**/.transaction.json", "**/*.lock", "credentials/"];
    const currentIgnores = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8").split(/\r?\n/).filter(Boolean) : [];
    const mergedIgnores = [...new Set([...currentIgnores, ...requiredIgnores])];
    writeFileSync(ignorePath, `${mergedIgnores.join("\n")}\n`, "utf8");
    return settings;
  });
}
