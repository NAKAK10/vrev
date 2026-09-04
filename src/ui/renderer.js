const root = document.querySelector("#renderer-root");
const resourceStores = new Map();
const resourceRequestGenerations = new Map();
const documents = new Map();
const pending = new Map();
const dialogs = new Map();
const formDrafts = new Map();
const dialogOpeners = new WeakMap();
const pluginRuntimeCleanups = new Map();
let surface;
// A `?page=<repo-relative path>` deep link, consumed by the target-stage's first load only.
let initialPagePath = null;
let settingsRenderPromise = null;
let activeToast = null;
let deferredReviewRender = false;
const reviewSelection = { annotation_id: null, page_path: null, anchor: null };
let activeSelection = null;
const DISCLOSURE_SEEN_KEY = "vrev.disclosure-seen/v1";
const disclosureSeenValues = (() => {
  try {
    const value = JSON.parse(localStorage.getItem(DISCLOSURE_SEEN_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
})();
function disclosureAttentionValue(value) {
  if (value === undefined || value === null || value === "" || value === 0 || value === false) return "";
  try { return JSON.stringify(value); } catch { return String(value); }
}
function markDisclosureSeen(node) {
  const key = node.dataset.attentionKey;
  const value = node.dataset.attentionValue;
  if (!key || !value) return;
  disclosureSeenValues[key] = value;
  try { localStorage.setItem(DISCLOSURE_SEEN_KEY, JSON.stringify(disclosureSeenValues)); } catch {}
  const indicator = node.querySelector(":scope > summary .vr-attention-indicator");
  if (indicator) indicator.hidden = true;
  node.classList.remove("has-unread-attention");
  const summary = node.querySelector(":scope > summary");
  if (summary?.dataset.baseLabel) summary.setAttribute("aria-label", summary.dataset.baseLabel);
}
const THEME_TOKENS = new Map([
  ["canvas", "--vr-color-canvas"], ["surface", "--vr-color-surface"], ["surface_subtle", "--vr-color-surface-subtle"],
  ["surface_strong", "--vr-color-surface-strong"], ["text", "--vr-color-text"], ["text_muted", "--vr-color-text-muted"],
  ["border", "--vr-color-border"], ["border_strong", "--vr-color-border-strong"], ["accent", "--vr-color-accent"],
  ["accent_hover", "--vr-color-accent-hover"], ["accent_soft", "--vr-color-accent-soft"], ["focus", "--vr-color-focus"],
  ["success", "--vr-color-success"], ["warning", "--vr-color-warning"], ["danger", "--vr-color-danger"],
]);

function applyTheme(theme) {
  root.dataset.theme = typeof theme?.id === "string" ? theme.id : "default";
  for (const [key, property] of THEME_TOKENS) {
    const value = theme?.tokens?.[key];
    if (typeof value === "string" && /^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([^;{}]+\))$/i.test(value)) root.style.setProperty(property, value);
  }
}

function pointer(value, path = "") {
  if (path === "") return value;
  return path.split("/").slice(1).reduce((item, raw) => item?.[raw.replaceAll("~1", "/").replaceAll("~0", "~")], value);
}
function binding(value, scope) {
  if (!value || typeof value !== "object") return undefined;
  if ("literal" in value) return value.literal;
  if (value.generated === "uuid") return crypto.randomUUID();
  if (value.generated === "timestamp") return new Date().toISOString();
  if ("resource" in value) return pointer(resourceStores.get(`${value.plugin || scope.plugin}:${value.resource}`)?.data, value.path || "");
  if ("local" in value) return pointer(scope.state, value.local);
  if ("item" in value) return pointer(scope.item, value.item);
  if ("event" in value) return pointer(scope.event, value.event);
  if ("slot_context" in value || "slot-context" in value || "slot" in value) return pointer(scope.slotContext, value.slot_context ?? value["slot-context"] ?? value.slot);
  if ("result" in value || "command" in value) return pointer(scope.result, value.result ?? value.command);
  if ("error" in value) return pointer(scope.error, value.error);
  if ("form" in value) return scope.form?.get(value.form) ?? "";
}
function predicate(value, scope) {
  if (typeof value === "boolean") return value;
  if ("literal" in value) return value.literal;
  if ("exists" in value) return binding(value.exists, scope) !== undefined;
  if ("not" in value) return !predicate(value.not, scope);
  if ("and" in value) return value.and.every((item) => predicate(item, scope));
  if ("or" in value) return value.or.some((item) => predicate(item, scope));
  const operands = value.eq ?? value.equals ?? value.ne ?? value.not_equals ?? value.in;
  if (!operands) return false;
  const left = binding(operands[0], scope); const right = binding(operands[1], scope);
  if (value.in) return Array.isArray(right) && right.includes(left);
  return value.ne || value.not_equals ? !Object.is(left, right) : Object.is(left, right);
}
function lengthWithin(length, minimum, maximum) { return (minimum === undefined || length >= minimum) && (maximum === undefined || length <= maximum); }
function rangeWithin(value, minimum, maximum) { return (minimum === undefined || value >= minimum) && (maximum === undefined || value <= maximum); }
// Bounded JSON-schema subset matcher, ported from src/plugin-host-runtime.ts. Extension points
// alone may set object schemas to `additionalProperties: true`, meaning "opaque object, extra
// keys allowed" (needed for anchors/annotation projections passed as slot context/events).
function matchesSchema(value, schema) {
  if (!schema || typeof schema !== "object") return false;
  if (schema.enum !== undefined && !schema.enum.some((candidate) => Object.is(candidate, value))) return false;
  switch (schema.type) {
    case "null": return value === null;
    case "string": return typeof value === "string" && lengthWithin(value.length, schema.minLength, schema.maxLength);
    case "number": return typeof value === "number" && Number.isFinite(value) && rangeWithin(value, schema.minimum, schema.maximum);
    case "integer": return typeof value === "number" && Number.isSafeInteger(value) && rangeWithin(value, schema.minimum, schema.maximum);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value) && lengthWithin(value.length, schema.minItems, schema.maxItems)
      && value.every((item) => matchesSchema(item, schema.items));
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const properties = schema.properties || {};
      const object = value;
      if (schema.additionalProperties !== true && Object.keys(object).some((key) => !(key in properties))) return false;
      if ((schema.required || []).some((key) => !(key in object))) return false;
      return Object.entries(object).every(([key, item]) => !(key in properties) || matchesSchema(item, properties[key]));
    }
    default: return false;
  }
}
function contributionLocalState(contribution) {
  const key = `vrev:renderer:1:${contribution.plugin_id}:${contribution.id}`;
  const state = {};
  for (const declaration of contribution.document.local_state || []) state[declaration.key] = structuredClone(declaration.default);
  try {
    const stored = JSON.parse(localStorage.getItem(key) || "null");
    if (stored?.schema_version === 1 && stored.values && typeof stored.values === "object") Object.assign(state, stored.values);
  } catch {}
  return { state, persist() {
    const allowed = {};
    for (const declaration of contribution.document.local_state || []) if (declaration.persist) allowed[declaration.key] = state[declaration.key];
    try { localStorage.setItem(key, JSON.stringify({ schema_version: 1, values: allowed })); } catch {}
  } };
}
// Local state is namespaced per plugin (not per contribution) for root instances: every
// root contribution of a plugin declares into and reads from one shared state object, so a
// header contribution's local state can be bound from that plugin's stage contribution.
function pluginLocalStateDeclarations(pluginId) {
  const declarations = new Map();
  for (const contribution of surface?.contributions || []) {
    if (contribution.plugin_id !== pluginId) continue;
    for (const declaration of contribution.document.local_state || []) if (!declarations.has(declaration.key)) declarations.set(declaration.key, declaration);
  }
  return [...declarations.values()];
}
function pluginLocalState(pluginId) {
  const declarations = pluginLocalStateDeclarations(pluginId);
  const state = {};
  for (const declaration of declarations) state[declaration.key] = structuredClone(declaration.default);
  const key = `vrev:renderer:2:${pluginId}`;
  let restored = false;
  try {
    const stored = JSON.parse(localStorage.getItem(key) || "null");
    if (stored?.schema_version === 1 && stored.values && typeof stored.values === "object") { Object.assign(state, stored.values); restored = true; }
  } catch {}
  if (!restored) {
    for (const contribution of surface?.contributions || []) {
      if (contribution.plugin_id !== pluginId) continue;
      try {
        const legacy = JSON.parse(localStorage.getItem(`vrev:renderer:1:${pluginId}:${contribution.id}`) || "null");
        if (legacy?.schema_version === 1 && legacy.values && typeof legacy.values === "object") Object.assign(state, legacy.values);
      } catch {}
    }
  }
  return { state, persist() {
    const allowed = {};
    for (const declaration of declarations) if (declaration.persist) allowed[declaration.key] = state[declaration.key];
    try { localStorage.setItem(key, JSON.stringify({ schema_version: 1, values: allowed })); } catch {}
  } };
}
function runtimeFor(contribution, parentInstanceKey = "") {
  const key = parentInstanceKey ? `${contribution.plugin_id}:${contribution.id}:${parentInstanceKey}` : `${contribution.plugin_id}:root`;
  let runtime = documents.get(key);
  if (!runtime) { runtime = parentInstanceKey ? contributionLocalState(contribution) : pluginLocalState(contribution.plugin_id); documents.set(key, runtime); }
  return runtime;
}
function declarationsFor(scope) {
  return scope.instanceKey ? (scope.contribution.document.local_state || []) : pluginLocalStateDeclarations(scope.plugin);
}
function cleanupPluginRuntimes() {
  for (const [rootElement, cleanup] of pluginRuntimeCleanups) {
    if (rootElement.isConnected) continue;
    try { cleanup(); } catch {}
    pluginRuntimeCleanups.delete(rootElement);
  }
}
async function mountPluginRuntime(contribution, rootElement) {
  if (!contribution.browser_module_url || !(rootElement instanceof HTMLElement)) return;
  try {
    const runtime = await import(contribution.browser_module_url);
    if (!rootElement.isConnected || typeof runtime.mount !== "function") return;
    const cleanup = await runtime.mount(Object.freeze({
      root: rootElement,
      pluginId: contribution.plugin_id,
      contributionId: contribution.id,
      slot: contribution.slot,
      toast: (message, variant = "info") => toast(String(message), variant),
    }));
    if (typeof cleanup === "function") pluginRuntimeCleanups.set(rootElement, cleanup);
  } catch (error) {
    // Browser modules are progressive enhancement. A remount race must not
    // turn a successful declarative filter update into an error toast.
    console.error("Plugin UI runtime failed to mount", contribution.plugin_id, contribution.id, error);
  }
}

function setPointer(target, path, value) {
  const parts = path.split("/").slice(1).map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (!parts.length) return;
  let current = target;
  for (const part of parts.slice(0, -1)) current = current[part] ??= {};
  current[parts.at(-1)] = value;
}
function element(name, className) { const node = document.createElement(name); if (className) node.className = className; return node; }
function safeKey(value) { return String(value ?? "item").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "item"; }
function instanceId(scope, id) { return scope.instanceKey ? `${id}--${safeKey(scope.instanceKey)}` : id; }
function dialogFor(scope, id) { return dialogs.get(`${scope.instanceKey || "root"}:${id}`) || document.getElementById(instanceId(scope, id)); }
function showDialog(dialog, scope, definition) {
  if (!(dialog instanceof HTMLDialogElement) || dialog.open) return;
  dialogOpeners.set(dialog, document.activeElement);
  for (const slot of dialog.querySelectorAll(".vr-slot")) slot.__renderSlot?.();
  dialog.showModal();
  dialog.scrollTop = 0;
  requestAnimationFrame(() => {
    const requested = binding(definition?.props?.initial_focus, scope);
    const target = requested ? dialog.querySelector(`#${CSS.escape(instanceId(scope, requested))}`) : null;
    (target || dialog.querySelector("input,textarea,select,button,[tabindex]:not([tabindex='-1'])"))?.focus();
  });
}
function closeDialog(dialog) { if (dialog instanceof HTMLDialogElement && dialog.open) dialog.close(); }
function announceFocusFailure(message) { toast(message || "対象を表示できませんでした。", "error"); }
function props(node, definition, scope) {
  const result = {};
  for (const [key, value] of Object.entries(definition || {})) result[key] = binding(value, scope);
  if (result.hidden) node.hidden = true;
  if (result.disabled && "disabled" in node) node.disabled = true;
  if (result.busy) node.setAttribute("aria-busy", "true");
  if (result.label && !["BUTTON", "INPUT", "TEXTAREA", "SELECT"].includes(node.tagName)) node.setAttribute("aria-label", String(result.label));
  if (result.variant) node.dataset.variant = String(result.variant);
  if (result.tone) node.dataset.tone = String(result.tone);
  if (result.size) node.dataset.size = String(result.size);
  if (result.pressed !== undefined) node.setAttribute("aria-pressed", String(Boolean(result.pressed)));
  return result;
}
function controlValue(node) {
  if (node.type === "checkbox") return node.checked;
  if (node instanceof HTMLInputElement && node.type === "number") return Number.isFinite(node.valueAsNumber) ? node.valueAsNumber : node.value;
  return node.value;
}
function control(node, nodeProps, scope) {
  if (nodeProps.name) node.name = String(nodeProps.name);
  const draftKey = `${scope.plugin}:${scope.contribution.id}:${scope.instanceKey || "root"}:${nodeProps.name || node.id}`;
  if (nodeProps.value !== undefined) node.value = Array.isArray(nodeProps.value) ? nodeProps.value.join(",") : String(nodeProps.value);
  else if (formDrafts.has(draftKey)) node.value = formDrafts.get(draftKey);
  if (nodeProps.placeholder) node.placeholder = String(nodeProps.placeholder);
  if (nodeProps.required) node.required = true;
  if (nodeProps.readonly) node.readOnly = true;
  if (nodeProps.min !== undefined) node.min = String(nodeProps.min);
  if (nodeProps.max !== undefined) node.max = String(nodeProps.max);
  if (nodeProps.min_length) node.minLength = Number(nodeProps.min_length);
  if (nodeProps.max_length) node.maxLength = Number(nodeProps.max_length);
  if (nodeProps.rows) node.rows = Number(nodeProps.rows);
  if (nodeProps.autocomplete) node.autocomplete = String(nodeProps.autocomplete);
  if (nodeProps.description) node.setAttribute("aria-description", String(nodeProps.description));
  if (nodeProps.error) { node.setAttribute("aria-invalid", "true"); node.setAttribute("aria-errormessage", String(nodeProps.error)); }
  node.addEventListener("input", () => {
    const value = controlValue(node);
    formDrafts.set(draftKey, value);
    const declaration = declarationsFor(scope).find(({ key }) => `/${key}` === scope.valuePath);
    if (declaration) { scope.state[declaration.key] = value; scope.persist(); }
  });
}
function renderCheckboxGroup(node, values, definition, scope) {
  node.setAttribute("role", "group");
  if (values.label) node.setAttribute("aria-label", String(values.label));
  const selected = new Set(Array.isArray(values.value) ? values.value : []);
  for (const option of values.options || []) {
    const value = typeof option === "object" ? option.value : option;
    const label = element("label", "vr-checkbox-option"); const input = element("input"); input.type = "checkbox"; input.value = String(value); input.checked = values.inverted === true ? !selected.has(value) : selected.has(value); const text = element("span"); text.textContent = String(typeof option === "object" ? option.label : option); label.append(input, text); node.append(label);
    input.addEventListener("change", () => { if (values.inverted === true) { input.checked ? selected.delete(value) : selected.add(value); } else { input.checked ? selected.add(value) : selected.delete(value); } void execute([{ type: "local.set", path: definition.props.value.local, value: { literal: [...selected] } }], { ...scope, event: { value: [...selected] } }); });
  }
}
function prepareDialog(node, values, definition, scope) {
  const base = definition.id || "dialog"; const titleId = `${instanceId(scope, base)}-title`; const descriptionId = `${instanceId(scope, base)}-description`;
  const header = element("header", "vr-dialog-header");
  if (values.title) { const title = element("h2", "vr-dialog-title"); title.id = titleId; title.textContent = String(values.title); header.append(title); node.setAttribute("aria-labelledby", titleId); }
  if (values.description || values.message) { const description = element("p", "vr-dialog-description"); description.id = descriptionId; description.textContent = String(values.description ?? values.message); header.append(description); node.setAttribute("aria-describedby", descriptionId); }
  const body = element("div", "vr-dialog-body"); node.append(header, body); node.__content = body;
  node.dataset.mobilePresentation = String(values.mobile_presentation || "modal");
  const dismiss = () => closeDialog(node);
  if (values.dismissible !== false) { const close = element("button", "vr-dialog-close"); close.type = "button"; close.setAttribute("aria-label", "閉じる"); close.textContent = "×"; close.addEventListener("click", dismiss); node.prepend(close); }
  node.addEventListener("close", () => { const requested = binding(definition.props?.return_focus, scope); const target = requested ? document.getElementById(instanceId(scope, requested)) : dialogOpeners.get(node); target?.focus?.(); });
  if (values.open) queueMicrotask(() => showDialog(node, scope, definition));
}
function renderNode(definition, scope) {
  if (definition.when !== undefined && !predicate(definition.when, scope)) return document.createDocumentFragment();
  if (definition.repeat) {
    const fragment = document.createDocumentFragment();
    const items = binding(definition.repeat.source, scope) || [];
    for (const [index, item] of (Array.isArray(items) ? items : []).entries()) {
      const itemScope = { ...scope, item };
      const repeatKey = safeKey(binding(definition.repeat.key, itemScope) ?? index);
      fragment.append(renderSingle(definition, { ...itemScope, repeatKey, instanceKey: [scope.instanceKey, repeatKey].filter(Boolean).join("--") }));
    }
    return fragment;
  }
  return renderSingle(definition, scope);
}
function renderSingle(definition, scope) {
  let node;
  const type = definition.type;
  const className = `vr-${type}`;
  if (["app-shell", "stack", "row", "panel", "toolbar", "split-panel", "slot"].includes(type)) node = element(type === "toolbar" ? "div" : "div", className);
  else if (["header", "section"].includes(type)) node = element(type, className);
  else if (type === "heading") node = element(`h${Math.min(6, Math.max(1, Number(binding(definition.props?.level, scope) || 2)))}`, className);
  else if (["text", "status", "count", "badge", "time", "code", "live-status"].includes(type)) node = element(type === "code" ? "code" : "p", className);
  else if (type === "empty-state") node = element("div", className);
  else if (type === "button" || type === "load-more") { node = element("button", className); node.type = "button"; }
  else if (type === "link") node = element("a", className);
  else if (type === "input") node = element("input", className);
  else if (type === "textarea") node = element("textarea", className);
  else if (type === "selection-mode-selector") node = element("div", className);
  else if (type === "select" || type === "viewport-selector") node = element("select", className);
  else if (["switch", "checkbox"].includes(type)) { node = element("input", className); node.type = "checkbox"; if (type === "switch") node.setAttribute("role", "switch"); }
  else if (type === "form") node = element("form", className);
  else if (type === "fieldset") node = element("fieldset", className);
  else if (type === "legend") node = element("legend", className);
  else if (type === "list") node = element("div", className);
  else if (type === "disclosure") { node = element("details", className); const summary = element("summary"); summary.textContent = String(binding(definition.props?.label, scope) || ""); node.append(summary); }
  else if (type.includes("dialog")) node = element("dialog", className);
  else if (type === "toast-region") { node = element("div", "toast-region"); node.setAttribute("role", "status"); node.setAttribute("aria-live", "polite"); }
  else if (type === "safe-markdown") node = safeMarkdown(String(binding(definition.props?.value ?? definition.props?.content, scope) || ""));
  else if (type === "target-stage") node = targetStage(definition, scope);
  else if (type === "annotation-mark-layer") node = element("div", className);
  else node = element("div", className);
  if (definition.id) {
    node.id = instanceId(scope, definition.id);
    node.dataset.definitionId = definition.id;
    if (node instanceof HTMLDialogElement) dialogs.set(`${scope.instanceKey || "root"}:${definition.id}`, node);
  }
  const values = props(node, definition.props, scope);
  if (["text", "heading", "badge", "status", "time", "code", "legend", "live-status"].includes(type)) node.textContent = String(values.text ?? values.value ?? values.message ?? values.label ?? "");
  if (type === "empty-state") {
    if (values.title) { const title = element("h3", "vr-empty-state-title"); title.textContent = String(values.title); node.append(title); }
    if (values.message) { const message = element("p", "vr-empty-state-message"); message.textContent = String(values.message); node.append(message); }
  }
  if (type === "status" && values.label) node.textContent = String(values.label);
  if (type === "status" && values.value !== undefined) node.dataset.status = String(values.value);
  if (type === "time" && values.value) { node.dateTime = String(values.value); const date = new Date(values.value); if (!Number.isNaN(date.getTime())) node.textContent = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date); }
  if (type === "live-status") { node.setAttribute("role", "status"); node.setAttribute("aria-live", values.politeness === "assertive" ? "assertive" : "polite"); }
  if (type === "count") node.textContent = `${values.value ?? 0}${values.label ? ` ${values.label}` : ""}`;
  if ((type === "section" || type === "panel") && values.title) { const title = element(type === "section" ? "h2" : "h3", "vr-section-title"); title.textContent = String(values.title); node.append(title); if (values.description) { const description = element("p", "vr-section-description"); description.textContent = String(values.description); node.append(description); } }
  if (type === "panel" && values.aria_label) node.setAttribute("aria-label", String(values.aria_label));
  if (type === "button" || type === "load-more") { node.textContent = String(values.label || ""); if (values.type) node.type = String(values.type); }
  if (type === "button" && (definition.on?.click || []).some((instruction) => instruction.type === "selection.activate")) node.setAttribute("aria-pressed", "false");
  if (type === "link") { node.textContent = String(values.label || ""); if (typeof values.href === "string") node.href = values.href; if (values.external) { node.target = "_blank"; node.rel = "noopener noreferrer"; } }
  if (["input", "textarea"].includes(type)) { if (type === "input" && values.type) node.type = String(values.type); control(node, values, { ...scope, valuePath: definition.props?.value?.local }); if (values.label) node.setAttribute("aria-label", String(values.label)); }
  if (["select", "viewport-selector"].includes(type)) {
    control(node, values, { ...scope, valuePath: definition.props?.value?.local });
    node.__optionValues = new Map();
    for (const option of values.options || []) { const rawValue = typeof option === "object" ? option.value : option; const child = element("option"); child.value = String(rawValue); child.textContent = String(typeof option === "object" ? option.label : option); node.__optionValues.set(child.value, rawValue); node.append(child); }
    node.value = String(values.value ?? ""); if (values.label) node.setAttribute("aria-label", String(values.label));
  }
  if (type === "selection-mode-selector") {
    node.setAttribute("role", "toolbar");
    const shortcuts = { browse: "V", node: "N", region: "R" };
    for (const option of values.options || []) {
      const rawValue = typeof option === "object" ? option.value : option;
      const label = typeof option === "object" ? option.label : option;
      const button = element("button", "vr-selection-mode-button"); button.type = "button"; button.dataset.value = String(rawValue); button.disabled = Boolean(values.disabled); button.setAttribute("aria-pressed", String(rawValue === values.value));
      const text = element("span"); text.textContent = String(label); button.append(text);
      if (shortcuts[rawValue]) { const key = element("kbd"); key.textContent = shortcuts[rawValue]; button.append(key); button.setAttribute("aria-keyshortcuts", shortcuts[rawValue]); }
      button.addEventListener("click", () => node.dispatchEvent(new CustomEvent("change", { detail: { value: rawValue } })));
      node.append(button);
    }
  }
  if (["switch", "checkbox"].includes(type)) { control(node, values, { ...scope, valuePath: definition.props?.checked?.local }); node.checked = Boolean(values.checked); if (values.label) node.setAttribute("aria-label", String(values.label)); }
  if (type === "checkbox-group") renderCheckboxGroup(node, values, definition, scope);
  if (type.includes("dialog")) prepareDialog(node, values, definition, scope);
  if (type === "disclosure") {
    node.open = Boolean(values.expanded);
    node.__committedOpen = node.open;
    const summary = node.querySelector(":scope > summary");
    const label = String(values.label || "");
    if (summary) summary.dataset.baseLabel = label;
    const attentionKey = String(values.attention_key || "");
    const attentionValue = disclosureAttentionValue(values.attention_value);
    if (summary && attentionKey && attentionValue) {
      const scopedKey = `${scope.plugin}:${attentionKey}`;
      node.dataset.attentionKey = scopedKey;
      node.dataset.attentionValue = attentionValue;
      const unread = !node.open && disclosureSeenValues[scopedKey] !== attentionValue;
      const indicator = element("span", "vr-attention-indicator");
      indicator.hidden = !unread;
      node.classList.toggle("has-unread-attention", unread);
      indicator.setAttribute("aria-hidden", "true");
      summary.append(indicator);
      summary.setAttribute("aria-label", unread ? `${label}、未確認の更新あり` : label);
      if (node.open) queueMicrotask(() => markDisclosureSeen(node));
      node.addEventListener("toggle", () => { if (node.open) markDisclosureSeen(node); });
    }
  }
  if (type === "annotation-mark-layer") { node.setAttribute("aria-hidden", "true"); node.__marks = Array.isArray(values.marks) ? values.marks : []; node.__selectedId = values.selected_id ?? reviewSelection.annotation_id; }
  bindEvents(node, definition, scope);
  for (const child of definition.children || []) (node.__content || node).append(renderNode(child, scope));
  if (type === "list" && values.empty_message && node.childElementCount === 0) { const empty = element("p", "vr-empty-state"); empty.textContent = String(values.empty_message); node.append(empty); }
  if (type === "slot") {
    // The slot context can change after the initial render (e.g. review.selection is committed
    // before the host dialog opens), so keep the renderer callable and re-run it from showDialog.
    node.__renderSlot = () => renderSlot(node, definition, scope);
    node.__renderSlot();
  }
  if (["input", "textarea", "select", "switch", "checkbox", "viewport-selector"].includes(type) && values.label) {
    const field = element("label", `vr-field vr-field-${type}`);
    const label = element("span", "vr-field-label"); label.textContent = String(values.label);
    if (type === "switch" || type === "checkbox") field.append(node, label); else field.append(label, node);
    if (values.description) { const description = element("span", "vr-field-description"); description.textContent = String(values.description); field.append(description); }
    return field;
  }
  return node;
}
function renderSlot(node, definition, scope) {
  node.replaceChildren();
  const slot = String(binding(definition.props?.name, scope) || "");
  const point = (surface.extension_points || []).find((item) => item.id === slot);
  if (!point) {
    // A Core slot name used inside a plugin document is invalid at surface load time and
    // should not reach the renderer; render nothing defensively rather than guessing a shape.
    node.hidden = true;
    return;
  }
  const contextValue = binding(definition.props?.context, scope) ?? scope.slotContext;
  if (!matchesSchema(contextValue, point.context_schema)) {
    console.warn("extension point context is invalid", slot);
    node.hidden = true;
    return;
  }
  const matches = surface.contributions.filter((item) => item.slot === slot);
  for (const contribution of matches) node.append(renderContribution(contribution, contextValue, scope.instanceKey, { definition, scope, point }));
  node.hidden = matches.length === 0;
}
function bindEvents(node, definition, scope) {
  // A slot node's `on` map holds handlers for events a contributor emits via `slot.emit`, not
  // DOM events on the slot's host element — those are dispatched directly from execute().
  if (definition.type === "slot") return;
  for (const [name, instructions] of Object.entries(definition.on || {})) {
    const eventName = ({ change: "change", input: "input", click: "click", submit: "submit", toggle: "toggle", close: "close", cancel: "cancel", confirm: "click" })[name] || name;
    node.addEventListener(eventName, (event) => {
      if (definition.type === "disclosure" && eventName === "toggle") {
        if (node.__committedOpen === node.open) return;
        node.__committedOpen = node.open;
      }
      if (definition.type === "panel" && eventName === "click" && event.target !== node && event.target.closest("button,a,input,textarea,select,form,[role='button']")) return;
      if (eventName === "submit") {
        event.preventDefault();
        if (!node.checkValidity()) { node.reportValidity(); return; }
      }
      if (name === "selection-commit" && event.detail?.selection) { reviewSelection.anchor = event.detail.selection; reviewSelection.page_path = event.detail.selection.page_path ?? null; scope.slotContext.review = { selection: reviewSelection }; }
      const eventData = event.detail ?? (name === "toggle" ? { expanded: node.open } : { value: node.__optionValues?.get(node.value) ?? controlValue(node) });
      void execute(instructions, { ...scope, event: eventData, form: formValues(node), trigger: node, preserveDisclosureDom: definition.type === "disclosure" && eventName === "toggle" });
    });
  }
  if (definition.type === "panel" && definition.on?.click) {
    node.classList.add("is-clickable"); node.tabIndex = 0;
    node.addEventListener("keydown", (event) => { if (event.target === node && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); node.click(); } });
  }
  if (node instanceof HTMLFormElement) node.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); node.requestSubmit(); }
  });
}
function formValues(node) {
  const form = node instanceof HTMLFormElement ? node : node.closest?.("form");
  return form ? new Map([...new FormData(form).entries()]) : new Map();
}
function findNodeDefinition(node, id) { if (node.id === id) return node; for (const child of node.children || []) { const found = findNodeDefinition(child, id); if (found) return found; } }
async function refreshLocalDependencies(scope, path) {
  const key = path.split("/")[1];
  // Root state is shared across every root contribution of the plugin, so a change made
  // in one contribution's document (e.g. the header) can drive a resource declared by another
  // (e.g. the stage). Repeated (instance-scoped) state stays limited to its own contribution.
  const owners = scope.instanceKey ? [scope.contribution] : (surface?.contributions || []).filter((contribution) => contribution.plugin_id === scope.plugin);
  const loads = owners.flatMap((contribution) => (contribution.document.resources || [])
    .filter((resource) => Object.values(resource.input || {}).some((value) => value?.local === `/${key}`))
    .map((resource) => loadResource(contribution, resource.id, scope, false)));
  await Promise.all(loads);
}
function targetUrlForPage(target, pagePath) {
  if (!pagePath) return target.url;
  if (target.live_url) { try { const value = new URL(pagePath, target.live_url); return `/live${value.pathname}${value.search}${value.hash}`; } catch {} }
  return `/target/${String(pagePath).replace(/^\/+/, "").split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
}
function waitForFrame(frame) { return new Promise((resolve, reject) => { const timer = setTimeout(() => { cleanup(); reject(new Error("対象ページの読み込みがタイムアウトしました")); }, 8000); const cleanup = () => { clearTimeout(timer); frame.removeEventListener("load", loaded); frame.removeEventListener("error", failed); }; const loaded = () => { cleanup(); resolve(); }; const failed = () => { cleanup(); reject(new Error("対象ページを読み込めませんでした")); }; frame.addEventListener("load", loaded, { once: true }); frame.addEventListener("error", failed, { once: true }); }); }
function showTargetDiagnostic(container, message, detail = "", options = {}) {
  if (options.dismissKey && container.__dismissedTargetDiagnostics?.has(options.dismissKey)) return;
  let diagnostic = container.querySelector(":scope > .vr-target-diagnostic");
  if (!diagnostic) { diagnostic = element("div", "vr-target-diagnostic"); diagnostic.setAttribute("role", options.variant === "warning" ? "status" : "alert"); container.append(diagnostic); }
  diagnostic.classList.toggle("is-warning", options.variant === "warning");
  const title = element("strong"); title.textContent = message;
  diagnostic.replaceChildren(title);
  if (detail) { const copy = element("span"); copy.textContent = detail; diagnostic.append(copy); }
  if (options.dismissKey) {
    const close = element("button", "vr-target-diagnostic-close"); close.type = "button"; close.textContent = "×"; close.setAttribute("aria-label", "対象ページのエラー通知を閉じる");
    close.addEventListener("click", () => { container.__dismissedTargetDiagnostics ??= new Set(); container.__dismissedTargetDiagnostics.add(options.dismissKey); diagnostic.remove(); });
    diagnostic.append(close);
  }
}
function clearTargetDiagnostic(container) { container.querySelector(":scope > .vr-target-diagnostic")?.remove(); }
function installTargetDiagnostics(container, frame) {
  container.__targetDiagnosticCleanup?.();
  const win = frame.contentWindow;
  if (!win) return;
  let status = 0;
  try { status = Number(win.performance.getEntriesByType("navigation").at(-1)?.responseStatus || 0); } catch {}
  if (status >= 400) showTargetDiagnostic(container, `対象ページが HTTP ${status} を返しました`, "通常のブラウザ表示でもエラーになる状態です。対象アプリのエラーを確認してください。");
  else clearTargetDiagnostic(container);
  const reportRuntimeError = () => {
    if (status >= 400) return;
    showTargetDiagnostic(container, "対象ページでJavaScriptエラーを検出しました", "ページの表示は継続しています。確認済みの場合はこの通知を閉じられます。", { dismissKey: "javascript", variant: "warning" });
  };
  win.addEventListener("error", reportRuntimeError);
  win.addEventListener("unhandledrejection", reportRuntimeError);
  container.__targetDiagnosticCleanup = () => { win.removeEventListener("error", reportRuntimeError); win.removeEventListener("unhandledrejection", reportRuntimeError); delete container.__targetDiagnosticCleanup; };
}
async function focusTarget(pagePath, anchor, restoreContext) {
  const stage = document.querySelector(".vr-target-stage"); const frame = stage?.querySelector("iframe"); let focused = false;
  try {
    if (!stage) throw new Error("レビュー対象がありません");
    if (frame && pagePath && stage.__target) { const next = targetUrlForPage(stage.__target, pagePath); const current = new URL(frame.src, location.href).pathname; if (new URL(next, location.href).pathname !== current) { const waiting = waitForFrame(frame); frame.src = next; await waiting; installHtmlSelection(stage, frame, stage.__mode); } }
    if (frame) {
      const doc = frame.contentDocument; let selected = null;
      if (anchor?.selector) selected = doc?.querySelector(anchor.selector);
      if (!selected && anchor?.xpath && doc) selected = doc.evaluate(anchor.xpath, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (selected) { if (restoreContext) { const parents = []; for (let parent = selected.parentElement; parent; parent = parent.parentElement) if (parent.matches("details,dialog,[hidden],[aria-hidden='true']")) parents.unshift(parent); for (const parent of parents) { if (parent.localName === "details") parent.open = true; if (parent.localName === "dialog" && !parent.open) parent.showModal(); if (parent.hidden) parent.hidden = false; if (parent.getAttribute("aria-hidden") === "true") parent.setAttribute("aria-hidden", "false"); } } selected.scrollIntoView({ block: "center", inline: "center" }); focused = true; }
      else if ((anchor?.bounds || anchor?.rect) && doc?.defaultView) { const size = documentSize(doc); const fallback = anchor.bounds || anchor.rect; doc.defaultView.scrollTo({ left: Math.max(0, fallback.x * size.width - doc.defaultView.innerWidth / 2), top: Math.max(0, fallback.y * size.height - doc.defaultView.innerHeight / 2), behavior: "smooth" }); focused = true; }
    } else if (anchor?.bounds) { const image = stage.querySelector("img"); image?.scrollIntoView({ block: "center", inline: "center" }); focused = Boolean(image); }
    if (!focused) throw new Error("保存された対象を現在のページで特定できません");
    stage.focus(); redrawMarks(); stage.dispatchEvent(new CustomEvent("target.focus.completed", { detail: { anchor } }));
  } catch (error) { stage?.dispatchEvent(new CustomEvent("target.focus.failed", { detail: { anchor, message: error.message } })); announceFocusFailure(`対象を表示できませんでした：${error.message}`); }
}
async function execute(instructions, scope, strictRefresh = false) {
  for (const instruction of instructions) {
    if (instruction.type === "local.set") { setPointer(scope.state, instruction.path, binding(instruction.value, scope)); scope.persist(); await refreshLocalDependencies(scope, instruction.path); if (!scope.preserveDisclosureDom) rerender(); }
    else if (instruction.type === "local.toggle") { setPointer(scope.state, instruction.path, !pointer(scope.state, instruction.path)); scope.persist(); await refreshLocalDependencies(scope, instruction.path); if (!scope.preserveDisclosureDom) rerender(); }
    else if (instruction.type === "dialog.open") { const dialog = dialogFor(scope, instruction.dialog); showDialog(dialog, scope, findNodeDefinition(scope.contribution.document.root, instruction.dialog)); }
    else if (instruction.type === "dialog.close") closeDialog(instruction.dialog ? dialogFor(scope, instruction.dialog) : document.querySelector("dialog[open]"));
    else if (instruction.type === "resource.refresh") await refreshResourceNamed(instruction.resource, scope, strictRefresh);
    else if (instruction.type === "resource.optimistic-append") {
      const key = `${scope.plugin}:${instruction.resource}`;
      const stored = resourceStores.get(key);
      if (stored?.data) {
        const data = structuredClone(stored.data);
        const collection = pointer(data, instruction.collection_path);
        const match = binding(instruction.match, scope);
        const owner = Array.isArray(collection) ? collection.find((item) => Object.is(pointer(item, instruction.match_path), match)) : null;
        const target = owner ? pointer(owner, instruction.target_path) : null;
        if (Array.isArray(target)) {
          target.push(Object.fromEntries(Object.entries(instruction.value).map(([name, value]) => [name, binding(value, scope)])));
          resourceStores.set(key, { ...stored, data });
          rerender();
        }
      }
    }
    else if (instruction.type === "resource.optimistic-patch") {
      const resourcePlugin = instruction.plugin || scope.plugin;
      const key = `${resourcePlugin}:${instruction.resource}`;
      const stored = resourceStores.get(key);
      if (stored?.data) {
        const data = structuredClone(stored.data);
        const collection = pointer(data, instruction.collection_path);
        const match = binding(instruction.match, scope);
        const index = Array.isArray(collection) ? collection.findIndex((item) => Object.is(pointer(item, instruction.match_path), match)) : -1;
        const owner = index >= 0 ? collection[index] : null;
        if (owner && typeof owner === "object") {
          const remove = instruction.remove_when !== undefined && predicate(instruction.remove_when, scope);
          if (remove) collection.splice(index, 1);
          else Object.assign(owner, Object.fromEntries(Object.entries(instruction.value).map(([name, value]) => [name, binding(value, scope)])));
          if (remove) for (const decrementPath of instruction.decrement_paths || []) {
            const current = pointer(data, decrementPath);
            if (typeof current === "number") setPointer(data, decrementPath, Math.max(0, current - 1));
          }
          resourceStores.set(key, { ...stored, data });
          rerender();
        }
      }
    }
    else if (instruction.type === "resource.optimistic-remove") {
      const resourcePlugin = instruction.plugin || scope.plugin;
      const key = `${resourcePlugin}:${instruction.resource}`;
      const stored = resourceStores.get(key);
      if (stored?.data) {
        const data = structuredClone(stored.data);
        const collection = pointer(data, instruction.collection_path);
        const match = binding(instruction.match, scope);
        const index = Array.isArray(collection) ? collection.findIndex((item) => Object.is(pointer(item, instruction.match_path), match)) : -1;
        if (index >= 0) {
          collection.splice(index, 1);
          for (const decrementPath of instruction.decrement_paths || []) {
            const current = pointer(data, decrementPath);
            if (typeof current === "number") setPointer(data, decrementPath, Math.max(0, current - 1));
          }
          resourceStores.set(key, { ...stored, data });
          rerender();
        }
      }
    }
    else if (instruction.type === "selection.activate") activateSelection(instruction, scope);
    else if (instruction.type === "target.reload") document.querySelector(".vr-target-stage iframe")?.contentWindow?.location.reload();
    else if (instruction.type === "target.focus") { reviewSelection.annotation_id = binding(instruction.annotation_id, scope) ?? null; const layer = document.querySelector(".vr-annotation-mark-layer"); if (layer) layer.__selectedId = reviewSelection.annotation_id; await focusTarget(binding(instruction.target, scope), binding(instruction.anchor, scope), instruction.restore_context); }
    else if (instruction.type === "navigate.internal") location.assign(String(binding(instruction.path, scope)));
    else if (instruction.type === "navigate.external") { const url = String(binding(instruction.url, scope)); if ((!instruction.confirmation || confirm(String(instruction.confirmation))) && /^https?:\/\//.test(url)) open(url, "_blank", "noopener"); }
    else if (instruction.type === "toast.show") toast(String(binding(instruction.message, scope)), instruction.variant);
    else if (instruction.type === "command.execute" && (instruction.when === undefined || predicate(instruction.when, scope))) await command(instruction, scope);
    else if (instruction.type === "slot.emit") {
      const host = scope.slotHost;
      if (!host || !(instruction.event in (host.point.events || {}))) { console.warn("slot.emit target unavailable", instruction.event); continue; }
      const payload = Object.fromEntries(Object.entries(instruction.payload || {}).map(([key, value]) => [key, binding(value, scope)]));
      const eventSchema = host.point.events[instruction.event];
      if (eventSchema && !matchesSchema(payload, eventSchema)) { console.warn("slot.emit payload is invalid", instruction.event); continue; }
      await execute(host.definition.on?.[instruction.event] || [], { ...host.scope, event: payload }, strictRefresh);
    }
  }
}
function command(instruction, scope) {
  const commandPlugin = instruction.plugin || scope.plugin;
  const key = `${commandPlugin}:${scope.contribution.id}:${scope.instanceKey || "root"}:${instruction.command}`;
  if (instruction.pending?.deduplicate && pending.has(key)) return pending.get(key);
  const operation = runCommand(instruction, scope, commandPlugin, key);
  if (instruction.pending?.deduplicate) pending.set(key, operation);
  return operation;
}
async function runCommand(instruction, scope, commandPlugin, key) {
  const input = Object.fromEntries(Object.entries(instruction.input).map(([name, value]) => [name, binding(value, scope)]));
  const disableId = instruction.pending?.disable ? instanceId(scope, instruction.pending.disable) : null;
  const disabledControl = disableId ? document.getElementById(disableId) : null;
  await execute(instruction.on_start || [], scope);
  if (disabledControl?.isConnected) { disabledControl.disabled = true; disabledControl.setAttribute("aria-busy", "true"); }
  const requestCommand = async () => {
    const endpoint = `/api/plugin-host/v1/plugins/${encodeURIComponent(commandPlugin)}/commands/${encodeURIComponent(instruction.command)}`;
    const envelope = { protocol: "plugin-bridge/1", request_id: crypto.randomUUID(), idempotency_key: crypto.randomUUID(), expected_revision: binding(instruction.expected_revision, scope) ?? null, input };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope) });
        const result = await response.json().catch(() => null);
        if (!result) throw new Error(`${response.status} ${response.statusText}`);
        return result;
      } catch (error) { if (attempt === 1) throw error; }
    }
  };
  try {
    let result = await requestCommand();
    const revisionResource = instruction.expected_revision?.resource;
    if (!result.ok && result.error?.code === "CONFLICT" && typeof revisionResource === "string") {
      await refreshResourceNamed(revisionResource, scope);
      result = await requestCommand();
    }
    if (!result.ok) throw result.error;
    const invalidated = [...new Set((result.effects || []).filter((effect) => effect.type === "resource.invalidate").flatMap((effect) => effect.resources || []))];
    await Promise.all(invalidated.map((resource) => refreshResourceNamed(resource, scope)));
    await execute(instruction.on_success || [], { ...scope, result: result.data }, true);
    for (const declaration of declarationsFor(scope)) if (declaration.reset_on_success) scope.state[declaration.key] = structuredClone(declaration.default);
    for (const draftKey of [...formDrafts.keys()]) if (draftKey.startsWith(`${scope.plugin}:${scope.contribution.id}:${scope.instanceKey || "root"}:`)) formDrafts.delete(draftKey);
  }
  catch (error) { await execute(instruction.on_error || [], { ...scope, error: error instanceof Error ? { message: error.message } : error }); }
  finally { if (instruction.pending?.deduplicate) pending.delete(key); if (disabledControl?.isConnected) { disabledControl.disabled = false; disabledControl.removeAttribute("aria-busy"); } await execute(instruction.on_settled || [], scope); rerender(); }
}
function dismissToast(token) {
  if (activeToast?.token !== token) return;
  activeToast = null;
  for (const region of document.querySelectorAll(".toast-region")) region.replaceChildren();
  document.querySelector("#vr-toast-layer")?.remove();
}
function paintToast() {
  if (!activeToast) return;
  const dialogBody = document.querySelector("dialog[open] .vr-dialog-body");
  let region = dialogBody?.querySelector(":scope > .toast-region") || document.querySelector("#vr-toast-layer");
  if (dialogBody && !dialogBody.contains(region)) {
    document.querySelector("#vr-toast-layer")?.remove();
    region = element("div", "toast-region"); region.setAttribute("role", "status"); region.setAttribute("aria-live", "polite"); dialogBody.prepend(region);
  } else if (!dialogBody && !region) {
    region = element("div", "toast-region"); region.id = "vr-toast-layer"; region.setAttribute("role", "status"); region.setAttribute("aria-live", "polite"); document.body.append(region);
  }
  if (!region) return;
  const { duration, message, token, variant } = activeToast;
  const item = element("div", `toast toast-${variant}`);
  const copy = element("p", "toast-message"); copy.textContent = message;
  const close = element("button", "toast-close"); close.type = "button"; close.setAttribute("aria-label", "通知を閉じる"); close.textContent = "×";
  close.addEventListener("click", () => dismissToast(token));
  const progress = element("span", "toast-progress"); progress.setAttribute("aria-hidden", "true"); progress.style.setProperty("--toast-duration", `${duration}ms`);
  item.append(copy, close, progress); region.replaceChildren(item);
}
function toast(message, variant = "info") {
  const token = crypto.randomUUID();
  const duration = variant === "info" ? 7000 : 12000;
  activeToast = { token, message, variant, duration };
  paintToast();
  setTimeout(() => dismissToast(token), duration);
}
function safeMarkdown(markdown) {
  const container = element("div", "vr-safe-markdown");
  for (const line of markdown.split(/\r?\n/)) { const match = /^(#{1,6})\s+(.*)$/.exec(line); const node = match ? element(`h${match[1].length}`) : element(line ? "p" : "br"); if (line) node.textContent = match?.[2] ?? line; container.append(node); }
  return container;
}
function documentSize(doc) { const root = doc.documentElement; const body = doc.body; return { width: Math.max(1, root?.scrollWidth || 0, body?.scrollWidth || 0), height: Math.max(1, root?.scrollHeight || 0, body?.scrollHeight || 0) }; }
function pagePathForFrame(stage, frame) { try { const location = frame.contentWindow.location; const pathname = location.pathname; if (pathname.startsWith("/target/")) return decodeURIComponent(pathname.slice(8)); if (pathname.startsWith("/live")) { const proxiedPath = `${pathname.slice(5) || "/"}${location.search}`; return stage.__target?.live_url ? new URL(proxiedPath, stage.__target.live_url).toString() : proxiedPath; } return `${pathname}${location.search}`; } catch { return stage.__target?.entry_path || "/"; } }
function domSelector(selected, doc) { if (selected.id) { const value = `#${CSS.escape(selected.id)}`; if (doc.querySelectorAll(value).length === 1) return value; } const parts = []; for (let item = selected; item && item !== doc.documentElement && parts.length < 16; item = item.parentElement) { const siblings = item.parentElement ? [...item.parentElement.children].filter((child) => child.localName === item.localName) : []; parts.unshift(`${item.localName}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(item) + 1})` : ""}`); } return parts.join(" > "); }
function restoreActivatedSelection(selection) {
  const stage = document.querySelector(".vr-target-stage");
  selection.trigger?.setAttribute?.("aria-pressed", "false");
  if (!stage || activeSelection === selection) return;
  stage.__mode = selection.previousMode;
  stage.dataset.mode = selection.previousMode;
  const frame = stage.querySelector("iframe");
  if (frame) installHtmlSelection(stage, frame, selection.previousMode);
}
function activateSelection(instruction, scope) {
  const stage = document.querySelector(".vr-target-stage");
  if (!stage) return announceFocusFailure("選択できる対象がありません");
  if (activeSelection) {
    const previous = activeSelection;
    activeSelection = null;
    restoreActivatedSelection(previous);
  }
  const selection = { mode: instruction.mode, onCommit: instruction.on_commit, scope, trigger: scope.trigger, previousMode: stage.__mode || "browse" };
  activeSelection = selection;
  selection.trigger?.setAttribute?.("aria-pressed", "true");
  stage.__mode = instruction.mode;
  stage.dataset.mode = instruction.mode;
  const frame = stage.querySelector("iframe");
  if (frame) installHtmlSelection(stage, frame, instruction.mode);
  stage.focus();
}
function commitStageSelection(container, anchor) {
  if (!activeSelection) {
    container.dispatchEvent(new CustomEvent("selection-commit", { detail: { selection: anchor } }));
    return;
  }
  const selection = activeSelection;
  activeSelection = null;
  reviewSelection.anchor = anchor;
  reviewSelection.page_path = anchor.page_path ?? null;
  reviewSelection.annotation_id = null;
  selection.scope.slotContext.review = { selection: reviewSelection };
  restoreActivatedSelection(selection);
  void execute(selection.onCommit, { ...selection.scope, event: { selection: anchor } });
}
function cancelStageSelection(container) {
  if (activeSelection) {
    const selection = activeSelection;
    activeSelection = null;
    restoreActivatedSelection(selection);
  }
  container.dispatchEvent(new CustomEvent("selection-cancel", { detail: {} }));
}
function installHtmlSelection(container, frame, mode) {
  const doc = frame.contentDocument; const win = frame.contentWindow; if (!doc || !win) return;
  if (doc.__vrSelectionInstalled === mode && typeof doc.__vrSelectionCleanup === "function") return;
  doc.__vrSelectionCleanup?.();
  doc.__vrSelectionInstalled = mode;
  const commit = (anchor) => commitStageSelection(container, anchor);
  let drag = null;
  const click = (event) => { if (mode !== "node") return; event.preventDefault(); event.stopImmediatePropagation(); const selected = event.target; if (!(selected instanceof win.Element)) return; const rect = selected.getBoundingClientRect(); const size = documentSize(doc); commit({ kind: "dom", selector: domSelector(selected, doc), page_path: pagePathForFrame(container, frame), text_excerpt: String(selected.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200), rect: { x: (rect.left + win.scrollX) / size.width, y: (rect.top + win.scrollY) / size.height, width: rect.width / size.width, height: rect.height / size.height } }); };
  const pointerdown = (event) => { if (mode !== "region") return; event.preventDefault(); event.stopImmediatePropagation(); drag = { x: event.pageX, y: event.pageY, endX: event.pageX, endY: event.pageY }; container.__preview = drag; redrawMarks(); };
  const pointermove = (event) => { if (!drag || mode !== "region") return; event.preventDefault(); drag.endX = event.pageX; drag.endY = event.pageY; container.__preview = drag; redrawMarks(); };
  const pointerup = (event) => { if (!drag || mode !== "region") return; event.preventDefault(); event.stopImmediatePropagation(); drag.endX = event.pageX; drag.endY = event.pageY; const width = Math.abs(drag.endX - drag.x); const height = Math.abs(drag.endY - drag.y); const size = documentSize(doc); container.__preview = null; redrawMarks(); if (width < 5 || height < 5) return announceFocusFailure("範囲が小さすぎます。もう一度ドラッグしてください。"); commit({ kind: "region", space: "document", bounds: { x: Math.min(drag.x, drag.endX) / size.width, y: Math.min(drag.y, drag.endY) / size.height, width: width / size.width, height: height / size.height }, document: size, viewport: { width: win.innerWidth, height: win.innerHeight, scroll_x: win.scrollX, scroll_y: win.scrollY }, page_path: pagePathForFrame(container, frame) }); drag = null; };
  doc.addEventListener("click", click, true);
  doc.addEventListener("pointerdown", pointerdown, true);
  doc.addEventListener("pointermove", pointermove, true);
  doc.addEventListener("pointerup", pointerup, true);
  win.addEventListener("scroll", redrawMarks, { passive: true }); win.addEventListener("resize", redrawMarks, { passive: true });
  const cleanup = () => {
    doc.removeEventListener("click", click, true);
    doc.removeEventListener("pointerdown", pointerdown, true);
    doc.removeEventListener("pointermove", pointermove, true);
    doc.removeEventListener("pointerup", pointerup, true);
    win.removeEventListener("scroll", redrawMarks);
    win.removeEventListener("resize", redrawMarks);
    drag = null;
    container.__preview = null;
    if (doc.__vrSelectionCleanup === cleanup) { delete doc.__vrSelectionCleanup; delete doc.__vrSelectionInstalled; }
  };
  doc.__vrSelectionCleanup = cleanup;
}
function viewportDimension(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.round(number))) : fallback;
}
function applyTargetViewport(container, frame) {
  if (!frame) return;
  if (container.dataset.viewport === "custom") {
    frame.style.width = `${container.__viewportWidth}px`;
    frame.style.height = `${container.__viewportHeight}px`;
  } else {
    frame.style.removeProperty("width");
    frame.style.removeProperty("height");
  }
}
function targetStage(definition, scope) {
  const container = element("div", "vr-target-stage stage"); container.tabIndex = 0;
  container.dataset.viewport = String(binding(definition.props?.viewport_mode, scope) || "desktop");
  container.__viewportWidth = viewportDimension(binding(definition.props?.viewport_width, scope), 320, 3840, 1280);
  container.__viewportHeight = viewportDimension(binding(definition.props?.viewport_height, scope), 240, 2160, 720);
  const target = binding(definition.props?.target, scope); const mode = String(binding(definition.props?.selection_mode, scope) || "browse"); container.__target = target; container.__mode = mode;
  if (!target) { container.textContent = "対象を読み込んでいます…"; return container; }
  const commit = (anchor) => commitStageSelection(container, anchor);
  if (target.kind === "image") {
    const image = element("img"); image.alt = "レビュー対象画像"; image.src = target.url; container.append(image); let start = null;
    image.addEventListener("load", redrawMarks); image.addEventListener("pointerdown", (event) => { if (container.__mode !== "region") return; event.preventDefault(); const rect = image.getBoundingClientRect(); start = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }; image.setPointerCapture?.(event.pointerId); });
    image.addEventListener("pointerup", (event) => { if (!start) return; const rect = image.getBoundingClientRect(); const end = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }; const bounds = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }; start = null; if (bounds.width * rect.width < 5 || bounds.height * rect.height < 5) return announceFocusFailure("範囲が小さすぎます。もう一度ドラッグしてください。"); commit({ kind: "region", space: "image", bounds, natural: { width: image.naturalWidth, height: image.naturalHeight }, page_path: target.entry_path }); });
  } else {
    const frame = element("iframe"); frame.title = "レビュー対象ページ";
    const requestedInitialPage = initialPagePath;
    frame.src = requestedInitialPage ? targetUrlForPage(target, requestedInitialPage) : target.url;
    if (requestedInitialPage) { initialPagePath = null; history.replaceState(null, "", location.pathname); }
    if (!target.allow_scripts) frame.setAttribute("sandbox", "allow-same-origin allow-forms");
    container.append(frame); frame.addEventListener("load", () => { try { installTargetDiagnostics(container, frame); installHtmlSelection(container, frame, container.__mode ?? mode); redrawMarks(); container.dispatchEvent(new CustomEvent("load")); } catch (error) { container.dispatchEvent(new CustomEvent("error", { detail: { code: "TARGET_UNAVAILABLE", message: error.message } })); announceFocusFailure(`対象ページを操作できません：${error.message}`); } });
  }
  applyTargetViewport(container, container.querySelector("iframe")); container.dataset.mode = mode;
  container.addEventListener("keydown", (event) => { if (event.key === "Escape") { container.__preview = null; redrawMarks(); cancelStageSelection(container); } });
  return container;
}
function redrawMarks() {
  const stage = document.querySelector(".vr-target-stage"); const layer = document.querySelector(".vr-annotation-mark-layer"); if (!stage || !layer) return; layer.replaceChildren(); const frame = stage.querySelector("iframe"); const image = stage.querySelector("img"); const stageRect = stage.getBoundingClientRect();
  const add = (bounds, index, className = "", status = "") => { const mark = element("div", `vr-annotation-mark ${className}`); if (status) mark.dataset.status = status; mark.style.left = `${bounds.left}px`; mark.style.top = `${bounds.top}px`; mark.style.width = `${Math.max(2, bounds.width)}px`; mark.style.height = `${Math.max(2, bounds.height)}px`; if (index) { const pin = element("span", "vr-annotation-pin"); pin.textContent = String(index); mark.append(pin); } layer.append(mark); };
  const visibleAnnotations = Array.isArray(layer.__marks) ? layer.__marks : [];
  for (const [index, annotation] of visibleAnnotations.entries()) { const currentPath = frame ? pagePathForFrame(stage, frame) : stage.__target?.entry_path; if (annotation.page_path && String(annotation.page_path).replace(/^\//, "") !== String(currentPath).replace(/^\//, "")) continue; try { let box = null; if (frame && annotation.kind === "dom") { const selected = annotation.anchor?.selector ? frame.contentDocument?.querySelector(annotation.anchor.selector) : null; if (selected) { const rect = selected.getBoundingClientRect(); const frameRect = frame.getBoundingClientRect(); box = { left: frameRect.left - stageRect.left + rect.left, top: frameRect.top - stageRect.top + rect.top, width: rect.width, height: rect.height }; } else if (annotation.anchor?.rect) { const doc = frame.contentDocument; const win = frame.contentWindow; const size = documentSize(doc); const frameRect = frame.getBoundingClientRect(); const b = annotation.anchor.rect; box = { left: frameRect.left - stageRect.left + b.x * size.width - win.scrollX, top: frameRect.top - stageRect.top + b.y * size.height - win.scrollY, width: b.width * size.width, height: b.height * size.height }; } } else if (frame && annotation.anchor?.bounds) { const doc = frame.contentDocument; const win = frame.contentWindow; const size = documentSize(doc); const frameRect = frame.getBoundingClientRect(); const b = annotation.anchor.bounds; box = { left: frameRect.left - stageRect.left + b.x * size.width - win.scrollX, top: frameRect.top - stageRect.top + b.y * size.height - win.scrollY, width: b.width * size.width, height: b.height * size.height }; } else if (image && annotation.anchor?.bounds) { const rect = image.getBoundingClientRect(); const b = annotation.anchor.bounds; box = { left: rect.left - stageRect.left + b.x * rect.width, top: rect.top - stageRect.top + b.y * rect.height, width: b.width * rect.width, height: b.height * rect.height }; } if (box) add(box, index + 1, annotation.id === layer.__selectedId ? "is-selected" : "", annotation.status); } catch {}
  }
  if (stage.__preview && frame) { const drag = stage.__preview; const win = frame.contentWindow; const frameRect = frame.getBoundingClientRect(); add({ left: frameRect.left - stageRect.left + Math.min(drag.x, drag.endX) - win.scrollX, top: frameRect.top - stageRect.top + Math.min(drag.y, drag.endY) - win.scrollY, width: Math.abs(drag.endX - drag.x), height: Math.abs(drag.endY - drag.y) }, null, "is-preview"); }
}
function isActiveStageOrNonStage(contribution) {
  if (root.dataset.page === "review" && contribution.slot === "settings.detail") return false;
  return contribution.slot !== "review.stage" || `${contribution.plugin_id}/${contribution.id}` === surface?.layout?.active_stage;
}
async function refreshResourceNamed(id, fallbackScope, strict = false) {
  const matchingOwners = (surface?.contributions || []).filter((contribution) => isActiveStageOrNonStage(contribution) && (contribution.document.resources || []).some((resource) => resource.id === id));
  const owners = [...new Map(matchingOwners.map((contribution) => [`${contribution.plugin_id}:${id}`, contribution])).values()];
  const results = !owners.length
    ? [await loadResource(fallbackScope.contribution, id, fallbackScope, false)]
    : await Promise.all(owners.map((contribution) => { const runtime = runtimeFor(contribution, ""); const scope = { plugin: contribution.plugin_id, contribution, state: runtime.state, persist: runtime.persist, instanceKey: "", slotContext: {} }; return loadResource(contribution, id, scope, false); }));
  if (strict && results.some((result) => result === false)) throw new Error(`${id}を更新できませんでした`);
}
async function loadResource(contribution, id, scope, shouldRender = true) {
  const declaration = (contribution.document.resources || []).find((item) => item.id === id); if (!declaration) return;
  const key = `${contribution.plugin_id}:${id}`;
  const generation = (resourceRequestGenerations.get(key) || 0) + 1;
  resourceRequestGenerations.set(key, generation);
  const previousStore = resourceStores.get(key);
  resourceStores.set(key, { ...previousStore, state: previousStore?.data === undefined ? "loading" : "refreshing" });
  const input = Object.fromEntries(Object.entries(declaration.input).map(([name, value]) => [name, binding(value, scope)]));
  try {
    const response = await fetch(`/api/plugin-host/v1/plugins/${encodeURIComponent(contribution.plugin_id)}/queries/${encodeURIComponent(declaration.query)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ protocol: "plugin-bridge/1", request_id: crypto.randomUUID(), input }) });
    const result = await response.json(); if (!result.ok) throw result.error;
    if (resourceRequestGenerations.get(key) !== generation) return false;
    const previous = resourceStores.get(key)?.data;
    const data = Number(input.offset) > 0 && Array.isArray(previous?.events) && Array.isArray(result.data?.events)
      ? { ...result.data, events: [...previous.events, ...result.data.events] }
      : result.data;
    resourceStores.set(key, { state: "ready", data, revision: result.revision });
  } catch (error) {
    if (resourceRequestGenerations.get(key) !== generation) return false;
    const current = resourceStores.get(key);
    resourceStores.set(key, current?.data === undefined ? { state: "error", error } : { ...current, state: "ready", refresh_error: error });
    if (shouldRender) rerender();
    return false;
  }
  if (shouldRender) rerender();
  return true;
}
function renderContribution(contribution, slotContext = {}, parentInstanceKey = "", slotHost = null) {
  const runtime = runtimeFor(contribution, parentInstanceKey);
  const scope = { plugin: contribution.plugin_id, contribution, state: runtime.state, persist: runtime.persist, instanceKey: parentInstanceKey, slotContext: { ...(slotContext && typeof slotContext === "object" ? slotContext : {}), review: { selection: reviewSelection } }, slotHost };
  const rendered = renderNode(contribution.document.root, scope);
  if (rendered instanceof HTMLElement) {
    rendered.dataset.pluginId = contribution.plugin_id;
    rendered.dataset.contributionId = contribution.id;
    rendered.dataset.slot = contribution.slot;
    if (contribution.browser_module_url) queueMicrotask(() => { if (rendered.isConnected) void mountPluginRuntime(contribution, rendered); });
  }
  return rendered;
}
function targetIdentity(stage) {
  const target = stage?.__target;
  return target ? JSON.stringify([target.kind, target.url, target.entry_path, Boolean(target.allow_scripts)]) : "";
}
// Patches only inside the active review.stage contribution root: keeps the live iframe/image
// element (and its selection listeners) when the underlying target is unchanged, and swaps
// everything else (mark layer, overlays slot, dialogs) for the freshly rendered versions.
function patchStageHostRoot(currentRoot, nextTree) {
  const currentStage = currentRoot?.querySelector?.(".vr-target-stage");
  const nextStage = nextTree?.querySelector?.(".vr-target-stage");
  if (!currentRoot || !currentStage || !nextStage || targetIdentity(currentStage) !== targetIdentity(nextStage)) return false;
  currentStage.dataset.viewport = nextStage.dataset.viewport;
  currentStage.dataset.mode = nextStage.dataset.mode;
  currentStage.__viewportWidth = nextStage.__viewportWidth;
  currentStage.__viewportHeight = nextStage.__viewportHeight;
  currentStage.__mode = nextStage.__mode;
  currentStage.__target = nextStage.__target;
  currentStage.__preview = null;
  const frame = currentStage.querySelector("iframe");
  if (frame) { applyTargetViewport(currentStage, frame); installHtmlSelection(currentStage, frame, currentStage.__mode); }
  for (const child of [...currentRoot.children]) if (child !== currentStage) child.remove();
  for (const child of [...nextTree.children]) if (child !== nextStage) currentRoot.append(child);
  return true;
}
let reviewShell = null;
function ensureShell() {
  if (reviewShell?.root?.isConnected) return reviewShell;
  const appShell = element("div", "vr-app-shell");
  appShell.dataset.baseShell = "review";
  const header = element("header", "vr-header vr-base-header");
  const brand = element("div", "vr-brand-copy");
  const eyebrow = element("span", "vr-eyebrow"); eyebrow.textContent = "VREV";
  const title = element("h1", "vr-page-title");
  brand.append(eyebrow, title);
  const actions = element("div", "vr-header-actions");
  actions.setAttribute("role", "group");
  actions.setAttribute("aria-label", "プラグイン操作");
  const settingsLink = element("a", "vr-link vr-settings-link");
  settingsLink.href = "/settings";
  settingsLink.textContent = "設定";
  header.append(brand, actions, settingsLink);
  const splitPanel = element("div", "vr-split-panel");
  const stageHost = element("section", "vr-section vr-stage-host");
  stageHost.setAttribute("aria-label", "レビュー対象");
  const sidebarHost = element("div", "vr-slot vr-sidebar-host");
  sidebarHost.dataset.slot = "review.sidebar";
  splitPanel.append(stageHost, sidebarHost);
  const toastRegion = element("div", "toast-region");
  appShell.append(header, splitPanel, toastRegion);
  root.replaceChildren(appShell);
  reviewShell = { root: appShell, title, actions, stageHost, sidebarHost };
  return reviewShell;
}
function renderHeaderActions(container) {
  const items = surface.contributions.filter((contribution) => contribution.slot === "review.header").map((contribution) => {
    const item = element("div", "vr-header-item");
    item.dataset.key = `${contribution.plugin_id}/${contribution.id}`;
    item.append(renderContribution(contribution));
    return item;
  });
  container.replaceChildren(...items);
}
function renderSidebarHost(container) {
  const scrollState = { top: container.scrollTop, left: container.scrollLeft };
  const items = surface.contributions.filter((contribution) => contribution.slot === "review.sidebar").map((contribution) => renderContribution(contribution));
  container.replaceChildren(...items);
  container.hidden = items.length === 0;
  container.scrollTop = scrollState.top;
  container.scrollLeft = scrollState.left;
}
/** Loads the resources of a stage contribution that was not active at start-up (they are skipped there). */
async function loadStageResources(key) {
  const stage = surface.contributions.find((contribution) => contribution.slot === "review.stage" && `${contribution.plugin_id}/${contribution.id}` === key);
  if (!stage) return;
  const runtime = runtimeFor(stage, "");
  const scope = { plugin: stage.plugin_id, contribution: stage, state: runtime.state, persist: runtime.persist, instanceKey: "", slotContext: {} };
  await Promise.all((stage.document.resources || []).map((resource) => loadResource(stage, resource.id, scope, false)));
}
async function switchActiveStage(key) {
  try {
    const response = await fetch("/api/settings/layout", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: surface.layout.revision, stage: { active: key } }) });
    if (!response.ok) throw new Error("描画を切り替えられませんでした。");
    surface = await (await fetch("/api/plugin-host/v1/surfaces/review")).json();
    applyTheme(surface.theme);
    await loadStageResources(key);
    rerender();
  } catch (error) {
    toast(error instanceof Error ? error.message : "描画を切り替えられませんでした。", "error");
    rerender();
  }
}
function renderStageSwitcher(container, activeKey) {
  const stageViews = surface.layout.stage_views || [];
  let switcher = container.querySelector(":scope > .vr-stage-switcher");
  if (stageViews.length < 2) { switcher?.remove(); return; }
  if (!switcher) {
    switcher = element("div", "vr-stage-switcher");
    const label = element("label", "vr-field-label"); label.textContent = "描画の切り替え";
    const select = element("select", "vr-select");
    select.setAttribute("aria-label", "描画の切り替え");
    select.addEventListener("change", () => void switchActiveStage(select.value));
    switcher.append(label, select);
  }
  switcher.dataset.position = surface.layout.stage_switcher_position;
  const select = switcher.querySelector("select");
  select.replaceChildren(...stageViews.map((view) => { const option = element("option"); option.value = view.key; option.textContent = view.title; return option; }));
  select.value = activeKey || "";
  container.append(switcher);
}
function renderStageHost(container) {
  const activeKey = surface.layout.active_stage;
  const activeStage = surface.contributions.find((contribution) => contribution.slot === "review.stage" && `${contribution.plugin_id}/${contribution.id}` === activeKey);
  const currentContent = container.querySelector(":scope > *:not(.vr-stage-switcher)");
  if (!activeStage) {
    currentContent?.remove();
    const empty = element("p", "vr-diagnostic"); empty.textContent = "レビュー対象を表示できません"; container.prepend(empty);
  } else {
    const nextTree = renderContribution(activeStage);
    const canPatch = currentContent?.dataset?.slot === "review.stage" && patchStageHostRoot(currentContent, nextTree);
    if (canPatch) {
      if (activeStage.browser_module_url) queueMicrotask(() => { if (currentContent.isConnected) void mountPluginRuntime(activeStage, currentContent); });
    } else {
      currentContent?.remove();
      container.prepend(nextTree);
    }
  }
  cleanupPluginRuntimes();
  renderStageSwitcher(container, activeKey);
}
function rerender() {
  if (location.pathname === "/settings/plugins") {
    settingsRenderPromise ??= renderSettings().finally(() => { settingsRenderPromise = null; });
    return;
  }
  if (location.pathname === "/settings") {
    settingsRenderPromise ??= renderGeneralSettings().finally(() => { settingsRenderPromise = null; });
    return;
  }
  const openDialog = document.querySelector("dialog[open]");
  if (openDialog) {
    deferredReviewRender = true;
    if (!openDialog.__deferredRenderListener) {
      openDialog.__deferredRenderListener = true;
      openDialog.addEventListener("close", () => { delete openDialog.__deferredRenderListener; if (deferredReviewRender) { deferredReviewRender = false; rerender(); } }, { once: true });
    }
    return;
  }
  deferredReviewRender = false;
  const activeId = document.activeElement?.id; dialogs.clear();
  const shellElements = ensureShell();
  shellElements.title.textContent = surface.page?.title || "Vrev";
  renderHeaderActions(shellElements.actions);
  renderStageHost(shellElements.stageHost);
  renderSidebarHost(shellElements.sidebarHost);
  root.dataset.sidebar = surface.layout.sidebar; root.setAttribute("aria-busy", "false");
  queueMicrotask(paintToast); requestAnimationFrame(paintToast);
  if (activeId) document.getElementById(activeId)?.focus({ preventScroll: true });
  requestAnimationFrame(redrawMarks);
}
function pluginProvenanceLabel(plugin) {
  if (plugin.bundled) return "同梱";
  const resolved = plugin.resolved;
  if (!resolved) return "";
  const digestPrefix = resolved.digest ? `sha256 ${resolved.digest.slice(0, 12)}…` : "";
  if (resolved.kind === "npm") return ["npm", resolved.ref, digestPrefix].filter(Boolean).join(" · ");
  if (resolved.kind === "git") return ["git", resolved.ref ? resolved.ref.slice(0, 12) : null, digestPrefix].filter(Boolean).join(" · ");
  return ["local", digestPrefix].filter(Boolean).join(" · ");
}
async function removeInstalledPlugin(plugin, button, row) {
  if (!confirm(`${plugin.title}を削除しますか？`)) return;
  button.disabled = true; row.setAttribute("aria-busy", "true");
  try {
    const response = await fetch(`/api/settings/plugins/${encodeURIComponent(plugin.id)}`, { method: "DELETE" });
    if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || "プラグインを削除できませんでした。"); }
    toast(`${plugin.title}を削除しました。`, "info");
    location.reload();
  } catch (error) {
    toast(error instanceof Error ? error.message : "プラグインを削除できませんでした。", "error");
    button.disabled = false; row.removeAttribute("aria-busy");
  }
}
function pluginInstallSection() {
  const section = element("section", "vr-settings-card");
  const heading = element("h2", "vr-section-title"); heading.textContent = "プラグインを追加"; section.append(heading);
  const description = element("p", "vr-field-description");
  description.textContent = "npm指定はバージョンを固定し、GitHub指定はタグまたはcommit SHAを#で固定してください。install時にプラグインのコードは実行されず、追加直後は無効状態で始まります。";
  section.append(description);
  const field = element("label", "vr-field vr-field-input");
  const label = element("span", "vr-field-label"); label.textContent = "インストール元"; field.append(label);
  const input = element("input"); input.type = "text"; input.placeholder = "@scope/plugin@1.2.3 / github:owner/repo#v1.2.3 / ./plugins/example";
  field.append(input); section.append(field);
  const install = element("button", "vr-button"); install.type = "button"; install.textContent = "インストール";
  install.addEventListener("click", async () => {
    const source = input.value.trim();
    if (!source) return toast("インストール元を入力してください。", "error");
    install.disabled = true; install.setAttribute("aria-busy", "true"); install.textContent = "インストール中…";
    try {
      const response = await fetch("/api/settings/plugins", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "プラグインをインストールできませんでした。");
      toast(`${body.installed.id}@${body.installed.version}をインストールしました。`, "info");
      for (const warning of body.installed.warnings || []) toast(warning, "info");
      location.reload();
    } catch (error) {
      toast(error instanceof Error ? error.message : "プラグインをインストールできませんでした。", "error");
    } finally {
      install.disabled = false; install.removeAttribute("aria-busy"); install.textContent = "インストール";
    }
  });
  section.append(install);
  return section;
}
async function renderSettings() {
  root.dataset.page = "settings";
  const [managementResponse, surfaceResponse] = await Promise.all([fetch("/api/settings/plugins"), fetch("/api/plugin-host/v1/surfaces/review")]);
  if (!managementResponse.ok || !surfaceResponse.ok) throw new Error("プラグイン設定を読み込めませんでした。");
  const management = await managementResponse.json(); surface = await surfaceResponse.json(); applyTheme(surface.theme);
  const shell = element("div", "vr-app-shell vr-settings-shell");
  const header = element("header", "vr-header vr-settings-header");
  const brand = element("div", "vr-brand-copy"); const eyebrow = element("span", "vr-eyebrow"); eyebrow.textContent = "VREV"; const heading = element("h1"); heading.textContent = "プラグイン設定"; brand.append(eyebrow, heading);
  const generalSettings = element("a", "vr-link"); generalSettings.href = "/settings"; generalSettings.textContent = "設定へ戻る";
  header.append(brand, generalSettings); shell.append(header);
  const page = element("main", "vr-settings-page");
  const intro = element("section", "vr-settings-intro"); const introHeading = element("h2"); introHeading.textContent = "インストール済みプラグイン"; const introCopy = element("p"); introCopy.textContent = "機能の有効状態を切り替え、プラグインごとの説明と設定を確認できます。"; intro.append(introHeading, introCopy); page.append(intro);
  if (surface.diagnostics?.length) { const warning = element("p", "vr-settings-error"); warning.textContent = `${surface.diagnostics.length}件のプラグインUIを読み込めませんでした。詳細は各プラグインを確認してください。`; page.append(warning); }
  page.append(pluginInstallSection());
  const list = element("section", "vr-settings-list"); list.setAttribute("aria-label", "インストール済みプラグイン");
  for (const plugin of management.plugins || []) {
    const row = element("article", "vr-plugin-row"); row.dataset.pluginId = plugin.id;
    const copy = element("div", "vr-plugin-copy"); const title = element("h3"); title.textContent = plugin.title; const summary = element("p"); summary.textContent = plugin.summary; copy.append(title, summary);
    const provenance = element("span", "vr-field-description"); provenance.textContent = pluginProvenanceLabel(plugin); copy.append(provenance);
    const toggleLabel = element("label", "vr-plugin-toggle"); const toggle = element("input"); toggle.type = "checkbox"; toggle.role = "switch"; toggle.checked = plugin.enabled; toggle.setAttribute("aria-label", `${plugin.title}を有効にする`); const toggleText = element("span"); toggleText.textContent = "有効"; toggleLabel.append(toggle, toggleText);
    toggle.addEventListener("change", async () => {
      const previous = !toggle.checked; row.setAttribute("aria-busy", "true"); toggle.disabled = true;
      try {
        const response = await fetch(`/api/settings/plugins/${encodeURIComponent(plugin.id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: management.revision, enabled: toggle.checked, configuration: Object.fromEntries((plugin.configuration || []).filter((field) => field.source === "workspace" && field.value !== null).map((field) => [field.key, field.value])) }) });
        if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || "設定を保存できませんでした。");
        location.reload();
      } catch (error) { toggle.checked = previous; toast(error instanceof Error ? error.message : "設定を保存できませんでした。", "error"); }
      finally { toggle.disabled = false; row.removeAttribute("aria-busy"); }
    });
    const details = element("button", "vr-button"); details.type = "button"; details.textContent = "詳細"; details.setAttribute("aria-haspopup", "dialog");
    details.addEventListener("click", () => { location.hash = plugin.id; void openSettingsDetail(plugin, details); });
    row.append(copy, toggleLabel, details);
    if (!plugin.bundled && !plugin.package_managed) {
      const remove = element("button", "vr-button"); remove.type = "button"; remove.textContent = "削除";
      remove.addEventListener("click", () => void removeInstalledPlugin(plugin, remove, row));
      row.append(remove);
    }
    list.append(row);
  }
  page.append(list); shell.append(page, element("div", "toast-region")); root.replaceChildren(shell); root.setAttribute("aria-busy", "false"); queueMicrotask(paintToast); requestAnimationFrame(paintToast);
  const selected = (management.plugins || []).find(({ id }) => id === decodeURIComponent(location.hash.slice(1))); if (selected) await openSettingsDetail(selected, null);
}
function renderConfigurationField(plugin, field, refreshConfigSection) {
  if (field.source === "environment") {
    const line = element("p", "vr-field-description vr-plugin-env-field");
    line.textContent = `${field.environment}: ${field.present ? "設定済み" : "未設定"}`;
    return line;
  }
  if (field.source === "credential") {
    const section = element("div", "vr-field vr-credential-field");
    const label = element("span", "vr-field-label"); label.textContent = field.title; section.append(label);
    if (field.description) { const description = element("span", "vr-field-description"); description.textContent = field.description; section.append(description); }
    const status = element("p", "vr-field-description vr-credential-status");
    status.textContent = field.present ? `設定済み（更新 ${field.updated_at}, ${field.fingerprint}）` : "未設定";
    section.append(status);
    const input = field.format === "json" ? element("textarea", "vr-textarea") : element("input", "vr-input");
    if (field.format === "json") input.rows = 4; else input.type = "password";
    input.autocomplete = "off";
    input.setAttribute("aria-label", field.title);
    section.append(input);
    const row = element("div", "vr-row");
    const save = element("button", "vr-button"); save.type = "button"; save.textContent = "保存";
    const remove = element("button", "vr-button"); remove.type = "button"; remove.textContent = "削除"; remove.disabled = !field.present;
    save.addEventListener("click", async () => {
      if (!input.value) { toast("値を入力してください。", "error"); return; }
      save.setAttribute("aria-busy", "true"); remove.setAttribute("aria-busy", "true"); save.disabled = true; remove.disabled = true;
      try {
        const response = await fetch(`/api/settings/plugins/${encodeURIComponent(plugin.id)}/credentials/${encodeURIComponent(field.key)}`, {
          method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: input.value }),
        });
        if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || "保存できませんでした。");
        input.value = "";
        toast("設定を保存しました。", "success");
        await refreshConfigSection();
      } catch (error) {
        toast(error instanceof Error ? error.message : "保存できませんでした。", "error");
      } finally {
        save.removeAttribute("aria-busy"); remove.removeAttribute("aria-busy"); save.disabled = false; remove.disabled = !field.present;
      }
    });
    remove.addEventListener("click", async () => {
      save.setAttribute("aria-busy", "true"); remove.setAttribute("aria-busy", "true"); save.disabled = true; remove.disabled = true;
      try {
        const response = await fetch(`/api/settings/plugins/${encodeURIComponent(plugin.id)}/credentials/${encodeURIComponent(field.key)}`, { method: "DELETE" });
        if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || "削除できませんでした。");
        input.value = "";
        toast("削除しました。", "success");
        await refreshConfigSection();
      } catch (error) {
        toast(error instanceof Error ? error.message : "削除できませんでした。", "error");
      } finally {
        save.removeAttribute("aria-busy"); remove.removeAttribute("aria-busy"); save.disabled = false; remove.disabled = !field.present;
      }
    });
    row.append(save, remove);
    section.append(row);
    return section;
  }
  return null;
}
function renderPluginConfigurationForm(plugin, refreshConfigSection) {
  const fields = plugin.configuration || [];
  const wrapper = element("div", "vr-plugin-config");
  const workspaceFields = fields.filter((field) => field.source === "workspace");
  if (workspaceFields.length) {
    const form = element("form", "vr-form vr-plugin-config-form");
    form.addEventListener("submit", (event) => event.preventDefault());
    const inputs = new Map();
    for (const field of workspaceFields) {
      const isCheckbox = field.type === "boolean";
      const fieldEl = element("label", `vr-field${isCheckbox ? " vr-field-checkbox" : field.type === "select" ? " vr-field-select" : ""}`);
      const label = element("span", "vr-field-label"); label.textContent = field.title;
      let control;
      if (isCheckbox) {
        control = element("input", "vr-checkbox"); control.type = "checkbox"; control.checked = Boolean(field.value ?? field.default ?? false);
        fieldEl.append(control, label);
      } else if (field.type === "select") {
        control = element("select", "vr-select");
        for (const option of field.options || []) { const optionEl = element("option"); optionEl.value = option.value; optionEl.textContent = option.label; control.append(optionEl); }
        control.value = field.value ?? field.default ?? "";
        fieldEl.append(label, control);
      } else if (field.type === "integer") {
        control = element("input", "vr-input"); control.type = "number"; control.step = "1"; control.value = field.value ?? field.default ?? "";
        fieldEl.append(label, control);
      } else {
        control = element("input", "vr-input"); control.type = "text"; control.value = field.value ?? field.default ?? "";
        fieldEl.append(label, control);
      }
      if (field.description) { const description = element("span", "vr-field-description"); description.textContent = field.description; fieldEl.append(description); }
      inputs.set(field.key, { field, control });
      form.append(fieldEl);
    }
    const saveButton = element("button", "vr-button"); saveButton.type = "button"; saveButton.dataset.variant = "primary"; saveButton.textContent = "設定を保存";
    saveButton.addEventListener("click", async () => {
      saveButton.setAttribute("aria-busy", "true"); saveButton.disabled = true;
      try {
        const configuration = {};
        for (const [key, { field, control }] of inputs) {
          if (field.type === "boolean") configuration[key] = control.checked;
          else if (field.type === "integer") configuration[key] = Number(control.value);
          else configuration[key] = control.value;
        }
        const management = await (await fetch("/api/settings/plugins")).json();
        const response = await fetch(`/api/settings/plugins/${encodeURIComponent(plugin.id)}`, {
          method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision: management.revision, enabled: plugin.enabled, configuration }),
        });
        if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || "設定を保存できませんでした。");
        toast("設定を保存しました。", "success");
        await refreshConfigSection();
      } catch (error) {
        toast(error instanceof Error ? error.message : "設定を保存できませんでした。", "error");
      } finally {
        saveButton.removeAttribute("aria-busy"); saveButton.disabled = false;
      }
    });
    form.append(saveButton);
    wrapper.append(form);
  }
  for (const field of fields) {
    if (field.source === "workspace") continue;
    const node = renderConfigurationField(plugin, field, refreshConfigSection);
    if (node) wrapper.append(node);
  }
  return wrapper;
}
function storageTransferKeyList(label, keys, total) {
  const wrap = element("div", "vr-storage-transfer-keys");
  const heading = element("span", "vr-field-label"); heading.textContent = label; wrap.append(heading);
  const list = element("ul");
  const shown = keys.slice(0, 20);
  for (const key of shown) { const item = element("li"); item.textContent = key; list.append(item); }
  wrap.append(list);
  if (total > shown.length) { const more = element("span", "vr-field-description"); more.textContent = `ほか ${total - shown.length} 件`; wrap.append(more); }
  return wrap;
}
function renderStorageTransferSection(plugin) {
  const section = element("section", "vr-settings-card vr-storage-transfer-section");
  const heading = element("h2", "vr-section-title"); heading.textContent = "データの上書き"; section.append(heading);
  const description = element("p"); description.textContent = "選んだ方向のデータで、もう一方を完全に置き換えます。宛先にしかないデータは削除されます。"; section.append(description);
  const directionField = element("label", "vr-field vr-field-select");
  const directionLabel = element("span", "vr-field-label"); directionLabel.textContent = "方向"; directionField.append(directionLabel);
  const directionSelect = element("select", "vr-select");
  const localToPlugin = element("option"); localToPlugin.value = "local-to-plugin"; localToPlugin.textContent = `ローカル（.vrev） → ${plugin.title}`;
  const pluginToLocal = element("option"); pluginToLocal.value = "plugin-to-local"; pluginToLocal.textContent = `${plugin.title} → ローカル（.vrev）`;
  directionSelect.append(localToPlugin, pluginToLocal);
  directionField.append(directionSelect);
  section.append(directionField);
  const blocked = !plugin.enabled || (plugin.missing || []).length > 0;
  if (blocked) { const note = element("p", "vr-field-description"); note.textContent = "上書きを実行するには、このプラグインを有効にして必要な設定を保存してください。"; section.append(note); }
  const actions = element("div", "vr-row");
  const dryRunButton = element("button", "vr-button"); dryRunButton.type = "button"; dryRunButton.textContent = "差分を確認";
  const executeButton = element("button", "vr-button"); executeButton.type = "button"; executeButton.dataset.variant = "primary"; executeButton.textContent = "上書きを実行"; executeButton.disabled = blocked;
  actions.append(dryRunButton, executeButton);
  section.append(actions);
  const confirmPanel = element("div", "vr-storage-transfer-confirm"); confirmPanel.hidden = true;
  const confirmText = element("p"); confirmPanel.append(confirmText);
  const confirmActions = element("div", "vr-row");
  const confirmRun = element("button", "vr-button"); confirmRun.type = "button"; confirmRun.dataset.variant = "primary"; confirmRun.textContent = "実行する";
  const confirmCancel = element("button", "vr-button"); confirmCancel.type = "button"; confirmCancel.textContent = "キャンセル";
  confirmActions.append(confirmRun, confirmCancel); confirmPanel.append(confirmActions);
  section.append(confirmPanel);
  const resultSummary = element("p", "vr-field-description vr-storage-transfer-summary"); resultSummary.hidden = true;
  const resultDetail = element("div", "vr-storage-transfer-detail");
  section.append(resultSummary, resultDetail);
  let lastDryRun = null;
  async function runTransfer(dryRun) {
    const busyButton = dryRun ? dryRunButton : executeButton;
    dryRunButton.disabled = true; executeButton.disabled = true; confirmRun.disabled = true; confirmCancel.disabled = true;
    busyButton.setAttribute("aria-busy", "true");
    try {
      const response = await fetch(`/api/settings/plugins/${encodeURIComponent(plugin.id)}/storage-transfer`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ direction: directionSelect.value, dry_run: dryRun }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "処理に失敗しました。");
      if (dryRun) lastDryRun = body;
      resultSummary.hidden = false;
      resultSummary.textContent = `書き込み ${body.written_total} 件 / 削除 ${body.deleted_total} 件 / 変更なし ${body.unchanged} 件`;
      resultDetail.replaceChildren();
      if ((body.written || []).length) resultDetail.append(storageTransferKeyList("書き込み対象", body.written, body.written_total));
      if ((body.deleted || []).length) resultDetail.append(storageTransferKeyList("削除対象", body.deleted, body.deleted_total));
      toast(dryRun ? "差分を確認しました。" : "上書きを実行しました。", "info");
      confirmPanel.hidden = true;
    } catch (error) {
      toast(error instanceof Error ? error.message : "処理に失敗しました。", "error");
    } finally {
      busyButton.removeAttribute("aria-busy");
      dryRunButton.disabled = false; confirmCancel.disabled = false; confirmRun.disabled = false;
      executeButton.disabled = blocked;
    }
  }
  dryRunButton.addEventListener("click", () => void runTransfer(true));
  executeButton.addEventListener("click", () => {
    const directionLabelText = directionSelect.selectedOptions[0]?.textContent || "";
    const unconfirmedNote = lastDryRun ? "" : " まだ差分を確認していません。";
    const deletionWarning = lastDryRun && lastDryRun.deleted_total > 0 ? ` 削除される ${lastDryRun.deleted_total} 件のデータは復元できません。` : "";
    confirmText.textContent = `${directionLabelText} の方向でデータを上書きします。${unconfirmedNote}${deletionWarning}`;
    confirmPanel.hidden = false;
  });
  confirmCancel.addEventListener("click", () => { confirmPanel.hidden = true; });
  confirmRun.addEventListener("click", () => void runTransfer(false));
  return section;
}
async function openSettingsDetail(plugin, opener) {
  document.querySelectorAll("#plugin-detail-renderer").forEach((existing) => existing.remove());
  const dialog = element("dialog", "vr-dialog"); dialog.id = "plugin-detail-renderer"; dialog.dataset.mobilePresentation = "fullscreen"; dialog.setAttribute("aria-labelledby", "plugin-detail-title"); dialog.setAttribute("aria-describedby", "plugin-detail-description");
  const closeIcon = element("button", "vr-dialog-close"); closeIcon.type = "button"; closeIcon.textContent = "×"; closeIcon.setAttribute("aria-label", `${plugin.title}の設定を閉じる`); closeIcon.addEventListener("click", () => dialog.close());
  const header = element("header", "vr-dialog-header"); const eyebrow = element("span", "vr-eyebrow"); eyebrow.textContent = "PLUGIN DETAILS"; const title = element("h2"); title.id = "plugin-detail-title"; title.textContent = plugin.title; const summary = element("p"); summary.id = "plugin-detail-description"; summary.textContent = plugin.summary; header.append(eyebrow, title, summary);
  const body = element("div", "vr-dialog-body");
  const metadata = element("dl", "vr-plugin-meta");
  for (const [label, value] of [["状態", plugin.enabled ? "有効" : "無効"], ["バージョン", plugin.version], ["ID", plugin.id]]) { const item = element("div"); const term = element("dt"); term.textContent = label; const description = element("dd"); description.textContent = String(value ?? "—"); item.append(term, description); metadata.append(item); }
  body.append(metadata);
  let readme = ""; try { const response = await fetch(`/api/settings/plugins/${encodeURIComponent(plugin.id)}/readme`); if (response.ok) readme = (await response.json()).readme || ""; } catch {}
  const contributions = surface.contributions.filter((item) => item.plugin_id === plugin.id && item.slot === "settings.detail");
  let configSection = element("section", "vr-settings-card vr-plugin-config-section");
  const refreshConfigSection = async () => {
    try {
      const management = await (await fetch("/api/settings/plugins")).json();
      const refreshed = (management.plugins || []).find(({ id }) => id === plugin.id);
      if (!refreshed) return;
      Object.assign(plugin, refreshed);
      configSection.replaceChildren(renderPluginConfigurationForm(plugin, refreshConfigSection));
    } catch {
      // Leave the existing section in place; the next explicit action will surface an error toast.
    }
  };
  configSection.append(renderPluginConfigurationForm(plugin, refreshConfigSection));
  if ((plugin.configuration || []).length) body.append(configSection);
  if ((plugin.capabilities || []).includes("storage")) body.append(renderStorageTransferSection(plugin));
  const content = element("div", "vr-plugin-detail-content");
  for (const contribution of contributions) {
    const runtime = runtimeFor(contribution, "");
    const scope = { plugin: contribution.plugin_id, contribution, state: runtime.state, persist: runtime.persist, instanceKey: "", slotContext: { plugin, readme } };
    await Promise.all((contribution.document.resources || []).map(({ id }) => loadResource(contribution, id, scope, false)));
    content.append(renderContribution(contribution, { plugin, readme }));
  }
  if (!contributions.length && !(plugin.configuration || []).length && !(plugin.capabilities || []).includes("storage")) { const empty = element("p", "vr-empty-state"); empty.textContent = "このプラグインに固有設定はありません。"; content.append(empty); }
  body.append(content);
  const footer = element("footer", "vr-dialog-footer"); const close = element("button", "vr-button"); close.type = "button"; close.textContent = "閉じる"; close.addEventListener("click", () => dialog.close()); footer.append(close);
  dialog.append(closeIcon, header, body, footer); document.body.append(dialog);
  dialog.addEventListener("close", () => { history.replaceState(null, "", location.pathname); opener?.focus(); dialog.remove(); }, { once: true }); dialog.showModal(); paintToast(); dialog.scrollTop = 0; closeIcon.focus({ preventScroll: true });
}
async function synchronizeResources(resources, announce = false) {
  const unique = [...new Set(resources)];
  const fallback = surface?.contributions?.[0];
  if (!fallback || !unique.length) return false;
  const before = new Map([...resourceStores].map(([key, store]) => [key, store.revision ?? JSON.stringify(store.data)]));
  const runtime = runtimeFor(fallback, "");
  const scope = { plugin: fallback.plugin_id, contribution: fallback, state: runtime.state, persist: runtime.persist, slotContext: {} };
  await Promise.all(unique.map((resource) => refreshResourceNamed(resource, scope)));
  const changed = [...resourceStores].some(([key, store]) => before.get(key) !== (store.revision ?? JSON.stringify(store.data)));
  if (changed) rerender();
  if (announce && changed) {
    const labels = unique.map((resource) => ({ session: "レビュー", annotations: "注釈", history: "変更履歴", jobs: "AI修正状況", "workflow-settings": "設定" })[resource] || resource);
    toast(`別の画面での変更を同期しました：${[...new Set(labels)].join("・")}`, "info");
  }
  return changed;
}
function layoutOrderSection(title, items, layoutPayload, kind) {
  const section = element("section", "vr-settings-card");
  const heading = element("h2", "vr-section-title"); heading.textContent = title; section.append(heading);
  if (!items.length) {
    const empty = element("p", "vr-empty-state"); empty.textContent = "並び替えできる項目はありません。"; section.append(empty);
    return section;
  }
  const list = element("ol", "vr-layout-order-list");
  items.forEach((item, index) => {
    const row = element("li", "vr-layout-order-row");
    const copy = element("div"); const name = element("span"); name.textContent = item.title; const pluginId = element("span", "vr-field-description"); pluginId.textContent = item.plugin_id; copy.append(name, pluginId);
    const controls = element("div", "vr-row");
    const up = element("button", "vr-button"); up.type = "button"; up.textContent = "上へ"; up.disabled = index === 0;
    const down = element("button", "vr-button"); down.type = "button"; down.textContent = "下へ"; down.disabled = index === items.length - 1;
    up.addEventListener("click", () => void moveLayoutItem(kind, items, index, -1, layoutPayload));
    down.addEventListener("click", () => void moveLayoutItem(kind, items, index, 1, layoutPayload));
    controls.append(up, down);
    row.append(copy, controls); list.append(row);
  });
  section.append(list);
  return section;
}
async function moveLayoutItem(kind, items, index, delta, layoutPayload) {
  const keys = items.map((item) => item.key);
  const target = index + delta;
  if (target < 0 || target >= keys.length) return;
  [keys[index], keys[target]] = [keys[target], keys[index]];
  await saveLayoutSettings({ [kind]: { order: keys } }, layoutPayload);
}
function stageSettingsSection(layoutPayload) {
  const section = element("section", "vr-settings-card");
  const heading = element("h2", "vr-section-title"); heading.textContent = "描画エリア"; section.append(heading);
  const stageViews = surface.layout.stage_views || [];
  const activeField = element("label", "vr-field vr-field-select");
  const activeLabel = element("span", "vr-field-label"); activeLabel.textContent = "表示する描画";
  const activeSelect = element("select", "vr-select"); activeSelect.disabled = stageViews.length < 2;
  for (const view of stageViews) { const option = element("option"); option.value = view.key; option.textContent = view.title; activeSelect.append(option); }
  activeSelect.value = surface.layout.active_stage || "";
  activeField.append(activeLabel, activeSelect);
  if (stageViews.length < 2) { const note = element("span", "vr-field-description"); note.textContent = "切り替え可能な描画がありません。"; activeField.append(note); }
  activeSelect.addEventListener("change", () => void saveLayoutSettings({ stage: { active: activeSelect.value } }, layoutPayload));
  section.append(activeField);
  const positionField = element("label", "vr-field vr-field-select");
  const positionLabel = element("span", "vr-field-label"); positionLabel.textContent = "切り替えメニューの位置";
  const positionSelect = element("select", "vr-select");
  for (const [value, label] of [["top-left", "左上"], ["top-right", "右上"], ["bottom-left", "左下"], ["bottom-right", "右下"]]) { const option = element("option"); option.value = value; option.textContent = label; positionSelect.append(option); }
  positionSelect.value = layoutPayload.settings.stage.switcher_position;
  positionField.append(positionLabel, positionSelect);
  positionSelect.addEventListener("change", () => void saveLayoutSettings({ stage: { switcher_position: positionSelect.value } }, layoutPayload));
  section.append(positionField);
  return section;
}
async function saveLayoutSettings(patch, layoutPayload) {
  try {
    const response = await fetch("/api/settings/layout", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: layoutPayload.revision, ...patch }) });
    if (response.status === 409) {
      toast("設定が別の画面で更新されました。再読み込みしました。", "error");
      await renderGeneralSettings();
      return;
    }
    if (!response.ok) throw new Error("設定を保存できませんでした。");
    const nextPayload = await response.json();
    surface = await (await fetch("/api/plugin-host/v1/surfaces/review")).json();
    applyTheme(surface.theme);
    paintGeneralSettings(nextPayload);
  } catch (error) {
    toast(error instanceof Error ? error.message : "設定を保存できませんでした。", "error");
  }
}
function paintGeneralSettings(layoutPayload) {
  const shell = element("div", "vr-app-shell vr-settings-shell");
  const header = element("header", "vr-header vr-settings-header");
  const brand = element("div", "vr-brand-copy"); const eyebrow = element("span", "vr-eyebrow"); eyebrow.textContent = "VREV"; const heading = element("h1"); heading.textContent = "設定"; brand.append(eyebrow, heading);
  const back = element("a", "vr-link"); back.href = "/"; back.textContent = "レビューへ戻る"; header.append(brand, back); shell.append(header);
  const page = element("main", "vr-settings-page");
  const pluginSection = element("section", "vr-settings-card");
  const pluginTitle = element("h2", "vr-section-title"); pluginTitle.textContent = "プラグイン"; pluginSection.append(pluginTitle);
  const pluginCopy = element("p"); pluginCopy.textContent = "インストール済みプラグインの有効状態や個別設定を管理できます。"; pluginSection.append(pluginCopy);
  if (layoutPayload.features?.plugin_management) {
    const link = element("a", "vr-link vr-button"); link.href = "/settings/plugins"; link.textContent = "プラグイン設定を開く"; pluginSection.append(link);
  } else {
    const note = element("p", "vr-field-description"); note.textContent = "プラグイン管理はワークスペース設定で無効化されています。"; pluginSection.append(note);
  }
  page.append(pluginSection);
  page.append(layoutOrderSection("ヘッダーの表示順", surface.layout.header_items, layoutPayload, "header"));
  page.append(layoutOrderSection("サイドバーの表示順", surface.layout.sidebar_items, layoutPayload, "sidebar"));
  page.append(stageSettingsSection(layoutPayload));
  shell.append(page, element("div", "toast-region"));
  root.replaceChildren(shell); root.setAttribute("aria-busy", "false");
  queueMicrotask(paintToast); requestAnimationFrame(paintToast);
}
async function renderGeneralSettings() {
  root.dataset.page = "settings";
  const [layoutResponse, surfaceResponse] = await Promise.all([fetch("/api/settings/layout"), fetch("/api/plugin-host/v1/surfaces/review")]);
  if (!layoutResponse.ok || !surfaceResponse.ok) throw new Error("設定を読み込めませんでした。");
  const layoutPayload = await layoutResponse.json();
  surface = await surfaceResponse.json(); applyTheme(surface.theme);
  paintGeneralSettings(layoutPayload);
}
async function start() {
  if (location.pathname === "/settings/plugins") return renderSettings();
  if (location.pathname === "/settings") return renderGeneralSettings();
  root.dataset.page = "review";
  const requestedPage = new URLSearchParams(location.search).get("page");
  if (requestedPage && !requestedPage.includes("..") && !/^[a-z][a-z0-9+.-]*:/i.test(requestedPage) && !requestedPage.startsWith("//")) {
    initialPagePath = requestedPage;
  }
  const response = await fetch("/api/plugin-host/v1/surfaces/review"); surface = await response.json(); applyTheme(surface.theme);
  const resourceLoads = [];
  const activeStageLoads = [];
  const activeStageKey = surface.layout.active_stage;
  const activeStage = surface.contributions.find((contribution) => `${contribution.plugin_id}/${contribution.id}` === activeStageKey);
  const isInactiveStage = (contribution) => contribution.slot === "review.stage" && contribution !== activeStage;
  for (const contribution of surface.contributions) {
    if (contribution.slot === "settings.detail" || isInactiveStage(contribution)) continue;
    const runtime = runtimeFor(contribution, "");
    const scope = { plugin: contribution.plugin_id, contribution, state: runtime.state, persist: runtime.persist, instanceKey: "", slotContext: {} };
    const loads = (contribution.document.resources || []).map((resource) => loadResource(contribution, resource.id, scope, false));
    (contribution === activeStage ? activeStageLoads : resourceLoads).push(...loads);
  }
  await Promise.all(activeStageLoads);
  rerender();
  if (resourceLoads.length) void Promise.all(resourceLoads).then(() => rerender());
  const allResources = [...new Set(surface.contributions.filter((contribution) => contribution.slot !== "settings.detail" && !isInactiveStage(contribution)).flatMap((contribution) => (contribution.document.resources || []).map(({ id }) => id)))];
  const eventPlugin = surface.contributions[0]?.plugin_id;
  if (eventPlugin) {
    const stream = new EventSource(`/api/plugin-host/v1/plugins/${encodeURIComponent(eventPlugin)}/events`);
    stream.addEventListener("message", (event) => { try { const update = JSON.parse(event.data); const resync = update.type === "resync.required"; const resources = resync && !(update.resources || []).length ? allResources : update.resources || []; void synchronizeResources(resources, !resync); } catch {} });
  }
  let fallbackSyncRunning = false;
  const fallbackSync = async () => {
    if (fallbackSyncRunning || document.visibilityState === "hidden") return;
    fallbackSyncRunning = true;
    try {
      const reviewChanged = await synchronizeResources(["session", "jobs"]);
      if (reviewChanged) await synchronizeResources(allResources.filter((resource) => resource !== "session" && resource !== "jobs"));
    } finally { fallbackSyncRunning = false; }
  };
  const fallbackTimer = setInterval(() => { void fallbackSync(); }, 2000);
  window.addEventListener("focus", () => { void fallbackSync(); });
  window.addEventListener("pagehide", () => clearInterval(fallbackTimer), { once: true });
}
start().catch(() => { root.textContent = "宣言UIを読み込めませんでした。/legacy で旧UIへ戻せます。"; root.setAttribute("aria-busy", "false"); });
