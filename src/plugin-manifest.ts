import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { readJson } from "./file-utils.js";
import { parseBoundedJsonSchema } from "./plugin-bridge-contract.js";

export const PLUGIN_MANIFEST_FILE = "vrev.plugin.json";

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
  type: "string" | "integer" | "boolean" | "select" | "secret";
  source: "workspace" | "environment" | "credential";
  required: boolean;
  environment?: string;
  default?: string | number | boolean;
  options?: Array<{ value: string; label: string }>;
  format?: "text" | "json";
}

export interface PluginServerManifestV1 extends PluginModuleReference {
  api_version: 1;
  bridge_api_version: 1;
  contract: string;
}

/** Slots hosted by the Core renderer itself. `review.main` is deprecated: parsed but never rendered. */
export type PluginUiCoreSlotV1 =
  | "review.main"
  | "review.header"
  | "review.stage"
  | "review.sidebar"
  | "settings.detail";

/** A JSON-schema-shaped event payload contract, keyed by event name (see `PluginUiExtensionPointV1.events`). */
export type PluginUiExtensionEventSchemaV1 = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/**
 * An extension point a plugin hosts via a `slot` node in one of its own UI documents, for other
 * plugins to contribute into (`ui.contributions[].slot`). Declared in `ui.extension_points[]`.
 */
export interface PluginUiExtensionPointV1 {
  id: string;
  title: string;
  description?: string;
  context_schema: Readonly<Record<string, unknown>>;
  form_fields: string[];
  events: PluginUiExtensionEventSchemaV1;
  max_contributions?: number;
}

export interface PluginUiContributionV1 {
  id: string;
  /** A Core slot, or the id of an extension point declared by some plugin's `ui.extension_points`. */
  slot: string;
  document: string;
  browser_module?: string;
  order: number;
  title?: string;
}

export interface PluginUiManifestV1 {
  renderer_api_version: 1;
  bridge_api_version: 1;
  extension_points?: PluginUiExtensionPointV1[];
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

export interface VrevPluginManifest {
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
export const PLUGIN_UI_CORE_SLOTS: ReadonlySet<PluginUiCoreSlotV1> = new Set(["review.main", "review.header", "review.stage", "review.sidebar", "settings.detail"]);
const EXTENSION_POINT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;
const EXTENSION_EVENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const FORM_FIELD_PATTERN = /^[a-z](?:[a-z0-9_.-]{0,62}[a-z0-9_])?$/;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

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

function parseExtensionPoints(value: unknown, pluginId: string): PluginUiExtensionPointV1[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error("ui.extension_points must be an array");
  const ids = new Set<string>();
  return value.map((item, index): PluginUiExtensionPointV1 => {
    const label = `ui.extension_points[${index}]`;
    const point = object(item, label);
    exactKeys(point, ["id", "title", "description", "context_schema", "form_fields", "events", "max_contributions"], label);
    if (typeof point.id !== "string" || point.id.length > 96 || !EXTENSION_POINT_ID_PATTERN.test(point.id)) throw new Error(`${label}.id is invalid`);
    if (!point.id.startsWith(`${pluginId}.`)) throw new Error(`${label}.id must start with "${pluginId}."`);
    if (PLUGIN_UI_CORE_SLOTS.has(point.id as PluginUiCoreSlotV1)) throw new Error(`${label}.id must not equal a Core slot`);
    if (ids.has(point.id)) throw new Error(`${label}.id is duplicated`);
    ids.add(point.id);
    if (typeof point.title !== "string" || point.title.length < 1 || point.title.length > 80 || !point.title.trim() || CONTROL_CHAR_PATTERN.test(point.title)) throw new Error(`${label}.title is invalid`);
    if (point.description !== undefined && (typeof point.description !== "string" || point.description.length > 400 || CONTROL_CHAR_PATTERN.test(point.description))) throw new Error(`${label}.description is invalid`);
    const contextSchema = parseBoundedJsonSchema(point.context_schema, `${label}.context_schema`, { allowOpenObjects: true });
    let formFields: string[] = [];
    if (point.form_fields !== undefined) {
      if (!Array.isArray(point.form_fields) || point.form_fields.length > 16) throw new Error(`${label}.form_fields is invalid`);
      const seen = new Set<string>();
      formFields = point.form_fields.map((field, fieldIndex) => {
        if (typeof field !== "string" || field.length > 64 || !FORM_FIELD_PATTERN.test(field) || seen.has(field)) throw new Error(`${label}.form_fields[${fieldIndex}] is invalid or duplicated`);
        seen.add(field);
        return field;
      });
    }
    let events: PluginUiExtensionEventSchemaV1 = {};
    if (point.events !== undefined) {
      const eventsRecord = object(point.events, `${label}.events`);
      if (Object.keys(eventsRecord).length > 8) throw new Error(`${label}.events has too many entries`);
      const parsedEvents: Record<string, Readonly<Record<string, unknown>>> = {};
      for (const [name, schema] of Object.entries(eventsRecord)) {
        if (!EXTENSION_EVENT_NAME_PATTERN.test(name)) throw new Error(`${label}.events contains an invalid name: ${name}`);
        parsedEvents[name] = parseBoundedJsonSchema(schema, `${label}.events.${name}`, { allowOpenObjects: true });
      }
      events = parsedEvents;
    }
    if (point.max_contributions !== undefined && (!Number.isInteger(point.max_contributions) || (point.max_contributions as number) < 1 || (point.max_contributions as number) > 32)) throw new Error(`${label}.max_contributions is invalid`);
    return {
      id: point.id,
      title: point.title,
      ...(point.description === undefined ? {} : { description: point.description as string }),
      context_schema: contextSchema,
      form_fields: formFields,
      events,
      ...(point.max_contributions === undefined ? {} : { max_contributions: point.max_contributions as number }),
    };
  });
}

export function parsePluginManifest(value: unknown): VrevPluginManifest {
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
      exactKeys(field, ["key", "title", "description", "type", "source", "required", "environment", "default", "options", "format"], `configuration[${index}]`);
      if (typeof field.key !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(field.key) || keys.has(field.key)) throw new Error(`configuration[${index}].key is invalid or duplicated`);
      keys.add(field.key);
      if (typeof field.title !== "string" || !field.title.trim() || field.title.length > 100) throw new Error(`configuration[${index}].title is invalid`);
      if (field.description !== undefined && (typeof field.description !== "string" || field.description.length > 300)) throw new Error(`configuration[${index}].description is invalid`);
      if (!['string', 'integer', 'boolean', 'select', 'secret'].includes(String(field.type))) throw new Error(`configuration[${index}].type is invalid`);
      if (field.source !== "workspace" && field.source !== "environment" && field.source !== "credential") throw new Error(`configuration[${index}].source is invalid`);
      if ((field.type === "secret") !== (field.source === "credential")) throw new Error(`configuration[${index}].type and source must both be a credential`);
      if (typeof field.required !== "boolean") throw new Error(`configuration[${index}].required must be boolean`);
      if (field.source === "environment" && (typeof field.environment !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(field.environment))) throw new Error(`configuration[${index}].environment is invalid`);
      if (field.source !== "environment" && field.environment !== undefined) throw new Error(`configuration[${index}].environment is not allowed`);
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
      if (field.source === "credential" && field.default !== undefined) throw new Error(`configuration[${index}].default is not allowed`);
      if (field.default !== undefined && !["string", "number", "boolean"].includes(typeof field.default)) throw new Error(`configuration[${index}].default is invalid`);
      if (field.format !== undefined && field.source !== "credential") throw new Error(`configuration[${index}].format is not allowed`);
      if (field.format !== undefined && field.format !== "text" && field.format !== "json") throw new Error(`configuration[${index}].format is invalid`);
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
        ...(field.format === undefined ? {} : { format: field.format as "text" | "json" }),
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
      exactKeys(uiRecord, ["renderer_api_version", "bridge_api_version", "extension_points", "contributions"], "ui");
      if (uiRecord.renderer_api_version !== 1) throw new Error("ui.renderer_api_version must be 1");
      if (uiRecord.bridge_api_version !== 1) throw new Error("ui.bridge_api_version must be 1");
      const extensionPoints = uiRecord.extension_points === undefined ? undefined : parseExtensionPoints(uiRecord.extension_points, record.id as string);
      if (!Array.isArray(uiRecord.contributions) || uiRecord.contributions.length === 0 || uiRecord.contributions.length > 32) throw new Error("ui.contributions is invalid");
      const contributionIds = new Set<string>();
      const contributions = uiRecord.contributions.map((item, index): PluginUiContributionV1 => {
        const contribution = object(item, `ui.contributions[${index}]`);
        exactKeys(contribution, ["id", "slot", "document", "browser_module", "order", "title"], `ui.contributions[${index}]`);
        if (typeof contribution.id !== "string" || !CONTRIBUTION_ID_PATTERN.test(contribution.id) || contributionIds.has(contribution.id)) throw new Error(`ui.contributions[${index}].id is invalid or duplicated`);
        contributionIds.add(contribution.id);
        if (typeof contribution.slot !== "string" || contribution.slot.length > 96 || !(PLUGIN_UI_CORE_SLOTS.has(contribution.slot as PluginUiCoreSlotV1) || EXTENSION_POINT_ID_PATTERN.test(contribution.slot))) {
          throw new Error(`ui.contributions[${index}].slot is invalid`);
        }
        const document = moduleReference({ module: contribution.document }, `ui.contributions[${index}].document`).module;
        const browserModule = contribution.browser_module === undefined ? undefined : moduleReference({ module: contribution.browser_module }, `ui.contributions[${index}].browser_module`).module;
        if (browserModule && !/\.(?:m?js)$/i.test(browserModule)) throw new Error(`ui.contributions[${index}].browser_module must be a JavaScript module`);
        if (!Number.isInteger(contribution.order) || (contribution.order as number) < -10_000 || (contribution.order as number) > 10_000) throw new Error(`ui.contributions[${index}].order is invalid`);
        if (contribution.title !== undefined && (typeof contribution.title !== "string" || contribution.title.length < 1 || contribution.title.length > 80 || !contribution.title.trim() || CONTROL_CHAR_PATTERN.test(contribution.title))) {
          throw new Error(`ui.contributions[${index}].title is invalid`);
        }
        return {
          id: contribution.id,
          slot: contribution.slot,
          document,
          ...(browserModule ? { browser_module: browserModule } : {}),
          order: contribution.order as number,
          ...(contribution.title !== undefined ? { title: contribution.title as string } : {}),
        };
      });
      ui = { renderer_api_version: 1, bridge_api_version: 1, ...(extensionPoints === undefined ? {} : { extension_points: extensionPoints }), contributions };
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

export function readPluginManifestFile(manifestPath: string, requireModules = false): VrevPluginManifest {
  const pluginDirectory = path.dirname(manifestPath);
  const manifest = parsePluginManifest(readJson(manifestPath));
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

export function readPluginManifest(pluginDirectory: string, requireModules = false): VrevPluginManifest {
  return readPluginManifestFile(path.join(pluginDirectory, PLUGIN_MANIFEST_FILE), requireModules);
}
