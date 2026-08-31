export const PLUGIN_UI_DOCUMENT_MAX_BYTES = 512 * 1024;
export const PLUGIN_UI_DOCUMENT_MAX_DEPTH = 32;
export const PLUGIN_UI_DOCUMENT_MAX_NODES = 2_000;

const IDENTIFIER = /^[a-z](?:[a-z0-9_.-]{0,62}[a-z0-9_])?$/;
const COMPONENTS = new Set([
  "app-shell", "header", "toolbar", "split-panel", "slot", "section", "stack", "row", "panel", "spacer",
  "text", "heading", "badge", "count", "status", "time", "list", "empty-state", "code", "safe-markdown",
  "button", "link", "input", "textarea", "select", "switch", "checkbox", "checkbox-group", "fieldset", "legend", "form",
  "dialog", "confirmation-dialog", "toast-region", "disclosure", "live-status",
  "target-stage", "annotation-mark-layer", "viewport-selector", "selection-mode-selector", "load-more",
]);

const EXECUTABLE_KEYS = new Set([
  "script", "scripts", "html", "innerhtml", "dangerouslysetinnerhtml", "css", "style", "styles", "stylesheet",
  "fetch", "network", "eval", "javascript", "srcdoc", "selector", "dom", "element", "window", "document",
  "__proto__", "prototype", "constructor",
]);

const COMMON_PROPS = ["hidden", "disabled", "busy", "tone", "variant", "size", "label", "description"] as const;
const COMPONENT_PROPS: Readonly<Record<string, readonly string[]>> = {
  "app-shell": ["title", "busy"],
  header: ["title", "subtitle", "compact"],
  toolbar: ["label", "overflow", "align", "wrap"],
  "split-panel": ["direction", "primary", "ratio", "collapse", "primary_order", "empty_slot"],
  slot: ["name", "context", "empty_slot"],
  section: ["title", "description", "collapsible", "expanded"],
  stack: ["gap", "align", "justify", "wrap", "collapse"],
  row: ["gap", "align", "justify", "wrap", "collapse"],
  panel: ["title", "tone", "variant", "padding"],
  spacer: ["size", "grow"],
  text: ["text", "value", "tone", "variant", "size", "truncate", "preserve_whitespace"],
  heading: ["text", "value", "level", "size"],
  badge: ["text", "value", "tone", "variant"],
  count: ["value", "label", "maximum"],
  status: ["value", "label", "tone"],
  time: ["value", "format", "relative"],
  list: ["label", "empty_message", "selected", "selection_mode", "busy"],
  "empty-state": ["title", "message", "icon"],
  code: ["value", "language", "wrap"],
  "safe-markdown": ["value", "content"],
  button: ["label", "variant", "size", "disabled", "busy", "pressed", "type", "icon"],
  link: ["label", "href", "external", "confirmation", "disabled"],
  input: ["name", "label", "description", "value", "placeholder", "type", "required", "disabled", "readonly", "min", "max", "min_length", "max_length", "autocomplete", "error"],
  textarea: ["name", "label", "description", "value", "placeholder", "required", "disabled", "readonly", "rows", "min_length", "max_length", "error"],
  select: ["name", "label", "description", "value", "options", "placeholder", "required", "disabled", "multiple", "error"],
  switch: ["name", "label", "description", "checked", "disabled"],
  checkbox: ["name", "label", "description", "value", "checked", "disabled"],
  "checkbox-group": ["name", "label", "description", "value", "options", "disabled", "required", "error"],
  fieldset: ["label", "description", "disabled", "error"],
  legend: ["text", "value"],
  form: ["name", "busy", "disabled", "submit_on_enter"],
  dialog: ["open", "title", "description", "initial_focus", "return_focus", "dismissible", "mobile_presentation", "busy"],
  "confirmation-dialog": ["open", "title", "message", "confirm_label", "cancel_label", "variant", "initial_focus", "return_focus", "busy"],
  "toast-region": ["label"],
  disclosure: ["label", "expanded", "disabled"],
  "live-status": ["message", "value", "variant", "politeness"],
  "target-stage": ["target", "target_kind", "trust_mode", "viewport_mode", "selection_mode", "enabled"],
  "annotation-mark-layer": ["marks", "selected_id", "resolved_policy", "stale_policy", "enabled"],
  "viewport-selector": ["value", "options", "disabled", "label"],
  "selection-mode-selector": ["value", "options", "disabled", "label"],
  "load-more": ["label", "disabled", "busy", "remaining"],
};

const COMPONENT_EVENTS: Readonly<Record<string, readonly string[]>> = {
  button: ["click"], link: ["click"], form: ["submit", "reset"],
  input: ["input", "change", "focus", "blur"], textarea: ["input", "change", "focus", "blur"],
  select: ["change", "focus", "blur"], switch: ["change"], checkbox: ["change"], "checkbox-group": ["change"],
  dialog: ["open", "close", "cancel"], "confirmation-dialog": ["confirm", "cancel", "close"],
  disclosure: ["toggle"], "viewport-selector": ["change"], "selection-mode-selector": ["change"], "load-more": ["click"],
  "target-stage": [
    "load", "error", "hover", "dom-selection", "html-region-selection", "image-region-selection",
    "selection-preview", "selection-commit", "selection-cancel", "anchor-failure",
    "selection.preview", "selection.commit", "selection.cancel", "anchor.failure",
  ],
  "annotation-mark-layer": ["select", "focus", "hover"],
};

export interface PluginUiNodeV1 {
  id?: string;
  type: string;
  props?: Readonly<Record<string, unknown>>;
  when?: Readonly<Record<string, unknown>>;
  repeat?: Readonly<Record<string, unknown>>;
  on?: Readonly<Record<string, unknown[]>>;
  children?: PluginUiNodeV1[];
}

export interface PluginUiDocumentV1 {
  schema_version: 1;
  local_state?: unknown[];
  resources?: unknown[];
  root: PluginUiNodeV1;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const unexpected = Object.keys(value).find((key) => !keys.includes(key));
  if (unexpected) throw new Error(`${label} contains unsupported field: ${unexpected}`);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 64 || !IDENTIFIER.test(value)) throw new Error(`${label} must be a valid identifier`);
  return value;
}

function assertJsonSafe(value: unknown, label: string, depth = 0): void {
  if (depth > PLUGIN_UI_DOCUMENT_MAX_DEPTH + 8) throw new Error(`${label} is too deeply nested`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    if (value.length > PLUGIN_UI_DOCUMENT_MAX_NODES) throw new Error(`${label} contains too many items`);
    value.forEach((item, index) => assertJsonSafe(item, `${label}[${index}]`, depth + 1));
    return;
  }
  const item = record(value, label);
  for (const [key, child] of Object.entries(item)) {
    if (EXECUTABLE_KEYS.has(key.toLowerCase()) || /^on[a-z]/i.test(key)) throw new Error(`${label} contains forbidden field: ${key}`);
    assertJsonSafe(child, `${label}.${key}`, depth + 1);
  }
}

function jsonPointer(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 1024 || (value !== "" && !value.startsWith("/"))) throw new Error(`${label} must be a JSON pointer`);
  for (const raw of value.split("/").slice(1)) {
    if (/~(?![01])/u.test(raw)) throw new Error(`${label} must be a JSON pointer`);
    const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (segment === "__proto__" || segment === "prototype" || segment === "constructor") throw new Error(`${label} contains an unsafe path segment`);
  }
  return value;
}

function binding(value: unknown, label: string): void {
  const item = record(value, label);
  const tags = Object.keys(item);
  if (tags.length === 0) throw new Error(`${label} must be a binding`);
  if ("resource" in item) {
    exactKeys(item, ["resource", "path"], label);
    identifier(item.resource, `${label}.resource`);
    if (item.path !== undefined) jsonPointer(item.path, `${label}.path`);
    return;
  }
  if (tags.length !== 1) throw new Error(`${label} must contain exactly one binding source`);
  const tag = tags[0]!;
  const source = item[tag];
  if (tag === "literal") {
    assertJsonSafe(source, `${label}.literal`);
    return;
  }
  if (["local", "event", "item", "slot", "slot_context", "slot-context", "result", "error", "command"].includes(tag)) {
    jsonPointer(source, `${label}.${tag}`);
    return;
  }
  if (tag === "form") {
    identifier(source, `${label}.form`);
    return;
  }
  throw new Error(`${label} has an unsupported binding source: ${tag}`);
}

function bindingMap(value: unknown, label: string): void {
  const item = record(value, label);
  for (const [key, child] of Object.entries(item)) {
    identifier(key, `${label} key`);
    binding(child, `${label}.${key}`);
  }
}

function predicate(value: unknown, label: string, depth = 0): void {
  if (typeof value === "boolean") return;
  if (depth > PLUGIN_UI_DOCUMENT_MAX_DEPTH) throw new Error(`${label} is too deeply nested`);
  const item = record(value, label);
  const keys = Object.keys(item);
  if (keys.length !== 1) throw new Error(`${label} must contain exactly one predicate operator`);
  const operator = keys[0]!;
  const operand = item[operator];
  if (operator === "literal") {
    if (typeof operand !== "boolean") throw new Error(`${label}.literal must be boolean`);
  } else if (operator === "eq" || operator === "equals" || operator === "ne" || operator === "not_equals") {
    if (!Array.isArray(operand) || operand.length !== 2) throw new Error(`${label}.${operator} must contain two bindings`);
    operand.forEach((entry, index) => binding(entry, `${label}.${operator}[${index}]`));
  } else if (operator === "in") {
    if (!Array.isArray(operand) || operand.length !== 2) throw new Error(`${label}.in must contain a value and enum binding`);
    operand.forEach((entry, index) => binding(entry, `${label}.in[${index}]`));
  } else if (operator === "and" || operator === "or") {
    if (!Array.isArray(operand) || operand.length === 0 || operand.length > 32) throw new Error(`${label}.${operator} must be a bounded non-empty array`);
    operand.forEach((entry, index) => predicate(entry, `${label}.${operator}[${index}]`, depth + 1));
  } else if (operator === "not") {
    predicate(operand, `${label}.not`, depth + 1);
  } else if (operator === "exists") {
    binding(operand, `${label}.exists`);
  } else {
    throw new Error(`${label} has an unsupported predicate operator: ${operator}`);
  }
}

function localState(value: unknown, label: string): void {
  const item = record(value, label);
  exactKeys(item, ["key", "type", "values", "default", "persist", "schema_version", "min", "max", "max_length", "max_items", "max_keys", "max_value_length", "lifetime", "reset_on_success", "empty_selection", "reset"], label);
  identifier(item.key, `${label}.key`);
  const types = ["string", "text", "boolean", "number", "integer", "enum", "set", "bounded-set", "keyed-text", "keyed_text"];
  if (typeof item.type !== "string" || !types.includes(item.type)) throw new Error(`${label}.type is unsupported`);
  if (item.schema_version !== undefined && (!Number.isSafeInteger(item.schema_version) || (item.schema_version as number) < 1)) throw new Error(`${label}.schema_version is invalid`);
  if (item.persist !== undefined && typeof item.persist !== "boolean") throw new Error(`${label}.persist must be boolean`);
  if (item.values !== undefined) {
    if (!Array.isArray(item.values) || item.values.length === 0 || item.values.length > 128) throw new Error(`${label}.values is invalid`);
    item.values.forEach((entry, index) => {
      if (typeof entry !== "string" || entry.length > 64) throw new Error(`${label}.values[${index}] is invalid`);
    });
    if (new Set(item.values).size !== item.values.length) throw new Error(`${label}.values contains duplicates`);
  }
  for (const key of ["max_length", "max_items", "max_keys", "max_value_length"] as const) {
    if (item[key] !== undefined && (!Number.isSafeInteger(item[key]) || (item[key] as number) < 1)) throw new Error(`${label}.${key} is invalid`);
  }
  if ((item.type === "set" || item.type === "bounded-set") && item.max_items === undefined) throw new Error(`${label}.max_items is required for a bounded set`);
  if ((item.type === "keyed-text" || item.type === "keyed_text") && (item.max_keys === undefined || item.max_value_length === undefined)) throw new Error(`${label} requires max_keys and max_value_length`);
  if (item.lifetime !== undefined && !["plugin", "navigation", "dialog"].includes(item.lifetime as string)) throw new Error(`${label}.lifetime is invalid`);
  if (item.reset_on_success !== undefined && typeof item.reset_on_success !== "boolean") throw new Error(`${label}.reset_on_success must be boolean`);
  if (item.default !== undefined) assertJsonSafe(item.default, `${label}.default`);
}

function resource(value: unknown, label: string): void {
  const item = record(value, label);
  exactKeys(item, ["id", "query", "input", "refresh", "dependency_policy", "debounce_ms"], label);
  identifier(item.id, `${label}.id`);
  identifier(item.query, `${label}.query`);
  if (item.input === undefined) throw new Error(`${label}.input is required`);
  bindingMap(item.input, `${label}.input`);
  if (item.refresh !== undefined && !["manual", "event", "mount"].includes(item.refresh as string)) throw new Error(`${label}.refresh is invalid`);
  if (item.dependency_policy !== undefined && !["manual", "immediate", "debounce"].includes(item.dependency_policy as string)) throw new Error(`${label}.dependency_policy is invalid`);
  if (item.debounce_ms !== undefined && (!Number.isSafeInteger(item.debounce_ms) || (item.debounce_ms as number) < 0 || (item.debounce_ms as number) > 60_000)) throw new Error(`${label}.debounce_ms is invalid`);
  if (item.dependency_policy === "debounce" && item.debounce_ms === undefined) throw new Error(`${label}.debounce_ms is required for debounce`);
}

function instructions(value: unknown, label: string, depth = 0): void {
  if (!Array.isArray(value) || value.length > 16) throw new Error(`${label} must contain at most 16 instructions`);
  if (depth > 8) throw new Error(`${label} is too deeply nested`);
  value.forEach((entry, index) => instruction(entry, `${label}[${index}]`, depth));
}

function instruction(value: unknown, label: string, depth: number): void {
  const item = record(value, label);
  const type = item.type;
  if (typeof type !== "string") throw new Error(`${label}.type is required`);
  switch (type) {
    case "local.set":
      exactKeys(item, ["type", "path", "value"], label); jsonPointer(item.path, `${label}.path`); binding(item.value, `${label}.value`); break;
    case "local.toggle":
      exactKeys(item, ["type", "path"], label); jsonPointer(item.path, `${label}.path`); break;
    case "dialog.open":
      exactKeys(item, ["type", "dialog"], label); identifier(item.dialog, `${label}.dialog`); break;
    case "dialog.close":
      exactKeys(item, ["type", "dialog"], label); if (item.dialog !== undefined) identifier(item.dialog, `${label}.dialog`); break;
    case "resource.refresh":
      exactKeys(item, ["type", "resource"], label); identifier(item.resource, `${label}.resource`); break;
    case "command.execute": {
      exactKeys(item, ["type", "command", "input", "expected_revision", "pending", "on_success", "on_error", "on_settled"], label);
      identifier(item.command, `${label}.command`);
      if (item.input === undefined) throw new Error(`${label}.input is required`);
      bindingMap(item.input, `${label}.input`);
      if (item.expected_revision !== undefined) binding(item.expected_revision, `${label}.expected_revision`);
      if (item.pending !== undefined) {
        const pending = record(item.pending, `${label}.pending`);
        exactKeys(pending, ["disable", "deduplicate"], `${label}.pending`);
        if (pending.disable !== undefined) identifier(pending.disable, `${label}.pending.disable`);
        if (pending.deduplicate !== undefined && typeof pending.deduplicate !== "boolean") throw new Error(`${label}.pending.deduplicate must be boolean`);
      }
      for (const branch of ["on_success", "on_error", "on_settled"] as const) if (item[branch] !== undefined) instructions(item[branch], `${label}.${branch}`, depth + 1);
      break;
    }
    case "target.focus":
      exactKeys(item, ["type", "target", "anchor", "annotation_id", "restore_context"], label);
      if (item.target !== undefined) binding(item.target, `${label}.target`);
      if (item.annotation_id !== undefined) binding(item.annotation_id, `${label}.annotation_id`);
      if (item.anchor === undefined) throw new Error(`${label}.anchor is required`);
      binding(item.anchor, `${label}.anchor`);
      if (item.restore_context !== undefined && typeof item.restore_context !== "boolean") throw new Error(`${label}.restore_context must be boolean`);
      break;
    case "target.reload":
      exactKeys(item, ["type", "target"], label); if (item.target !== undefined) binding(item.target, `${label}.target`); break;
    case "navigate.internal":
      exactKeys(item, ["type", "path", "replace"], label); binding(item.path, `${label}.path`);
      if (item.replace !== undefined && typeof item.replace !== "boolean") throw new Error(`${label}.replace must be boolean`);
      break;
    case "navigate.external": {
      exactKeys(item, ["type", "url", "confirmation", "user_gesture"], label);
      binding(item.url, `${label}.url`);
      const urlBinding = item.url as Record<string, unknown>;
      if (typeof urlBinding.literal === "string") {
        let parsed: URL;
        try { parsed = new URL(urlBinding.literal); } catch { throw new Error(`${label}.url must be an absolute URL`); }
        if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username !== "" || parsed.password !== "") throw new Error(`${label}.url must be credential-free http/https`);
      }
      if (item.confirmation === undefined) throw new Error(`${label}.confirmation is required`);
      if (typeof item.confirmation !== "boolean" && typeof item.confirmation !== "string") throw new Error(`${label}.confirmation is invalid`);
      if (item.user_gesture !== true) throw new Error(`${label}.user_gesture must be true`);
      break;
    }
    case "toast.show":
      exactKeys(item, ["type", "variant", "message", "duration_ms"], label);
      if (item.variant !== undefined && !["info", "success", "warning", "error"].includes(item.variant as string)) throw new Error(`${label}.variant is invalid`);
      binding(item.message, `${label}.message`);
      if (item.duration_ms !== undefined && (!Number.isSafeInteger(item.duration_ms) || (item.duration_ms as number) < 0 || (item.duration_ms as number) > 60_000)) throw new Error(`${label}.duration_ms is invalid`);
      break;
    default:
      throw new Error(`${label}.type is unsupported`);
  }
}

function props(value: unknown, component: string, label: string): void {
  const item = record(value, label);
  const allowed = new Set([...(COMPONENT_PROPS[component] ?? []), ...COMMON_PROPS]);
  const unexpected = Object.keys(item).find((key) => !allowed.has(key));
  if (unexpected) {
    if (EXECUTABLE_KEYS.has(unexpected.toLowerCase())) throw new Error(`${label} contains forbidden field: ${unexpected}`);
    throw new Error(`${label} contains unsupported field: ${unexpected}`);
  }
  for (const [key, child] of Object.entries(item)) binding(child, `${label}.${key}`);
}

export function parsePluginUiDocument(value: unknown, byteLength?: number): PluginUiDocumentV1 {
  if (byteLength !== undefined && (!Number.isSafeInteger(byteLength) || byteLength < 0)) throw new Error("plugin UI document byte length is invalid");
  let encodedLength: number;
  try { encodedLength = Buffer.byteLength(JSON.stringify(value), "utf8"); } catch { throw new Error("plugin UI document must be JSON-safe"); }
  if ((byteLength ?? encodedLength) > PLUGIN_UI_DOCUMENT_MAX_BYTES || encodedLength > PLUGIN_UI_DOCUMENT_MAX_BYTES) throw new Error("plugin UI document is too large");

  const document = record(value, "plugin UI document");
  exactKeys(document, ["schema_version", "local_state", "resources", "root"], "plugin UI document");
  if (document.schema_version !== 1) throw new Error("plugin UI document schema_version must be 1");
  if (document.local_state !== undefined && (!Array.isArray(document.local_state) || document.local_state.length > 128)) throw new Error("plugin UI local_state is invalid");
  if (document.resources !== undefined && (!Array.isArray(document.resources) || document.resources.length > 64)) throw new Error("plugin UI resources is invalid");

  const stateKeys = new Set<string>();
  (document.local_state ?? []).forEach((entry, index) => {
    localState(entry, `plugin UI local_state[${index}]`);
    const key = (entry as Record<string, unknown>).key as string;
    if (stateKeys.has(key)) throw new Error(`plugin UI local_state key is duplicated: ${key}`);
    stateKeys.add(key);
  });
  const resourceIds = new Set<string>();
  (document.resources ?? []).forEach((entry, index) => {
    resource(entry, `plugin UI resources[${index}]`);
    const id = (entry as Record<string, unknown>).id as string;
    if (resourceIds.has(id)) throw new Error(`plugin UI resource id is duplicated: ${id}`);
    resourceIds.add(id);
  });

  const ids = new Set<string>();
  let nodeCount = 0;
  const parseNode = (input: unknown, depth: number, label: string): PluginUiNodeV1 => {
    if (depth > PLUGIN_UI_DOCUMENT_MAX_DEPTH) throw new Error("plugin UI tree is too deep");
    if (++nodeCount > PLUGIN_UI_DOCUMENT_MAX_NODES) throw new Error("plugin UI document has too many nodes");
    const node = record(input, label);
    exactKeys(node, ["id", "type", "props", "when", "repeat", "on", "children"], label);
    if (typeof node.type !== "string" || !COMPONENTS.has(node.type)) throw new Error(`${label}.type is unsupported`);
    if (node.id !== undefined) {
      const id = identifier(node.id, `${label}.id`);
      if (ids.has(id)) throw new Error(`${label}.id is invalid or duplicated`);
      ids.add(id);
    }
    if (node.props !== undefined) props(node.props, node.type, `${label}.props`);
    if (node.when !== undefined) predicate(node.when, `${label}.when`);
    if (node.repeat !== undefined) {
      const repeat = record(node.repeat, `${label}.repeat`);
      exactKeys(repeat, ["source", "key"], `${label}.repeat`);
      binding(repeat.source, `${label}.repeat.source`);
      binding(repeat.key, `${label}.repeat.key`);
    }
    if (node.on !== undefined) {
      const on = record(node.on, `${label}.on`);
      const allowedEvents = COMPONENT_EVENTS[node.type] ?? [];
      for (const [event, handlers] of Object.entries(on)) {
        if (!allowedEvents.includes(event)) throw new Error(`${label}.on contains unsupported event: ${event}`);
        instructions(handlers, `${label}.on.${event}`);
      }
    }
    if (node.children !== undefined && !Array.isArray(node.children)) throw new Error(`${label}.children must be an array`);
    return {
      ...(node.id === undefined ? {} : { id: node.id as string }),
      type: node.type,
      ...(node.props === undefined ? {} : { props: node.props as Readonly<Record<string, unknown>> }),
      ...(node.when === undefined ? {} : { when: node.when as Readonly<Record<string, unknown>> }),
      ...(node.repeat === undefined ? {} : { repeat: node.repeat as Readonly<Record<string, unknown>> }),
      ...(node.on === undefined ? {} : { on: node.on as Readonly<Record<string, unknown[]>> }),
      ...(node.children === undefined ? {} : { children: node.children.map((child, index) => parseNode(child, depth + 1, `${label}.children[${index}]`)) }),
    };
  };

  return {
    schema_version: 1,
    ...(document.local_state === undefined ? {} : { local_state: structuredClone(document.local_state as unknown[]) }),
    ...(document.resources === undefined ? {} : { resources: structuredClone(document.resources as unknown[]) }),
    root: parseNode(document.root, 1, "plugin UI root"),
  };
}
