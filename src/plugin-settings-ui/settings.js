const listElement = document.querySelector("#plugin-list");
const statusElement = document.querySelector("#page-status");
const rowTemplate = document.querySelector("#plugin-row-template");
const dialog = document.querySelector("#plugin-details-dialog");
const dialogTitle = document.querySelector("#plugin-dialog-title");
const dialogSummary = document.querySelector("#plugin-dialog-summary");
const dialogState = document.querySelector("#plugin-dialog-state");
const dialogVersion = document.querySelector("#plugin-dialog-version");
const dialogId = document.querySelector("#plugin-dialog-id");
const dialogCapabilities = document.querySelector("#plugin-dialog-capabilities");
const configurationSection = document.querySelector("#plugin-configuration-section");
const configurationForm = document.querySelector("#plugin-configuration-form");
const configurationSave = document.querySelector("#plugin-configuration-save");
const readmeStatus = document.querySelector("#readme-status");
const readmeContent = document.querySelector("#readme-content");
const toastRegion = document.querySelector("#toast-region");

let revision = "";
let pluginsById = new Map();
let mutationInFlight = false;
let activePluginId = null;
let dialogGeneration = 0;
let dialogOpener = null;
let toastTimer;
const readmeCache = new Map();

async function request(url, init) {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error ?? `${response.status} ${response.statusText}`);
  return payload;
}

function showToast(message, error = false) {
  if (toastTimer) window.clearTimeout(toastTimer);
  toastRegion.textContent = message;
  toastRegion.classList.toggle("is-error", error);
  toastRegion.classList.add("is-visible");
  toastTimer = window.setTimeout(() => {
    toastRegion.classList.remove("is-visible");
    toastRegion.textContent = "";
  }, 4200);
}

function setMutationState(pending) {
  mutationInFlight = pending;
  for (const control of document.querySelectorAll('.plugin-row input[role="switch"], .details-button, #plugin-configuration-save')) {
    control.disabled = pending;
  }
}

function committedConfiguration(plugin) {
  const result = {};
  for (const field of plugin.configuration) {
    if (field.source !== "workspace") continue;
    const value = field.value ?? field.default;
    if (value !== null && value !== undefined && value !== "") result[field.key] = value;
  }
  return result;
}

function configurationValue(field) {
  if (field.type === "boolean") return field.value === true;
  return field.value ?? field.default ?? "";
}

function renderField(form, field) {
  const label = document.createElement("label");
  const title = document.createElement("span");
  title.textContent = field.title;
  label.append(title);
  let input;
  if (field.source === "environment") {
    input = document.createElement("p");
    input.className = "environment-state";
    input.textContent = `${field.environment}: ${field.present ? "設定済み" : "未設定"}`;
    label.append(input);
  } else if (field.type === "select") {
    input = document.createElement("select");
    for (const item of field.options ?? []) {
      const option = document.createElement("option");
      option.value = item.value;
      option.textContent = item.label;
      input.append(option);
    }
    input.name = field.key;
    input.required = field.required;
    input.value = String(configurationValue(field));
    label.append(input);
  } else {
    input = document.createElement("input");
    input.type = field.type === "boolean" ? "checkbox" : field.type === "integer" ? "number" : "text";
    input.name = field.key;
    input.required = field.required;
    if (field.type === "integer") input.step = "1";
    if (field.type === "boolean") input.checked = configurationValue(field);
    else input.value = String(configurationValue(field));
    label.append(input);
  }
  if (field.description) {
    const small = document.createElement("small");
    small.textContent = field.description;
    label.append(small);
  }
  form.append(label);
}

function collectConfiguration(form, fields) {
  const result = {};
  for (const field of fields) {
    if (field.source !== "workspace") continue;
    const input = form.elements.namedItem(field.key);
    if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement)) continue;
    if (field.type === "boolean") result[field.key] = input.checked;
    else if (field.type === "integer" && input.value !== "") result[field.key] = Number(input.value);
    else if (input.value !== "") result[field.key] = input.value;
  }
  return result;
}

function appendInlineMarkdown(parent, source) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > offset) parent.append(document.createTextNode(source.slice(offset, index)));
    const token = match[0];
    if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else if (token.startsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      parent.append(strong);
    } else if (token.startsWith("*")) {
      const emphasis = document.createElement("em");
      emphasis.textContent = token.slice(1, -1);
      parent.append(emphasis);
    } else {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      let safeUrl = null;
      try {
        const parsed = new URL(linkMatch[2]);
        if (["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password) safeUrl = parsed.href;
      } catch { /* unsafe and relative links remain text */ }
      if (safeUrl) {
        const link = document.createElement("a");
        link.textContent = linkMatch[1];
        link.href = safeUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        parent.append(link);
      } else parent.append(document.createTextNode(linkMatch[1]));
    }
    offset = index + token.length;
  }
  if (offset < source.length) parent.append(document.createTextNode(source.slice(offset)));
}

function isMarkdownBlockStart(line) {
  return /^\s*$|^#{1,6}\s+|^```|^\s*[-*+]\s+|^\s*\d+\.\s+|^>\s?|^(?:-{3,}|\*{3,})\s*$/.test(line);
}

function renderMarkdown(markdown) {
  const fragment = document.createDocumentFragment();
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    if (line.startsWith("```")) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) codeLines.push(lines[index++]);
      if (index < lines.length) index += 1;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = codeLines.join("\n");
      pre.append(code);
      fragment.append(pre);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const element = document.createElement(`h${Math.min(6, heading[1].length + 3)}`);
      appendInlineMarkdown(element, heading[2]);
      fragment.append(element);
      index += 1;
      continue;
    }
    if (/^(?:-{3,}|\*{3,})\s*$/.test(line)) {
      fragment.append(document.createElement("hr"));
      index += 1;
      continue;
    }
    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      const list = document.createElement(unordered ? "ul" : "ol");
      const pattern = unordered ? /^\s*[-*+]\s+(.+)$/ : /^\s*\d+\.\s+(.+)$/;
      while (index < lines.length) {
        const itemMatch = pattern.exec(lines[index]);
        if (!itemMatch) break;
        const item = document.createElement("li");
        appendInlineMarkdown(item, itemMatch[1]);
        list.append(item);
        index += 1;
      }
      fragment.append(list);
      continue;
    }
    if (line.startsWith(">")) {
      const quote = document.createElement("blockquote");
      const paragraph = document.createElement("p");
      const parts = [];
      while (index < lines.length && lines[index].startsWith(">")) parts.push(lines[index++].replace(/^>\s?/, ""));
      appendInlineMarkdown(paragraph, parts.join(" "));
      quote.append(paragraph);
      fragment.append(quote);
      continue;
    }
    const parts = [line.trim()];
    index += 1;
    while (index < lines.length && !isMarkdownBlockStart(lines[index])) parts.push(lines[index++].trim());
    const paragraph = document.createElement("p");
    appendInlineMarkdown(paragraph, parts.join(" "));
    fragment.append(paragraph);
  }
  return fragment;
}

async function loadReadme(plugin, generation) {
  readmeContent.replaceChildren();
  if (!plugin.has_readme) {
    readmeStatus.textContent = "READMEはありません。";
    return;
  }
  const cacheKey = `${plugin.id}@${plugin.version}`;
  readmeStatus.textContent = "読み込み中…";
  try {
    let markdown = readmeCache.get(cacheKey);
    if (markdown === undefined) {
      const payload = await request(`/api/settings/plugins/${encodeURIComponent(plugin.id)}/readme`);
      if (typeof payload.readme !== "string") throw new Error("README response is invalid");
      markdown = payload.readme;
      readmeCache.set(cacheKey, markdown);
    }
    if (generation !== dialogGeneration) return;
    readmeContent.replaceChildren(renderMarkdown(markdown));
    readmeStatus.textContent = "";
  } catch (error) {
    if (generation !== dialogGeneration) return;
    readmeStatus.textContent = `READMEを読み込めません: ${error.message}`;
  }
}

function renderRows() {
  const plugins = [...pluginsById.values()].sort((left, right) => left.title.localeCompare(right.title, "ja"));
  listElement.replaceChildren(...plugins.map((plugin) => {
    const row = rowTemplate.content.firstElementChild.cloneNode(true);
    row.dataset.pluginId = plugin.id;
    const title = row.querySelector("h3");
    title.textContent = plugin.title;
    row.querySelector(".plugin-summary").textContent = plugin.summary;
    const toggle = row.querySelector('.plugin-toggle input[role="switch"]');
    const toggleLabel = row.querySelector(".plugin-toggle-label");
    const syncToggle = () => { toggleLabel.textContent = toggle.checked ? "有効" : "無効"; };
    toggle.checked = plugin.enabled;
    toggle.setAttribute("aria-label", `${plugin.title}を有効にする`);
    toggle.addEventListener("change", () => {
      syncToggle();
      void autosaveToggle(plugin.id, toggle.checked, row, toggle);
    });
    syncToggle();
    const details = row.querySelector(".details-button");
    details.setAttribute("aria-label", `${plugin.title}の詳細`);
    details.addEventListener("click", () => openDetails(plugin.id, details, true));
    return row;
  }));
  setMutationState(mutationInFlight);
}

function applyPayload(payload) {
  revision = payload.revision;
  pluginsById = new Map(payload.plugins.map((plugin) => [plugin.id, plugin]));
  renderRows();
}

async function autosaveToggle(pluginId, enabled, row, toggle) {
  const plugin = pluginsById.get(pluginId);
  if (!plugin || mutationInFlight) {
    toggle.checked = plugin?.enabled ?? !enabled;
    return;
  }
  row.setAttribute("aria-busy", "true");
  setMutationState(true);
  try {
    const next = await request(`/api/settings/plugins/${encodeURIComponent(pluginId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision, enabled, configuration: committedConfiguration(plugin) }),
    });
    applyPayload(next);
    showToast(`${plugin.title}を${enabled ? "有効" : "無効"}にしました。`);
  } catch (error) {
    toggle.checked = plugin.enabled;
    showToast(`変更を保存できません: ${error.message}`, true);
  } finally {
    row.removeAttribute("aria-busy");
    setMutationState(false);
    renderRows();
  }
}

function populateDetails(plugin) {
  const generation = ++dialogGeneration;
  dialogTitle.textContent = plugin.title;
  dialogSummary.textContent = plugin.summary;
  dialogState.textContent = plugin.enabled ? (plugin.missing.length ? `設定が必要: ${plugin.missing.join(", ")}` : "有効") : "無効";
  dialogVersion.textContent = plugin.version;
  dialogId.textContent = plugin.id;
  dialogCapabilities.textContent = plugin.capabilities.length ? plugin.capabilities.join(" / ") : "なし";
  configurationForm.replaceChildren();
  for (const field of plugin.configuration) renderField(configurationForm, field);
  configurationSection.hidden = plugin.configuration.length === 0;
  void loadReadme(plugin, generation);
}

function openDetails(pluginId, opener = null, updateHash = false) {
  const plugin = pluginsById.get(pluginId);
  if (!plugin) return;
  activePluginId = pluginId;
  dialogOpener = opener;
  populateDetails(plugin);
  if (!dialog.open) dialog.showModal();
  if (updateHash) history.replaceState(null, "", `#${pluginId}`);
  dialog.querySelector(".dialog-close").focus();
}

function closeDetails() {
  if (!dialog.open) return;
  dialog.close();
}

configurationSave.addEventListener("click", () => void (async () => {
  const plugin = activePluginId ? pluginsById.get(activePluginId) : null;
  if (!plugin || mutationInFlight) return;
  setMutationState(true);
  try {
    const next = await request(`/api/settings/plugins/${encodeURIComponent(plugin.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision, enabled: plugin.enabled, configuration: collectConfiguration(configurationForm, plugin.configuration) }),
    });
    applyPayload(next);
    const updated = pluginsById.get(plugin.id);
    if (updated) populateDetails(updated);
    showToast(`${plugin.title}の設定を保存しました。`);
  } catch (error) {
    showToast(`設定を保存できません: ${error.message}`, true);
  } finally { setMutationState(false); }
})());

for (const button of document.querySelectorAll("[data-dialog-close]")) button.addEventListener("click", closeDetails);
dialog.addEventListener("click", (event) => { if (event.target === dialog) closeDetails(); });
dialog.addEventListener("close", () => {
  const pluginId = activePluginId;
  activePluginId = null;
  dialogGeneration += 1;
  if (location.hash === `#${pluginId}`) history.replaceState(null, "", location.pathname);
  const currentOpener = pluginId ? document.querySelector(`[data-plugin-id="${CSS.escape(pluginId)}"] .details-button`) : null;
  (currentOpener ?? dialogOpener)?.focus();
  dialogOpener = null;
});
window.addEventListener("hashchange", () => {
  const pluginId = decodeURIComponent(location.hash.slice(1));
  if (pluginId && pluginsById.has(pluginId)) openDetails(pluginId);
  else if (!pluginId) closeDetails();
});

void request("/api/settings/plugins")
  .then((payload) => {
    applyPayload(payload);
    statusElement.textContent = payload.plugins.length ? "" : "インストール済みプラグインはありません。";
    const pluginId = decodeURIComponent(location.hash.slice(1));
    if (pluginId && pluginsById.has(pluginId)) openDetails(pluginId);
  })
  .catch((error) => { statusElement.textContent = `読み込めません: ${error.message}`; });
