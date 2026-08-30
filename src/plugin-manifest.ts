import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { readJson } from "./file-utils.js";

export const PLUGIN_MANIFEST_FILE = "visual-review.plugin.json";

export interface PluginModuleReference {
  module: string;
  export?: string;
}

export interface PluginCommandManifest extends PluginModuleReference {
  name: string;
}

export interface VisualReviewPluginManifest {
  schema_version: 1;
  id: string;
  version: string;
  commands?: PluginCommandManifest[];
  storage_provider?: PluginModuleReference;
  issue_provider?: PluginModuleReference;
}

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const COMMAND_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const EXPORT_PATTERN = /^(?:default|[A-Za-z_$][\w$]*)$/;

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`${label} contains unsupported field: ${unexpected[0]}`);
}

function moduleReference(value: unknown, label: string, extraKeys: string[] = []): PluginModuleReference {
  const record = object(value, label);
  exactKeys(record, ["module", "export", ...extraKeys], label);
  if (typeof record.module !== "string" || !record.module.startsWith("./")) throw new Error(`${label}.module must start with ./`);
  const relative = record.module.slice(2);
  if (!relative || relative.includes("\\") || path.posix.isAbsolute(relative) || relative.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label}.module must be a canonical relative POSIX path`);
  }
  if (record.export !== undefined && (typeof record.export !== "string" || !EXPORT_PATTERN.test(record.export))) throw new Error(`${label}.export is invalid`);
  return record.export === undefined ? { module: record.module } : { module: record.module, export: record.export };
}

export function parsePluginManifest(value: unknown): VisualReviewPluginManifest {
  const record = object(value, "plugin manifest");
  exactKeys(record, ["schema_version", "id", "version", "commands", "storage_provider", "issue_provider"], "plugin manifest");
  if (record.schema_version !== 1) throw new Error("plugin manifest schema_version must be 1");
  if (typeof record.id !== "string" || !ID_PATTERN.test(record.id)) throw new Error("plugin manifest id is invalid");
  if (typeof record.version !== "string" || record.version.length > 128 || !SEMVER_PATTERN.test(record.version)) throw new Error("plugin manifest version must be SemVer");

  let commands: PluginCommandManifest[] | undefined;
  if (record.commands !== undefined) {
    if (!Array.isArray(record.commands)) throw new Error("plugin manifest commands must be an array");
    const names = new Set<string>();
    commands = record.commands.map((item, index) => {
      const command = object(item, `commands[${index}]`);
      exactKeys(command, ["name", "module", "export"], `commands[${index}]`);
      if (typeof command.name !== "string" || !COMMAND_PATTERN.test(command.name)) throw new Error(`commands[${index}].name is invalid`);
      if (names.has(command.name)) throw new Error(`duplicate plugin command: ${command.name}`);
      names.add(command.name);
      return { name: command.name, ...moduleReference(command, `commands[${index}]`, ["name"]) };
    });
  }
  const storageProvider = record.storage_provider === undefined ? undefined : moduleReference(record.storage_provider, "storage_provider");
  const issueProvider = record.issue_provider === undefined ? undefined : moduleReference(record.issue_provider, "issue_provider");
  return {
    schema_version: 1,
    id: record.id,
    version: record.version,
    ...(commands === undefined ? {} : { commands }),
    ...(storageProvider === undefined ? {} : { storage_provider: storageProvider }),
    ...(issueProvider === undefined ? {} : { issue_provider: issueProvider }),
  };
}

export function readPluginManifest(pluginDirectory: string, requireModules = false): VisualReviewPluginManifest {
  const manifest = parsePluginManifest(readJson(path.join(pluginDirectory, PLUGIN_MANIFEST_FILE)));
  if (requireModules) {
    const references = [
      ...(manifest.commands ?? []),
      ...(manifest.storage_provider ? [manifest.storage_provider] : []),
      ...(manifest.issue_provider ? [manifest.issue_provider] : []),
    ];
    for (const reference of references) {
      const modulePath = path.join(pluginDirectory, ...reference.module.slice(2).split("/"));
      if (!existsSync(modulePath) || !statSync(modulePath).isFile()) throw new Error(`plugin module does not exist: ${reference.module}`);
    }
  }
  return manifest;
}
