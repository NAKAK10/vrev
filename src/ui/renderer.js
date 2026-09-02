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
let settingsRenderPromise = null;
let activeToast = null;
const reviewSelection = { annotation_id: null, page_path: null, anchor: null };
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
  if ("resource" in value) return pointer(resourceStores.get(`${scope.plugin}:${value.resource}`)?.data, value.path || "");
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
function stateFor(contribution) {
  const key = `visual-review:renderer:1:${contribution.plugin_id}:${contribution.id}`;
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
    formDrafts.set(draftKey, node.type === "checkbox" ? node.checked : node.value);
    const declaration = (scope.contribution.document.local_state || []).find(({ key }) => `/${key}` === scope.valuePath);
    if (declaration) { scope.state[declaration.key] = node.type === "checkbox" ? node.checked : node.value; scope.persist(); }
  });
}
function renderCheckboxGroup(node, values, definition, scope) {
  node.setAttribute("role", "group");
  if (values.label) node.setAttribute("aria-label", String(values.label));
  const selected = new Set(Array.isArray(values.value) ? values.value : []);
  for (const option of values.options || []) {
    const value = typeof option === "object" ? option.value : option;
    const label = element("label", "vr-checkbox-option"); const input = element("input"); input.type = "checkbox"; input.value = String(value); input.checked = selected.has(value); const text = element("span"); text.textContent = String(typeof option === "object" ? option.label : option); label.append(input, text); node.append(label);
    input.addEventListener("change", () => { input.checked ? selected.add(value) : selected.delete(value); void execute([{ type: "local.set", path: definition.props.value.local, value: { literal: [...selected] } }], { ...scope, event: { value: [...selected] } }); });
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
  else if (["text", "status", "count", "badge", "time", "code", "live-status", "empty-state"].includes(type)) node = element(type === "code" ? "code" : "p", className);
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
  if (type === "empty-state") node.textContent = String(values.message ?? values.title ?? "");
  if (type === "status" && values.label) node.textContent = String(values.label);
  if (type === "status" && values.value !== undefined) node.dataset.status = String(values.value);
  if (type === "time" && values.value) { node.dateTime = String(values.value); const date = new Date(values.value); if (!Number.isNaN(date.getTime())) node.textContent = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date); }
  if (type === "live-status") { node.setAttribute("role", "status"); node.setAttribute("aria-live", values.politeness === "assertive" ? "assertive" : "polite"); }
  if (type === "count") node.textContent = `${values.value ?? 0}${values.label ? ` ${values.label}` : ""}`;
  if ((type === "section" || type === "panel") && values.title) { const title = element(type === "section" ? "h2" : "h3", "vr-section-title"); title.textContent = String(values.title); node.append(title); if (values.description) { const description = element("p", "vr-section-description"); description.textContent = String(values.description); node.append(description); } }
  if (type === "panel" && values.aria_label) node.setAttribute("aria-label", String(values.aria_label));
  if (type === "button" || type === "load-more") { node.textContent = String(values.label || ""); if (values.type) node.type = String(values.type); }
  if (type === "link") { node.textContent = String(values.label || ""); if (typeof values.href === "string") node.href = values.href; if (values.external) { node.target = "_blank"; node.rel = "noopener noreferrer"; } }
  if (["input", "textarea"].includes(type)) { control(node, values, { ...scope, valuePath: definition.props?.value?.local }); if (values.label) node.setAttribute("aria-label", String(values.label)); }
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
  if (type === "disclosure") node.open = Boolean(values.expanded);
  if (type === "annotation-mark-layer") { node.setAttribute("aria-hidden", "true"); node.__marks = Array.isArray(values.marks) ? values.marks : []; node.__selectedId = values.selected_id ?? reviewSelection.annotation_id; }
  bindEvents(node, definition, scope);
  for (const child of definition.children || []) (node.__content || node).append(renderNode(child, scope));
  if (type === "list" && values.empty_message && node.childElementCount === 0) { const empty = element("p", "vr-empty-state"); empty.textContent = String(values.empty_message); node.append(empty); }
  if (type === "slot") {
    const slot = String(values.name || "");
    const matches = surface.contributions.filter((item) => item.slot === slot);
    for (const contribution of matches) node.append(renderContribution(contribution, values.context ?? scope.slotContext, scope.instanceKey));
    node.hidden = matches.length === 0;
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
function bindEvents(node, definition, scope) {
  for (const [name, instructions] of Object.entries(definition.on || {})) {
    const eventName = ({ change: "change", input: "input", click: "click", submit: "submit", toggle: "toggle", close: "close", cancel: "cancel", confirm: "click" })[name] || name;
    node.addEventListener(eventName, (event) => {
      if (definition.type === "panel" && eventName === "click" && event.target !== node && event.target.closest("button,a,input,textarea,select,form,[role='button']")) return;
      if (eventName === "submit") event.preventDefault();
      if (name === "selection-commit" && event.detail?.selection) { reviewSelection.anchor = event.detail.selection; reviewSelection.page_path = event.detail.selection.page_path ?? null; scope.slotContext.review = { selection: reviewSelection }; }
      const eventData = event.detail ?? (name === "toggle" ? { expanded: node.open } : { value: node.type === "checkbox" ? node.checked : node.__optionValues?.get(node.value) ?? node.value });
      void execute(instructions, { ...scope, event: eventData, form: formValues(node) });
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
  const resources = (scope.contribution.document.resources || []).filter((resource) => Object.values(resource.input || {}).some((value) => value?.local === `/${key}`));
  await Promise.all(resources.map((resource) => loadResource(scope.contribution, resource.id, scope, false)));
}
function targetUrlForPage(target, pagePath) {
  if (!pagePath) return target.url;
  if (target.live_url) { try { const value = new URL(pagePath, target.live_url); return `/live${value.pathname}${value.search}${value.hash}`; } catch {} }
  return `/target/${String(pagePath).replace(/^\/+/, "").split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
}
function waitForFrame(frame) { return new Promise((resolve, reject) => { const timer = setTimeout(() => { cleanup(); reject(new Error("対象ページの読み込みがタイムアウトしました")); }, 8000); const cleanup = () => { clearTimeout(timer); frame.removeEventListener("load", loaded); frame.removeEventListener("error", failed); }; const loaded = () => { cleanup(); resolve(); }; const failed = () => { cleanup(); reject(new Error("対象ページを読み込めませんでした")); }; frame.addEventListener("load", loaded, { once: true }); frame.addEventListener("error", failed, { once: true }); }); }
function showTargetDiagnostic(container, message, detail = "") {
  let diagnostic = container.querySelector(":scope > .vr-target-diagnostic");
  if (!diagnostic) { diagnostic = element("div", "vr-target-diagnostic"); diagnostic.setAttribute("role", "alert"); container.append(diagnostic); }
  const title = element("strong"); title.textContent = message;
  diagnostic.replaceChildren(title);
  if (detail) { const copy = element("span"); copy.textContent = detail; diagnostic.append(copy); }
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
  const runtimeError = (message) => showTargetDiagnostic(container, "対象ページで JavaScript エラーが発生しました", String(message || "詳細は対象アプリのコンソールを確認してください。").slice(0, 300));
  const onError = (event) => runtimeError(event.message);
  const onRejection = (event) => runtimeError(event.reason?.message || event.reason);
  win.addEventListener("error", onError);
  win.addEventListener("unhandledrejection", onRejection);
  container.__targetDiagnosticCleanup = () => { win.removeEventListener("error", onError); win.removeEventListener("unhandledrejection", onRejection); delete container.__targetDiagnosticCleanup; };
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
async function execute(instructions, scope) {
  for (const instruction of instructions) {
    if (instruction.type === "local.set") { setPointer(scope.state, instruction.path, binding(instruction.value, scope)); scope.persist(); await refreshLocalDependencies(scope, instruction.path); rerender(); }
    else if (instruction.type === "local.toggle") { setPointer(scope.state, instruction.path, !pointer(scope.state, instruction.path)); scope.persist(); await refreshLocalDependencies(scope, instruction.path); rerender(); }
    else if (instruction.type === "dialog.open") { const dialog = dialogFor(scope, instruction.dialog); showDialog(dialog, scope, findNodeDefinition(scope.contribution.document.root, instruction.dialog)); }
    else if (instruction.type === "dialog.close") closeDialog(instruction.dialog ? dialogFor(scope, instruction.dialog) : document.querySelector("dialog[open]"));
    else if (instruction.type === "resource.refresh") await loadResource(scope.contribution, instruction.resource, scope);
    else if (instruction.type === "target.reload") document.querySelector(".vr-target-stage iframe")?.contentWindow?.location.reload();
    else if (instruction.type === "target.focus") { reviewSelection.annotation_id = binding(instruction.annotation_id, scope) ?? null; const layer = document.querySelector(".vr-annotation-mark-layer"); if (layer) layer.__selectedId = reviewSelection.annotation_id; await focusTarget(binding(instruction.target, scope), binding(instruction.anchor, scope), instruction.restore_context); }
    else if (instruction.type === "navigate.internal") location.assign(String(binding(instruction.path, scope)));
    else if (instruction.type === "navigate.external") { const url = String(binding(instruction.url, scope)); if ((!instruction.confirmation || confirm(String(instruction.confirmation))) && /^https?:\/\//.test(url)) open(url, "_blank", "noopener"); }
    else if (instruction.type === "toast.show") toast(String(binding(instruction.message, scope)), instruction.variant);
    else if (instruction.type === "command.execute") await command(instruction, scope);
  }
}
async function autoRunNewAnnotation(scope) {
  const settings = resourceStores.get("annotation-workflow:workflow-settings")?.data;
  if (settings?.auto_run !== true) return;
  try {
    const response = await fetch("/api/plugin-host/v1/plugins/annotation-workflow/commands/jobs.enqueue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ protocol: "plugin-bridge/1", request_id: crypto.randomUUID(), idempotency_key: crypto.randomUUID(), input: { runner: settings.runner, max_parallel: settings.max_parallel } }) });
    const result = await response.json().catch(() => null);
    if (!result?.ok) throw new Error(result?.error?.message || `${response.status} ${response.statusText}`);
    await Promise.all([refreshResourceNamed("annotations", scope), refreshResourceNamed("jobs", scope)]);
    toast("注釈を保存し、AI修正を開始しました", "success");
  } catch (error) {
    toast(`注釈は保存されましたが、AI修正を開始できませんでした：${error instanceof Error ? error.message : String(error)}`, "error");
  }
}
async function command(instruction, scope) {
  const key = `${scope.plugin}:${scope.contribution.id}:${scope.instanceKey || "root"}:${instruction.command}`;
  if (instruction.pending?.deduplicate && pending.has(key)) return pending.get(key);
  const input = Object.fromEntries(Object.entries(instruction.input).map(([name, value]) => [name, binding(value, scope)]));
  const disableId = instruction.pending?.disable ? instanceId(scope, instruction.pending.disable) : null;
  const disabledControl = disableId ? document.getElementById(disableId) : null;
  if (disabledControl) { disabledControl.disabled = true; disabledControl.setAttribute("aria-busy", "true"); }
  const requestCommand = async () => {
    const endpoint = `/api/plugin-host/v1/plugins/${encodeURIComponent(scope.plugin)}/commands/${encodeURIComponent(instruction.command)}`;
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
  const operation = (async () => {
    let result = await requestCommand();
    const revisionResource = instruction.expected_revision?.resource;
    if (!result.ok && result.error?.code === "CONFLICT" && typeof revisionResource === "string") {
      await refreshResourceNamed(revisionResource, scope);
      result = await requestCommand();
    }
    return result;
  })();
  pending.set(key, operation);
  try {
    const result = await operation; if (!result.ok) throw result.error;
    for (const effect of result.effects || []) if (effect.type === "resource.invalidate") for (const resource of effect.resources || []) await refreshResourceNamed(resource, scope);
    await execute(instruction.on_success || [], { ...scope, result: result.data });
    if (scope.plugin === "review" && instruction.command === "annotation.create") await autoRunNewAnnotation(scope);
    for (const declaration of scope.contribution.document.local_state || []) if (declaration.reset_on_success) scope.state[declaration.key] = structuredClone(declaration.default);
    for (const draftKey of [...formDrafts.keys()]) if (draftKey.startsWith(`${scope.plugin}:${scope.contribution.id}:${scope.instanceKey || "root"}:`)) formDrafts.delete(draftKey);
  }
  catch (error) { await execute(instruction.on_error || [], { ...scope, error: error instanceof Error ? { message: error.message } : error }); }
  finally { pending.delete(key); if (disabledControl?.isConnected) { disabledControl.disabled = false; disabledControl.removeAttribute("aria-busy"); } await execute(instruction.on_settled || [], scope); rerender(); }
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
function installHtmlSelection(container, frame, mode) {
  const doc = frame.contentDocument; const win = frame.contentWindow; if (!doc || !win) return;
  if (doc.__vrSelectionInstalled === mode && typeof doc.__vrSelectionCleanup === "function") return;
  doc.__vrSelectionCleanup?.();
  doc.__vrSelectionInstalled = mode;
  const commit = (anchor) => container.dispatchEvent(new CustomEvent("selection-commit", { detail: { selection: anchor } }));
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
function targetStage(definition, scope) {
  const container = element("div", "vr-target-stage stage"); container.tabIndex = 0;
  const target = binding(definition.props?.target, scope); const mode = String(binding(definition.props?.selection_mode, scope) || "browse"); container.__target = target; container.__mode = mode;
  if (!target) { container.textContent = "対象を読み込んでいます…"; return container; }
  const commit = (anchor) => container.dispatchEvent(new CustomEvent("selection-commit", { detail: { selection: anchor } }));
  if (target.kind === "image") {
    const image = element("img"); image.alt = "レビュー対象画像"; image.src = target.url; container.append(image); let start = null;
    image.addEventListener("load", redrawMarks); image.addEventListener("pointerdown", (event) => { if (mode !== "region") return; event.preventDefault(); const rect = image.getBoundingClientRect(); start = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }; image.setPointerCapture?.(event.pointerId); });
    image.addEventListener("pointerup", (event) => { if (!start) return; const rect = image.getBoundingClientRect(); const end = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }; const bounds = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }; start = null; if (bounds.width * rect.width < 5 || bounds.height * rect.height < 5) return announceFocusFailure("範囲が小さすぎます。もう一度ドラッグしてください。"); commit({ kind: "region", space: "image", bounds, natural: { width: image.naturalWidth, height: image.naturalHeight }, page_path: target.entry_path }); });
  } else {
    const frame = element("iframe"); frame.title = "レビュー対象ページ"; frame.src = target.url;
    if (!target.allow_scripts) frame.setAttribute("sandbox", "allow-same-origin allow-forms");
    container.append(frame); frame.addEventListener("load", () => { try { installTargetDiagnostics(container, frame); installHtmlSelection(container, frame, mode); redrawMarks(); container.dispatchEvent(new CustomEvent("load")); } catch (error) { container.dispatchEvent(new CustomEvent("error", { detail: { code: "TARGET_UNAVAILABLE", message: error.message } })); announceFocusFailure(`対象ページを操作できません：${error.message}`); } });
  }
  container.dataset.viewport = String(binding(definition.props?.viewport_mode, scope) || "desktop"); container.dataset.mode = mode;
  container.addEventListener("keydown", (event) => { if (event.key === "Escape") { container.__preview = null; redrawMarks(); container.dispatchEvent(new CustomEvent("selection-cancel", { detail: {} })); } });
  return container;
}
function redrawMarks() {
  const stage = document.querySelector(".vr-target-stage"); const layer = document.querySelector(".vr-annotation-mark-layer"); if (!stage || !layer) return; layer.replaceChildren(); const frame = stage.querySelector("iframe"); const image = stage.querySelector("img"); const stageRect = stage.getBoundingClientRect();
  const add = (bounds, index, className = "", status = "") => { const mark = element("div", `vr-annotation-mark ${className}`); if (status) mark.dataset.status = status; mark.style.left = `${bounds.left}px`; mark.style.top = `${bounds.top}px`; mark.style.width = `${Math.max(2, bounds.width)}px`; mark.style.height = `${Math.max(2, bounds.height)}px`; if (index) { const pin = element("span", "vr-annotation-pin"); pin.textContent = String(index); mark.append(pin); } layer.append(mark); };
  const filteredItems = resourceStores.get("annotation-workflow:annotations")?.data?.items;
  const visibleAnnotations = Array.isArray(filteredItems) ? filteredItems : [];
  for (const [index, annotation] of visibleAnnotations.entries()) { if (annotation.issue_state) continue; const currentPath = frame ? pagePathForFrame(stage, frame) : stage.__target?.entry_path; if (annotation.page_path && String(annotation.page_path).replace(/^\//, "") !== String(currentPath).replace(/^\//, "")) continue; try { let box = null; if (frame && annotation.kind === "dom") { const selected = annotation.anchor?.selector ? frame.contentDocument?.querySelector(annotation.anchor.selector) : null; if (selected) { const rect = selected.getBoundingClientRect(); const frameRect = frame.getBoundingClientRect(); box = { left: frameRect.left - stageRect.left + rect.left, top: frameRect.top - stageRect.top + rect.top, width: rect.width, height: rect.height }; } else if (annotation.anchor?.rect) { const doc = frame.contentDocument; const win = frame.contentWindow; const size = documentSize(doc); const frameRect = frame.getBoundingClientRect(); const b = annotation.anchor.rect; box = { left: frameRect.left - stageRect.left + b.x * size.width - win.scrollX, top: frameRect.top - stageRect.top + b.y * size.height - win.scrollY, width: b.width * size.width, height: b.height * size.height }; } } else if (frame && annotation.anchor?.bounds) { const doc = frame.contentDocument; const win = frame.contentWindow; const size = documentSize(doc); const frameRect = frame.getBoundingClientRect(); const b = annotation.anchor.bounds; box = { left: frameRect.left - stageRect.left + b.x * size.width - win.scrollX, top: frameRect.top - stageRect.top + b.y * size.height - win.scrollY, width: b.width * size.width, height: b.height * size.height }; } else if (image && annotation.anchor?.bounds) { const rect = image.getBoundingClientRect(); const b = annotation.anchor.bounds; box = { left: rect.left - stageRect.left + b.x * rect.width, top: rect.top - stageRect.top + b.y * rect.height, width: b.width * rect.width, height: b.height * rect.height }; } if (box) add(box, index + 1, annotation.id === layer.__selectedId ? "is-selected" : "", annotation.status); } catch {}
  }
  if (stage.__preview && frame) { const drag = stage.__preview; const win = frame.contentWindow; const frameRect = frame.getBoundingClientRect(); add({ left: frameRect.left - stageRect.left + Math.min(drag.x, drag.endX) - win.scrollX, top: frameRect.top - stageRect.top + Math.min(drag.y, drag.endY) - win.scrollY, width: Math.abs(drag.endX - drag.x), height: Math.abs(drag.endY - drag.y) }, null, "is-preview"); }
}
async function refreshResourceNamed(id, fallbackScope) {
  const owners = (surface?.contributions || []).filter((contribution) => (contribution.document.resources || []).some((resource) => resource.id === id));
  if (!owners.length) return loadResource(fallbackScope.contribution, id, fallbackScope, false);
  await Promise.all(owners.map((contribution) => { const runtime = documents.get(`${contribution.plugin_id}:${contribution.id}:root`) || stateFor(contribution); const scope = { plugin: contribution.plugin_id, contribution, state: runtime.state, persist: runtime.persist, instanceKey: "", slotContext: {} }; return loadResource(contribution, id, scope, false); }));
}
async function loadResource(contribution, id, scope, shouldRender = true) {
  const declaration = (contribution.document.resources || []).find((item) => item.id === id); if (!declaration) return;
  const key = `${contribution.plugin_id}:${id}`;
  const generation = (resourceRequestGenerations.get(key) || 0) + 1;
  resourceRequestGenerations.set(key, generation);
  resourceStores.set(key, { ...resourceStores.get(key), state: "loading" });
  const input = Object.fromEntries(Object.entries(declaration.input).map(([name, value]) => [name, binding(value, scope)]));
  try {
    const response = await fetch(`/api/plugin-host/v1/plugins/${encodeURIComponent(contribution.plugin_id)}/queries/${encodeURIComponent(declaration.query)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ protocol: "plugin-bridge/1", request_id: crypto.randomUUID(), input }) });
    const result = await response.json(); if (!result.ok) throw result.error;
    if (resourceRequestGenerations.get(key) !== generation) return;
    const previous = resourceStores.get(key)?.data;
    const data = Number(input.offset) > 0 && Array.isArray(previous?.events) && Array.isArray(result.data?.events)
      ? { ...result.data, events: [...previous.events, ...result.data.events] }
      : result.data;
    resourceStores.set(key, { state: "ready", data, revision: result.revision });
  } catch (error) {
    if (resourceRequestGenerations.get(key) !== generation) return;
    resourceStores.set(key, { state: "error", error });
  }
  if (shouldRender) rerender();
}
function renderContribution(contribution, slotContext = {}, parentInstanceKey = "") {
  const runtimeKey = `${contribution.plugin_id}:${contribution.id}:${parentInstanceKey || "root"}`;
  let runtime = documents.get(runtimeKey);
  if (!runtime) { runtime = stateFor(contribution); documents.set(runtimeKey, runtime); }
  const scope = { plugin: contribution.plugin_id, contribution, state: runtime.state, persist: runtime.persist, instanceKey: parentInstanceKey, slotContext: { ...(slotContext && typeof slotContext === "object" ? slotContext : {}), review: { selection: reviewSelection } } };
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
function patchReviewTree(nextTree) {
  const currentShell = root.firstElementChild;
  const currentStage = currentShell?.querySelector?.(".vr-target-stage");
  const nextStage = nextTree?.querySelector?.(".vr-target-stage");
  if (!currentShell || !currentStage || !nextStage || targetIdentity(currentStage) !== targetIdentity(nextStage)) return false;
  const currentPrimary = currentStage.parentElement;
  const nextPrimary = nextStage.parentElement;
  const currentSplit = currentPrimary?.parentElement;
  const nextSplit = nextPrimary?.parentElement;
  if (!currentPrimary || !nextPrimary || !currentSplit || !nextSplit) return false;

  currentStage.dataset.viewport = nextStage.dataset.viewport;
  currentStage.dataset.mode = nextStage.dataset.mode;
  currentStage.__mode = nextStage.__mode;
  currentStage.__target = nextStage.__target;
  currentStage.__preview = null;
  const frame = currentStage.querySelector("iframe");
  if (frame) installHtmlSelection(currentStage, frame, currentStage.__mode);

  for (const child of [...currentPrimary.children]) if (child !== currentStage) child.remove();
  for (const child of [...nextPrimary.children]) if (child !== nextStage) currentPrimary.append(child);
  for (const child of [...currentSplit.children]) if (child !== currentPrimary) child.remove();
  for (const child of [...nextSplit.children]) if (child !== nextPrimary) currentSplit.append(child);

  for (const child of [...currentShell.children]) if (child !== currentSplit) child.remove();
  let beforeSplit = true;
  for (const child of [...nextTree.children]) {
    if (child === nextSplit) { beforeSplit = false; continue; }
    if (beforeSplit) currentShell.insertBefore(child, currentSplit);
    else currentShell.append(child);
  }
  return true;
}
function rerender() {
  if (location.pathname === "/settings/plugins") {
    settingsRenderPromise ??= renderSettings().finally(() => { settingsRenderPromise = null; });
    return;
  }
  const activeId = document.activeElement?.id; dialogs.clear();
  const main = surface.contributions.find(({ slot }) => slot === "review.main");
  const nextTree = main ? renderContribution(main) : Object.assign(element("p", "vr-diagnostic"), { textContent: "review.main contribution is unavailable" });
  if (patchReviewTree(nextTree)) {
    cleanupPluginRuntimes();
    const connectedMain = root.firstElementChild;
    if (main?.browser_module_url && connectedMain instanceof HTMLElement) queueMicrotask(() => { if (connectedMain.isConnected) void mountPluginRuntime(main, connectedMain); });
  } else {
    root.replaceChildren(nextTree);
    cleanupPluginRuntimes();
  }
  root.dataset.sidebar = surface.layout.sidebar; root.setAttribute("aria-busy", "false");
  queueMicrotask(paintToast); requestAnimationFrame(paintToast);
  if (activeId) document.getElementById(activeId)?.focus({ preventScroll: true });
  requestAnimationFrame(redrawMarks);
}
async function renderSettings() {
  root.dataset.page = "settings";
  const [managementResponse, surfaceResponse] = await Promise.all([fetch("/api/settings/plugins"), fetch("/api/plugin-host/v1/surfaces/review")]);
  if (!managementResponse.ok || !surfaceResponse.ok) throw new Error("プラグイン設定を読み込めませんでした。");
  const management = await managementResponse.json(); surface = await surfaceResponse.json(); applyTheme(surface.theme);
  const shell = element("div", "vr-app-shell vr-settings-shell");
  const header = element("header", "vr-header vr-settings-header");
  const brand = element("div", "vr-brand-copy"); const eyebrow = element("span", "vr-eyebrow"); eyebrow.textContent = "VISUAL REVIEW"; const heading = element("h1"); heading.textContent = "プラグイン設定"; brand.append(eyebrow, heading);
  const back = element("a", "vr-link"); back.href = "/"; back.textContent = "レビューへ戻る"; header.append(brand, back); shell.append(header);
  const page = element("main", "vr-settings-page");
  const intro = element("section", "vr-settings-intro"); const introHeading = element("h2"); introHeading.textContent = "インストール済みプラグイン"; const introCopy = element("p"); introCopy.textContent = "機能の有効状態を切り替え、プラグインごとの説明と設定を確認できます。"; intro.append(introHeading, introCopy); page.append(intro);
  if (surface.diagnostics?.length) { const warning = element("p", "vr-settings-error"); warning.textContent = `${surface.diagnostics.length}件のプラグインUIを読み込めませんでした。詳細は各プラグインを確認してください。`; page.append(warning); }
  const list = element("section", "vr-settings-list"); list.setAttribute("aria-label", "インストール済みプラグイン");
  for (const plugin of management.plugins || []) {
    const row = element("article", "vr-plugin-row"); row.dataset.pluginId = plugin.id;
    const copy = element("div", "vr-plugin-copy"); const title = element("h3"); title.textContent = plugin.title; const summary = element("p"); summary.textContent = plugin.summary; copy.append(title, summary);
    const toggleLabel = element("label", "vr-plugin-toggle"); const toggle = element("input"); toggle.type = "checkbox"; toggle.role = "switch"; toggle.checked = plugin.enabled; toggle.setAttribute("aria-label", `${plugin.title}を有効にする`); const toggleText = element("span"); toggleText.textContent = "有効"; toggleLabel.append(toggle, toggleText);
    toggle.addEventListener("change", async () => {
      const previous = !toggle.checked; row.setAttribute("aria-busy", "true"); toggle.disabled = true;
      try {
        const response = await fetch(`/api/settings/plugins/${encodeURIComponent(plugin.id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: management.revision, enabled: toggle.checked, configuration: Object.fromEntries((plugin.configuration || []).filter((field) => field.source === "workspace" && field.value !== null).map((field) => [field.key, field.value])) }) });
        if (!response.ok) throw new Error("設定を保存できませんでした。");
        location.reload();
      } catch (error) { toggle.checked = previous; toast(error instanceof Error ? error.message : "設定を保存できませんでした。", "error"); }
      finally { toggle.disabled = false; row.removeAttribute("aria-busy"); }
    });
    const details = element("button", "vr-button"); details.type = "button"; details.textContent = "詳細"; details.setAttribute("aria-haspopup", "dialog");
    details.addEventListener("click", () => { location.hash = plugin.id; void openSettingsDetail(plugin, details); });
    row.append(copy, toggleLabel, details); list.append(row);
  }
  page.append(list); shell.append(page, element("div", "toast-region")); root.replaceChildren(shell); root.setAttribute("aria-busy", "false"); queueMicrotask(paintToast); requestAnimationFrame(paintToast);
  const selected = (management.plugins || []).find(({ id }) => id === decodeURIComponent(location.hash.slice(1))); if (selected) await openSettingsDetail(selected, null);
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
  const content = element("div", "vr-plugin-detail-content");
  for (const contribution of contributions) {
    const runtimeKey = `${contribution.plugin_id}:${contribution.id}:root`; let runtime = documents.get(runtimeKey); if (!runtime) { runtime = stateFor(contribution); documents.set(runtimeKey, runtime); }
    const scope = { plugin: contribution.plugin_id, contribution, state: runtime.state, persist: runtime.persist, instanceKey: "", slotContext: { plugin, readme } };
    await Promise.all((contribution.document.resources || []).map(({ id }) => loadResource(contribution, id, scope, false)));
    content.append(renderContribution(contribution, { plugin, readme }));
  }
  if (!contributions.length) { const empty = element("p", "vr-empty-state"); empty.textContent = "このプラグインに固有設定はありません。"; content.append(empty); }
  body.append(content);
  const footer = element("footer", "vr-dialog-footer"); const close = element("button", "vr-button"); close.type = "button"; close.textContent = "閉じる"; close.addEventListener("click", () => dialog.close()); footer.append(close);
  dialog.append(closeIcon, header, body, footer); document.body.append(dialog);
  dialog.addEventListener("close", () => { history.replaceState(null, "", location.pathname); opener?.focus(); dialog.remove(); }, { once: true }); dialog.showModal(); paintToast(); dialog.scrollTop = 0; closeIcon.focus({ preventScroll: true });
}
async function synchronizeResources(resources, announce = false) {
  const unique = [...new Set(resources)];
  const fallback = surface?.contributions?.[0];
  if (!fallback || !unique.length) return;
  const before = new Map([...resourceStores].map(([key, store]) => [key, store.revision ?? JSON.stringify(store.data)]));
  const runtime = documents.get(`${fallback.plugin_id}:${fallback.id}`) || stateFor(fallback);
  const scope = { plugin: fallback.plugin_id, contribution: fallback, state: runtime.state, persist: runtime.persist, slotContext: {} };
  await Promise.all(unique.map((resource) => refreshResourceNamed(resource, scope)));
  rerender();
  const changed = [...resourceStores].some(([key, store]) => before.get(key) !== (store.revision ?? JSON.stringify(store.data)));
  if (announce && changed) {
    const labels = unique.map((resource) => ({ session: "レビュー", annotations: "注釈", history: "変更履歴", jobs: "AI修正状況", "workflow-settings": "設定" })[resource] || resource);
    toast(`別の画面での変更を同期しました：${[...new Set(labels)].join("・")}`, "info");
  }
}
async function start() {
  if (location.pathname === "/settings/plugins") return renderSettings();
  root.dataset.page = "review";
  const response = await fetch("/api/plugin-host/v1/surfaces/review"); surface = await response.json(); applyTheme(surface.theme);
  const resourceLoads = [];
  const main = surface.contributions.find(({ slot }) => slot === "review.main");
  for (const contribution of surface.contributions) {
    const runtime = stateFor(contribution); documents.set(`${contribution.plugin_id}:${contribution.id}`, runtime);
    const scope = { plugin: contribution.plugin_id, contribution, state: runtime.state, persist: runtime.persist, slotContext: {} };
    const loads = (contribution.document.resources || []).map((resource) => loadResource(contribution, resource.id, scope, false));
    if (contribution === main) await Promise.all(loads);
    else resourceLoads.push(...loads);
  }
  rerender();
  if (resourceLoads.length) void Promise.all(resourceLoads).then(() => rerender());
  const allResources = [...new Set(surface.contributions.flatMap((contribution) => (contribution.document.resources || []).map(({ id }) => id)))];
  const eventPlugin = surface.contributions[0]?.plugin_id;
  if (eventPlugin) {
    const stream = new EventSource(`/api/plugin-host/v1/plugins/${encodeURIComponent(eventPlugin)}/events`);
    stream.addEventListener("message", (event) => { try { const update = JSON.parse(event.data); const resync = update.type === "resync.required"; const resources = resync && !(update.resources || []).length ? allResources : update.resources || []; void synchronizeResources(resources, !resync); } catch {} });
  }
  let fallbackSyncRunning = false;
  const fallbackSync = async () => {
    if (fallbackSyncRunning || document.visibilityState === "hidden") return;
    fallbackSyncRunning = true;
    try { await synchronizeResources(["session", "annotations", "history", "jobs"]); }
    finally { fallbackSyncRunning = false; }
  };
  const fallbackTimer = setInterval(() => { void fallbackSync(); }, 2000);
  window.addEventListener("focus", () => { void fallbackSync(); });
  window.addEventListener("pagehide", () => clearInterval(fallbackTimer), { once: true });
}
start().catch(() => { root.textContent = "宣言UIを読み込めませんでした。/legacy で旧UIへ戻せます。"; root.setAttribute("aria-busy", "false"); });
