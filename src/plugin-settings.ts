import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { atomicWriteJson, readJson, withFileLock } from "./file-utils.js";
import type { PluginConfigurationField, VisualReviewPluginManifest } from "./plugin-manifest.js";
import { findWorkspaceRoot } from "./paths.js";
import { readPluginCredentialPresence } from "./plugin-credentials.js";

export interface PluginSettingEntry {
  enabled: boolean;
  configuration: Record<string, string | number | boolean>;
}

export interface PluginSettingsFile {
  schema_version: 1;
  plugins: Record<string, PluginSettingEntry>;
}

export interface EffectivePluginSettings {
  enabled: boolean;
  configuration: Record<string, string | number | boolean>;
  missing: string[];
}

function settingsPath(workspace = process.cwd()): string {
  return path.join(findWorkspaceRoot(workspace), ".vreview", "plugin-settings.json");
}

function emptySettings(): PluginSettingsFile {
  return { schema_version: 1, plugins: {} };
}

function parseSettings(value: unknown): PluginSettingsFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("plugin settings must be an object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["schema_version", "plugins"].includes(key)) || record.schema_version !== 1
    || typeof record.plugins !== "object" || record.plugins === null || Array.isArray(record.plugins)) throw new Error("plugin settings schema is invalid");
  const plugins: Record<string, PluginSettingEntry> = {};
  for (const [id, raw] of Object.entries(record.plugins as Record<string, unknown>)) {
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(id) || typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("plugin settings entry is invalid");
    const entry = raw as Record<string, unknown>;
    if (Object.keys(entry).some((key) => !["enabled", "configuration"].includes(key)) || typeof entry.enabled !== "boolean"
      || typeof entry.configuration !== "object" || entry.configuration === null || Array.isArray(entry.configuration)) throw new Error(`plugin settings entry is invalid: ${id}`);
    const configuration: Record<string, string | number | boolean> = {};
    for (const [key, item] of Object.entries(entry.configuration as Record<string, unknown>)) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || !["string", "number", "boolean"].includes(typeof item)) throw new Error(`plugin configuration value is invalid: ${id}/${key}`);
      configuration[key] = item as string | number | boolean;
    }
    plugins[id] = { enabled: entry.enabled, configuration };
  }
  return { schema_version: 1, plugins };
}

export function readPluginSettings(workspace = process.cwd()): PluginSettingsFile {
  const filePath = settingsPath(workspace);
  if (!existsSync(filePath)) return emptySettings();
  if (lstatSync(filePath).isSymbolicLink()) throw new Error("plugin settings must not be a symbolic link");
  return parseSettings(readJson(filePath));
}

export function pluginSettingsRevision(settings: PluginSettingsFile): string {
  return createHash("sha256").update(JSON.stringify(settings), "utf8").digest("hex");
}

function valueValid(field: PluginConfigurationField, value: unknown): boolean {
  if (field.type === "string") return typeof value === "string" && value.length <= 4096;
  if (field.type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  if (field.type === "boolean") return typeof value === "boolean";
  return typeof value === "string" && Boolean(field.options?.some((option) => option.value === value));
}

function effectiveFrom(manifest: VisualReviewPluginManifest, stored: PluginSettingEntry | undefined, env: NodeJS.ProcessEnv, workspace: string): EffectivePluginSettings {
  const configuration = { ...(stored?.configuration ?? {}) };
  const missing: string[] = [];
  const hasCredentialField = (manifest.configuration ?? []).some((field) => field.source === "credential");
  const credentialPresence = hasCredentialField ? readPluginCredentialPresence(manifest.id, workspace) : {};
  for (const field of manifest.configuration ?? []) {
    if (field.source === "environment") {
      if (field.required && (!field.environment || !env[field.environment])) missing.push(field.key);
      continue;
    }
    if (field.source === "credential") {
      if (field.required && !credentialPresence[field.key]) missing.push(field.key);
      continue;
    }
    if (!(field.key in configuration) && field.default !== undefined) configuration[field.key] = field.default;
    if (field.key in configuration && !valueValid(field, configuration[field.key])) missing.push(field.key);
    else if (field.required && !(field.key in configuration)) missing.push(field.key);
  }
  return { enabled: stored?.enabled ?? true, configuration, missing };
}

export function effectivePluginSettings(manifest: VisualReviewPluginManifest, workspace = process.cwd(), env: NodeJS.ProcessEnv = process.env): EffectivePluginSettings {
  return effectiveFrom(manifest, readPluginSettings(workspace).plugins[manifest.id], env, workspace);
}

export function assertPluginEnabled(manifest: VisualReviewPluginManifest, workspace = process.cwd()): EffectivePluginSettings {
  const effective = effectivePluginSettings(manifest, workspace);
  if (!effective.enabled) throw new Error(`plugin is disabled: ${manifest.id}`);
  if (effective.missing.length > 0) throw new Error(`plugin configuration is incomplete: ${manifest.id} (${effective.missing.join(", ")})`);
  return effective;
}

export function updatePluginSettings(
  id: string,
  manifest: VisualReviewPluginManifest,
  input: { revision: string; enabled: boolean; configuration: Record<string, unknown> },
  workspace = process.cwd(),
): { settings: PluginSettingsFile; revision: string; effective: EffectivePluginSettings } {
  const filePath = settingsPath(workspace);
  return withFileLock(filePath, () => {
    const current = readPluginSettings(workspace);
    if (pluginSettingsRevision(current) !== input.revision) throw new Error("plugin settings revision conflict");
    if (typeof input.enabled !== "boolean" || typeof input.configuration !== "object" || input.configuration === null || Array.isArray(input.configuration)) throw new Error("plugin settings update is invalid");
    const fields = new Map((manifest.configuration ?? []).filter(({ source }) => source === "workspace").map((field) => [field.key, field]));
    const configuration: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(input.configuration)) {
      const field = fields.get(key);
      if (!field || !valueValid(field, value)) throw new Error(`plugin configuration value is invalid: ${id}/${key}`);
      configuration[key] = value as string | number | boolean;
    }
    const entry = { enabled: input.enabled, configuration };
    const effective = effectiveFrom(manifest, entry, process.env, workspace);
    if (input.enabled && effective.missing.length > 0) throw new Error(`plugin configuration is incomplete: ${id} (${effective.missing.join(", ")})`);
    current.plugins[id] = entry;
    atomicWriteJson(filePath, current);
    return { settings: current, revision: pluginSettingsRevision(current), effective };
  });
}

export function pluginSettingsPath(workspace = process.cwd()): string {
  return settingsPath(workspace);
}
