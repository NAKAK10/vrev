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

export interface VersionedPluginModuleReference extends PluginModuleReference {
  api_version: 1;
}

export interface PluginDisplayManifest {
  title: string;
  summary: string;
  readme: string;
}

export interface PluginConfigurationField {
  key: string;
  title: string;
  description?: string;
  type: "string" | "integer" | "boolean" | "select";
  source: "workspace" | "environment";
  required: boolean;
  environment?: string;
  default?: string | number | boolean;
  options?: Array<{ value: string; label: string }>;
}

export interface PluginServerManifestV1 extends PluginModuleReference {
  api_version: 1;
  bridge_api_version: 1;
  contract: string;
}

export type PluginUiSlotV1 =
  | "review.main"
  | "review.sidebar"
  | "review.annotation.actions"
  | "review.overlays"
  | "settings.detail";

export interface PluginUiContributionV1 {
  id: string;
  slot: PluginUiSlotV1;
  document: string;
  browser_module?: string;
  order: number;
}

export interface PluginUiManifestV1 {
  renderer_api_version: 1;
  bridge_api_version: 1;
  contributions: PluginUiContributionV1[];
}

export interface PluginCapabilityRequirementV1 {
  capability: string;
  api_version: 1;
  optional: boolean;
}

export interface PluginCapabilityProvisionV1 {
  capability: string;
  api_version: 1;
}

export interface VisualReviewPluginManifest {
  schema_version: 1 | 2 | 3 | 4;
  id: string;
  version: string;
  commands?: PluginCommandManifest[];
  storage_provider?: PluginModuleReference | VersionedPluginModuleReference;
  issue_provider?: PluginModuleReference;
  annotation_flow_provider?: VersionedPluginModuleReference;
  custom_command_provider?: VersionedPluginModuleReference;
  display?: PluginDisplayManifest;
  configuration?: PluginConfigurationField[];
  server?: PluginServerManifestV1;
  ui?: PluginUiManifestV1;
  requires?: PluginCapabilityRequirementV1[];
  provides?: PluginCapabilityProvisionV1[];
}

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const COMMAND_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const EXPORT_PATTERN = /^(?:default|[A-Za-z_$][\w$]*)$/;
const CONTRIBUTION_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z][a-z0-9]*){0,7}$/;
const UI_SLOTS = new Set<PluginUiSlotV1>(["review.main", "review.sidebar", "review.annotation.actions", "review.overlays", "settings.detail"]);

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

function versionedModuleReference(value: unknown, label: string): VersionedPluginModuleReference {
  const record = object(value, label);
  const reference = moduleReference(record, label, ["api_version"]);
  if (record.api_version !== 1) throw new Error(`${label}.api_version must be 1`);
  return { ...reference, api_version: 1 };
}

export function parsePluginManifest(value: unknown): VisualReviewPluginManifest {
  const record = object(value, "plugin manifest");
  const schemaVersion = record.schema_version;
  if (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== 3 && schemaVersion !== 4) throw new Error("plugin manifest schema_version must be 1, 2, 3, or 4");
  exactKeys(record, ["schema_version", "id", "version", "commands", "storage_provider", "issue_provider", ...(schemaVersion >= 2 ? ["annotation_flow_provider"] : []), ...(schemaVersion >= 3 ? ["display", "configuration", "custom_command_provider"] : []), ...(schemaVersion === 4 ? ["server", "ui", "requires", "provides"] : [])], "plugin manifest");
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
  const storageProvider = record.storage_provider === undefined ? undefined : schemaVersion >= 2
    ? versionedModuleReference(record.storage_provider, "storage_provider")
    : moduleReference(record.storage_provider, "storage_provider");
  const issueProvider = record.issue_provider === undefined ? undefined : moduleReference(record.issue_provider, "issue_provider");
  const annotationFlowProvider = record.annotation_flow_provider === undefined ? undefined : versionedModuleReference(record.annotation_flow_provider, "annotation_flow_provider");
  const customCommandProvider = record.custom_command_provider === undefined ? undefined : versionedModuleReference(record.custom_command_provider, "custom_command_provider");
  let display: PluginDisplayManifest | undefined;
  let configuration: PluginConfigurationField[] | undefined;
  if (schemaVersion >= 3) {
    const displayRecord = object(record.display, "display");
    exactKeys(displayRecord, ["title", "summary", "readme"], "display");
    if (typeof displayRecord.title !== "string" || !displayRecord.title.trim() || displayRecord.title.length > 100) throw new Error("display.title is invalid");
    if (typeof displayRecord.summary !== "string" || !displayRecord.summary.trim() || displayRecord.summary.length > 300) throw new Error("display.summary is invalid");
    const readme = moduleReference({ module: displayRecord.readme }, "display.readme").module;
    display = { title: displayRecord.title, summary: displayRecord.summary, readme };
    if (!Array.isArray(record.configuration)) throw new Error("configuration must be an array");
    const keys = new Set<string>();
    configuration = record.configuration.map((item, index) => {
      const field = object(item, `configuration[${index}]`);
      exactKeys(field, ["key", "title", "description", "type", "source", "required", "environment", "default", "options"], `configuration[${index}]`);
      if (typeof field.key !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(field.key) || keys.has(field.key)) throw new Error(`configuration[${index}].key is invalid or duplicated`);
      keys.add(field.key);
      if (typeof field.title !== "string" || !field.title.trim() || field.title.length > 100) throw new Error(`configuration[${index}].title is invalid`);
      if (field.description !== undefined && (typeof field.description !== "string" || field.description.length > 300)) throw new Error(`configuration[${index}].description is invalid`);
      if (!['string', 'integer', 'boolean', 'select'].includes(String(field.type))) throw new Error(`configuration[${index}].type is invalid`);
      if (field.source !== "workspace" && field.source !== "environment") throw new Error(`configuration[${index}].source is invalid`);
      if (typeof field.required !== "boolean") throw new Error(`configuration[${index}].required must be boolean`);
      if (field.source === "environment" && (typeof field.environment !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(field.environment))) throw new Error(`configuration[${index}].environment is invalid`);
      if (field.source === "workspace" && field.environment !== undefined) throw new Error(`configuration[${index}].environment is not allowed`);
      let options: Array<{ value: string; label: string }> | undefined;
      if (field.type === "select") {
        if (!Array.isArray(field.options) || field.options.length === 0 || field.options.length > 50) throw new Error(`configuration[${index}].options is invalid`);
        options = field.options.map((option, optionIndex) => {
          const choice = object(option, `configuration[${index}].options[${optionIndex}]`);
          exactKeys(choice, ["value", "label"], `configuration[${index}].options[${optionIndex}]`);
          if (typeof choice.value !== "string" || !choice.value || typeof choice.label !== "string" || !choice.label.trim()) throw new Error(`configuration[${index}].options[${optionIndex}] is invalid`);
          return { value: choice.value, label: choice.label };
        });
      } else if (field.options !== undefined) throw new Error(`configuration[${index}].options is not allowed`);
      if (field.default !== undefined && !["string", "number", "boolean"].includes(typeof field.default)) throw new Error(`configuration[${index}].default is invalid`);
      return {
        key: field.key,
        title: field.title,
        type: field.type as PluginConfigurationField["type"],
        source: field.source,
        required: field.required,
        ...(field.description === undefined ? {} : { description: field.description }),
        ...(typeof field.environment === "string" ? { environment: field.environment } : {}),
        ...(field.default === undefined ? {} : { default: field.default as string | number | boolean }),
        ...(options === undefined ? {} : { options }),
      };
    });
  }
  let server: PluginServerManifestV1 | undefined;
  let ui: PluginUiManifestV1 | undefined;
  let requires: PluginCapabilityRequirementV1[] | undefined;
  let provides: PluginCapabilityProvisionV1[] | undefined;
  if (schemaVersion === 4) {
    if (record.server !== undefined) {
      const serverRecord = object(record.server, "server");
      const reference = moduleReference(serverRecord, "server", ["api_version", "bridge_api_version", "contract"]);
      if (serverRecord.api_version !== 1) throw new Error("server.api_version must be 1");
      if (serverRecord.bridge_api_version !== 1) throw new Error("server.bridge_api_version must be 1");
      const contract = moduleReference({ module: serverRecord.contract }, "server.contract").module;
      server = { ...reference, api_version: 1, bridge_api_version: 1, contract };
    }
    if (record.ui !== undefined) {
      const uiRecord = object(record.ui, "ui");
      exactKeys(uiRecord, ["renderer_api_version", "bridge_api_version", "contributions"], "ui");
      if (uiRecord.renderer_api_version !== 1) throw new Error("ui.renderer_api_version must be 1");
      if (uiRecord.bridge_api_version !== 1) throw new Error("ui.bridge_api_version must be 1");
      if (!Array.isArray(uiRecord.contributions) || uiRecord.contributions.length === 0 || uiRecord.contributions.length > 32) throw new Error("ui.contributions is invalid");
      const contributionIds = new Set<string>();
      const contributions = uiRecord.contributions.map((item, index): PluginUiContributionV1 => {
        const contribution = object(item, `ui.contributions[${index}]`);
        exactKeys(contribution, ["id", "slot", "document", "browser_module", "order"], `ui.contributions[${index}]`);
        if (typeof contribution.id !== "string" || !CONTRIBUTION_ID_PATTERN.test(contribution.id) || contributionIds.has(contribution.id)) throw new Error(`ui.contributions[${index}].id is invalid or duplicated`);
        contributionIds.add(contribution.id);
        if (typeof contribution.slot !== "string" || !UI_SLOTS.has(contribution.slot as PluginUiSlotV1)) throw new Error(`ui.contributions[${index}].slot is invalid`);
        const document = moduleReference({ module: contribution.document }, `ui.contributions[${index}].document`).module;
        const browserModule = contribution.browser_module === undefined ? undefined : moduleReference({ module: contribution.browser_module }, `ui.contributions[${index}].browser_module`).module;
        if (browserModule && !/\.(?:m?js)$/i.test(browserModule)) throw new Error(`ui.contributions[${index}].browser_module must be a JavaScript module`);
        if (!Number.isInteger(contribution.order) || (contribution.order as number) < -10_000 || (contribution.order as number) > 10_000) throw new Error(`ui.contributions[${index}].order is invalid`);
        return { id: contribution.id, slot: contribution.slot as PluginUiSlotV1, document, ...(browserModule ? { browser_module: browserModule } : {}), order: contribution.order as number };
      });
      ui = { renderer_api_version: 1, bridge_api_version: 1, contributions };
    }
    const parseCapabilities = <T extends PluginCapabilityRequirementV1 | PluginCapabilityProvisionV1>(value: unknown, label: string, requirement: boolean): T[] => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.length > 64) throw new Error(`${label} must be an array`);
      const names = new Set<string>();
      return value.map((item, index) => {
        const capability = object(item, `${label}[${index}]`);
        exactKeys(capability, requirement ? ["capability", "api_version", "optional"] : ["capability", "api_version"], `${label}[${index}]`);
        if (typeof capability.capability !== "string" || !CAPABILITY_PATTERN.test(capability.capability) || names.has(capability.capability)) throw new Error(`${label}[${index}].capability is invalid or duplicated`);
        names.add(capability.capability);
        if (capability.api_version !== 1) throw new Error(`${label}[${index}].api_version must be 1`);
        if (requirement && typeof capability.optional !== "boolean") throw new Error(`${label}[${index}].optional must be boolean`);
        return { capability: capability.capability, api_version: 1, ...(requirement ? { optional: capability.optional as boolean } : {}) } as T;
      });
    };
    requires = parseCapabilities<PluginCapabilityRequirementV1>(record.requires, "requires", true);
    provides = parseCapabilities<PluginCapabilityProvisionV1>(record.provides, "provides", false);
    if (!server && !ui && !commands?.length && !storageProvider && !issueProvider && !annotationFlowProvider && !customCommandProvider) throw new Error("schema v4 plugin must declare a contribution");
  }
  return {
    schema_version: schemaVersion,
    id: record.id,
    version: record.version,
    ...(commands === undefined ? {} : { commands }),
    ...(storageProvider === undefined ? {} : { storage_provider: storageProvider }),
    ...(issueProvider === undefined ? {} : { issue_provider: issueProvider }),
    ...(annotationFlowProvider === undefined ? {} : { annotation_flow_provider: annotationFlowProvider }),
    ...(customCommandProvider === undefined ? {} : { custom_command_provider: customCommandProvider }),
    ...(display === undefined ? {} : { display }),
    ...(configuration === undefined ? {} : { configuration }),
    ...(server === undefined ? {} : { server }),
    ...(ui === undefined ? {} : { ui }),
    ...(requires === undefined ? {} : { requires }),
    ...(provides === undefined ? {} : { provides }),
  };
}

export function readPluginManifest(pluginDirectory: string, requireModules = false): VisualReviewPluginManifest {
  const manifest = parsePluginManifest(readJson(path.join(pluginDirectory, PLUGIN_MANIFEST_FILE)));
  if (requireModules) {
    const references = [
      ...(manifest.commands ?? []),
      ...(manifest.storage_provider ? [manifest.storage_provider] : []),
      ...(manifest.issue_provider ? [manifest.issue_provider] : []),
      ...(manifest.annotation_flow_provider ? [manifest.annotation_flow_provider] : []),
      ...(manifest.custom_command_provider ? [manifest.custom_command_provider] : []),
      ...(manifest.server ? [manifest.server, { module: manifest.server.contract }] : []),
      ...(manifest.ui?.contributions.flatMap(({ document, browser_module: browserModule }) => [{ module: document }, ...(browserModule ? [{ module: browserModule }] : [])]) ?? []),
    ];
    for (const reference of references) {
      const modulePath = path.join(pluginDirectory, ...reference.module.slice(2).split("/"));
      if (!existsSync(modulePath) || !statSync(modulePath).isFile()) throw new Error(`plugin module does not exist: ${reference.module}`);
    }
    if (manifest.display) {
      const readmePath = path.join(pluginDirectory, ...manifest.display.readme.slice(2).split("/"));
      if (!existsSync(readmePath) || !statSync(readmePath).isFile()) throw new Error(`plugin README does not exist: ${manifest.display.readme}`);
    }
  }
  return manifest;
}
