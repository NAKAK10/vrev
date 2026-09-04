import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";

import { atomicWriteJson, readJson, withFileLock } from "./file-utils.js";
import { findWorkspaceRoot } from "./paths.js";

export type LayoutCornerV1 = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface LayoutSettingsFile {
  schema_version: 1;
  header: { order: string[] };
  sidebar: { order: string[] };
  stage: { active: string | null; switcher_position: LayoutCornerV1 };
}

export const DEFAULT_LAYOUT_SETTINGS: LayoutSettingsFile = {
  schema_version: 1,
  header: { order: [] },
  sidebar: { order: [] },
  stage: { active: null, switcher_position: "bottom-right" },
};

export interface LayoutSettingsUpdateInput {
  revision: string;
  header?: { order: string[] };
  sidebar?: { order: string[] };
  stage?: { active?: string | null; switcher_position?: LayoutCornerV1 };
}

const CORNERS = new Set<LayoutCornerV1>(["top-left", "top-right", "bottom-left", "bottom-right"]);
const CONTRIBUTION_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?\/[a-z][a-z0-9-]{0,62}$/;

export function layoutSettingsPath(workspace = process.cwd()): string {
  return path.join(findWorkspaceRoot(workspace), ".vrev", "layout-settings.json");
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`${label} contains unsupported field: ${unexpected[0]}`);
}

function parseOrder(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error(`${label} must be an array of at most 200 entries`);
  const seen = new Set<string>();
  return value.map((item) => {
    if (typeof item !== "string" || !CONTRIBUTION_KEY_PATTERN.test(item)) throw new Error(`${label} entry is invalid: ${String(item)}`);
    if (seen.has(item)) throw new Error(`${label} entry is duplicated: ${item}`);
    seen.add(item);
    return item;
  });
}

function parseActive(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !CONTRIBUTION_KEY_PATTERN.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function parseSwitcherPosition(value: unknown, label: string): LayoutCornerV1 {
  if (typeof value !== "string" || !CORNERS.has(value as LayoutCornerV1)) throw new Error(`${label} is invalid`);
  return value as LayoutCornerV1;
}

function parseLayoutSettings(value: unknown): LayoutSettingsFile {
  const record = object(value, "layout settings");
  exactKeys(record, ["schema_version", "header", "sidebar", "stage"], "layout settings");
  if (record.schema_version !== 1) throw new Error("layout settings schema_version must be 1");
  const header = object(record.header, "layout settings header");
  exactKeys(header, ["order"], "layout settings header");
  const sidebar = object(record.sidebar, "layout settings sidebar");
  exactKeys(sidebar, ["order"], "layout settings sidebar");
  const stage = object(record.stage, "layout settings stage");
  exactKeys(stage, ["active", "switcher_position"], "layout settings stage");
  return {
    schema_version: 1,
    header: { order: parseOrder(header.order, "layout settings header.order") },
    sidebar: { order: parseOrder(sidebar.order, "layout settings sidebar.order") },
    stage: {
      active: parseActive(stage.active, "layout settings stage.active"),
      switcher_position: parseSwitcherPosition(stage.switcher_position, "layout settings stage.switcher_position"),
    },
  };
}

export function readLayoutSettings(workspace = process.cwd()): LayoutSettingsFile {
  const filePath = layoutSettingsPath(workspace);
  if (!existsSync(filePath)) return structuredClone(DEFAULT_LAYOUT_SETTINGS);
  if (lstatSync(filePath).isSymbolicLink()) throw new Error("layout settings must not be a symbolic link");
  return parseLayoutSettings(readJson(filePath));
}

export function layoutSettingsRevision(settings: LayoutSettingsFile): string {
  return createHash("sha256").update(JSON.stringify(settings), "utf8").digest("hex");
}

export function updateLayoutSettings(
  input: LayoutSettingsUpdateInput,
  workspace = process.cwd(),
): { settings: LayoutSettingsFile; revision: string } {
  const filePath = layoutSettingsPath(workspace);
  return withFileLock(filePath, () => {
    const record = object(input, "layout settings update");
    exactKeys(record, ["revision", "header", "sidebar", "stage"], "layout settings update");
    if (typeof record.revision !== "string") throw new Error("layout settings update is invalid");
    const current = readLayoutSettings(workspace);
    if (layoutSettingsRevision(current) !== record.revision) throw new Error("layout settings revision conflict");
    const next: LayoutSettingsFile = structuredClone(current);
    if (record.header !== undefined) {
      const header = object(record.header, "layout settings update header");
      exactKeys(header, ["order"], "layout settings update header");
      next.header = { order: parseOrder(header.order, "layout settings update header.order") };
    }
    if (record.sidebar !== undefined) {
      const sidebar = object(record.sidebar, "layout settings update sidebar");
      exactKeys(sidebar, ["order"], "layout settings update sidebar");
      next.sidebar = { order: parseOrder(sidebar.order, "layout settings update sidebar.order") };
    }
    if (record.stage !== undefined) {
      const stage = object(record.stage, "layout settings update stage");
      exactKeys(stage, ["active", "switcher_position"], "layout settings update stage");
      if ("active" in stage) next.stage.active = parseActive(stage.active, "layout settings update stage.active");
      if ("switcher_position" in stage) {
        next.stage.switcher_position = parseSwitcherPosition(stage.switcher_position, "layout settings update stage.switcher_position");
      }
    }
    atomicWriteJson(filePath, next);
    return { settings: next, revision: layoutSettingsRevision(next) };
  });
}
