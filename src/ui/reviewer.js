"use strict";

const DEFAULT_STATUS_FILTERS = ["open", "in_progress", "addressed"];
const DEFAULT_KIND_FILTERS = ["dom", "region"];
const FILTER_STORAGE_KEY = "visual-review:annotation-filters";
const HISTORY_PAGE_SIZE = 24;
const replyDrafts = new Map();

const state = {
  session: null,
  review: { annotations: [], events: [] },
  mode: "browse",
  viewport: "desktop",
  filters: { statuses: new Set(DEFAULT_STATUS_FILTERS), kinds: new Set(DEFAULT_KIND_FILTERS) },
  pendingAnnotation: null,
  drag: null,
  highlightedId: null,
  pendingFocusId: null,
  toastTimer: null,
  boundDocuments: new WeakSet(),
  revealedContexts: new Set(),
  currentFileState: null,
  fileStateRequestId: 0,
  historyRenderLimit: HISTORY_PAGE_SIZE,
  historySignature: "",
};

const elements = {
  targetPath: document.querySelector("#target-path"),
  modeButtons: [...document.querySelectorAll(".mode-button[data-mode]")],
  viewportButtons: [...document.querySelectorAll(".viewport-button[data-viewport]")],
  refreshButton: document.querySelector("#refresh-button"),
  hashWarning: document.querySelector("#hash-warning"),
  stage: document.querySelector("#stage"),
  frame: document.querySelector("#target-frame"),
  imageWrap: document.querySelector("#image-wrap"),
  image: document.querySelector("#target-image"),
  overlay: document.querySelector("#overlay"),
  stageEmpty: document.querySelector("#stage-empty"),
  modeHelp: document.querySelector("#mode-help"),
  trustIndicator: document.querySelector("#trust-indicator"),
  filterOpenButton: document.querySelector("#annotation-filter-open"),
  filterDialog: document.querySelector("#annotation-filter-dialog"),
  filterCloseButton: document.querySelector("[data-annotation-filter-close]"),
  filterResetButton: document.querySelector("#annotation-filter-reset"),
  statusFilterInputs: [...document.querySelectorAll('input[name="annotation-status"]')],
  kindFilterInputs: [...document.querySelectorAll('input[name="annotation-kind"]')],
  filterSummary: document.querySelector("#filter-summary"),
  statusCounts: document.querySelector("#status-counts"),
  annotationTotal: document.querySelector("#annotation-total"),
  annotationList: document.querySelector("#annotation-list"),
  annotationEmpty: document.querySelector("#annotation-empty"),
  historyToggle: document.querySelector("#history-toggle"),
  historyCount: document.querySelector("#history-count"),
  historyList: document.querySelector("#history-list"),
  historyLoadMore: document.querySelector("#history-load-more"),
  dialog: document.querySelector("#comment-dialog"),
  commentForm: document.querySelector("#comment-form"),
  dialogTitle: document.querySelector("#dialog-title"),
  selectionSummary: document.querySelector("#selection-summary"),
  commentInput: document.querySelector("#comment-input"),
  commentSubmit: document.querySelector("#comment-submit"),
  dialogCancelButtons: [...document.querySelectorAll("[data-dialog-cancel]")],
  toast: document.querySelector("#toast-region"),
};

const STATUS_LABELS = {
  open: "未対応",
  in_progress: "AI対応中",
  addressed: "AI対応済み",
  resolved: "解決済み",
};
const KIND_LABELS = { dom: "ノード", region: "範囲" };

function restoreFilters() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(FILTER_STORAGE_KEY) ?? "null");
    if (!stored || !Array.isArray(stored.statuses) || !Array.isArray(stored.kinds)) return;
    state.filters.statuses = new Set(stored.statuses.filter((value) => value in STATUS_LABELS));
    state.filters.kinds = new Set(stored.kinds.filter((value) => value in KIND_LABELS));
  } catch (_error) { /* retain defaults */ }
}

function syncFilterControls() {
  for (const input of elements.statusFilterInputs) input.checked = state.filters.statuses.has(input.value);
  for (const input of elements.kindFilterInputs) input.checked = state.filters.kinds.has(input.value);
}

function persistFilters() {
  window.localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify({ statuses: [...state.filters.statuses], kinds: [...state.filters.kinds] }));
}

function renderFilterSummary() {
  const badges = [
    ...[...state.filters.statuses].map((value) => STATUS_LABELS[value]).filter(Boolean),
    ...[...state.filters.kinds].map((value) => KIND_LABELS[value]).filter(Boolean),
  ].map((label) => {
    const badge = document.createElement("span");
    badge.className = "active-filter-badge";
    badge.textContent = label;
    return badge;
  });
  elements.filterSummary.replaceChildren(...badges);
}

function updateFiltersFromControls() {
  state.filters.statuses = new Set(elements.statusFilterInputs.filter(({ checked }) => checked).map(({ value }) => value));
  state.filters.kinds = new Set(elements.kindFilterInputs.filter(({ checked }) => checked).map(({ value }) => value));
  persistFilters();
  renderSidebar();
}

const MODE_HELP = {
  browse: "閲覧モード：ページを通常どおり操作できます。",
  node: "ノード選択：要素にカーソルを合わせ、クリックしてコメントします。Escで終了。",
  region: "範囲指定：対象上をドラッグして範囲を選択します。Escで終了。",
};

const SAFE_ATTRIBUTE_NAMES = ["id", "class", "role", "aria-label", "data-testid", "data-test", "data-qa", "data-cy", "data-id"];
const NON_VISUAL_TAGS = new Set(["script", "style", "noscript", "template", "meta", "link"]);
const SENSITIVE_TEXT_TAGS = new Set([...NON_VISUAL_TAGS, "input", "textarea", "select", "option"]);

function annotations() {
  const value = state.review?.annotations;
  if (Array.isArray(value)) return value;
  return value && typeof value === "object" ? Object.values(value) : [];
}

function events() {
  const value = state.review?.events;
  if (Array.isArray(value)) return value;
  return value && typeof value === "object" ? Object.values(value) : [];
}

function annotationId(annotation) {
  return String(annotation.id ?? annotation.annotation_id ?? "");
}

function targetKind() {
  const kind = String(state.session?.target?.kind ?? "").toLowerCase();
  return kind === "image" || kind.startsWith("image/") ? "image" : "html";
}

function targetUrl() {
  const target = state.session?.target ?? {};
  if (target.url) return target.url;
  return targetUrlForPath(target.entry_path);
}

function repositoryPath(path) {
  if (!path) return "";
  let value = String(path).trim();
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      url.hash = "";
      return url.toString();
    } catch (_error) {
      return value;
    }
  }
  try {
    const url = new URL(value, window.location.origin);
    if (/^https?:/i.test(value) && url.origin === window.location.origin) value = url.pathname;
    else if (value.startsWith("/")) value = url.pathname;
  } catch (_error) {
    // Keep malformed values visible instead of failing the whole reviewer.
  }
  value = value.split(/[?#]/, 1)[0];
  if (value === "/target" || value === "target") value = "";
  else if (value.startsWith("/target/")) value = value.slice(8);
  else if (value.startsWith("target/")) value = value.slice(7);
  value = value.replace(/^\/+|\/+$/g, "");
  return value
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch (_error) {
        return segment;
      }
    })
    .join("/");
}

function targetUrlForPath(path) {
  const normalized = repositoryPath(path);
  if (/^https?:\/\//i.test(normalized)) {
    const url = new URL(normalized);
    return `/live${url.pathname}${url.search}${url.hash}`;
  }
  const encodedPath = normalized
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return encodedPath ? `/target/${encodedPath}` : "/target";
}

function currentPagePath() {
  if (targetKind() === "image") {
    return repositoryPath(state.session?.target?.entry_path);
  }
  try {
    const location = elements.frame.contentWindow.location;
    const liveUrl = state.session?.target?.live_url;
    if (liveUrl) {
      const upstream = new URL(liveUrl);
      const pathname = location.pathname.startsWith("/live") ? location.pathname.slice(5) || "/" : location.pathname;
      return `${upstream.origin}${pathname}${location.search}`;
    }
    return repositoryPath(location.pathname);
  } catch (_error) {
    return repositoryPath(state.session?.target?.entry_path);
  }
}

function pathsMatch(left, right) {
  return repositoryPath(left) === repositoryPath(right);
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      detail = payload.error ?? payload.message ?? detail;
    } catch (_error) {
      // The status text remains useful for non-JSON failures.
    }
    throw new Error(detail);
  }
  return response.json();
}

function applyReview(payload) {
  const nextReview = payload?.review ?? payload ?? { annotations: [], events: [] };
  if (nextReview.revision !== undefined && nextReview.revision === state.review?.revision) {
    state.review = nextReview;
    return;
  }
  state.review = nextReview;
  renderSidebar();
  renderOverlay();
  renderHashWarning();
}

async function loadSession({ reloadTarget = false } = {}) {
  elements.refreshButton.disabled = true;
  state.currentFileState = null;
  state.fileStateRequestId += 1;
  renderHashWarning();
  renderOverlay();
  try {
    const session = await request("/api/session");
    const previousUrl = state.session ? targetUrl() : null;
    state.session = session;
    state.review = session.review ?? { annotations: [], events: [] };
    if (targetKind() === "image") {
      state.currentFileState = {
        path: repositoryPath(session.target.entry_path),
        sha256: session.target.sha256 ?? null,
      };
    }
    configureTarget(reloadTarget || previousUrl !== targetUrl());
    renderSidebar();
    renderHashWarning();
    renderOverlay();
  } catch (error) {
    showToast(`読み込みに失敗しました：${error.message}`, true);
    elements.stageEmpty.hidden = false;
    elements.stageEmpty.textContent = "対象を読み込めませんでした。";
  } finally {
    elements.refreshButton.disabled = false;
  }
}

function configureTarget(forceReload) {
  const target = state.session.target;
  elements.targetPath.textContent = target.entry_path || target.url || "名称不明の対象";
  const imageMode = targetKind() === "image";
  const scriptsAllowed = !imageMode && target.allow_scripts === true;
  elements.trustIndicator.textContent = scriptsAllowed ? "信頼モード（対象JS有効）" : "安全モード（対象JS無効）";
  elements.trustIndicator.classList.toggle("is-trusted", scriptsAllowed);
  const nodeButton = elements.modeButtons.find((button) => button.dataset.mode === "node");
  nodeButton.disabled = imageMode;
  for (const button of elements.viewportButtons) button.disabled = imageMode;
  if (imageMode && state.mode === "node") setMode("browse");

  elements.frame.hidden = imageMode;
  elements.imageWrap.hidden = !imageMode;
  elements.stageEmpty.hidden = true;

  if (imageMode) {
    const url = targetUrl();
    if (forceReload || elements.image.getAttribute("src") !== url) elements.image.src = url;
  } else {
    const url = targetUrl();
    const sandbox = scriptsAllowed ? null : "allow-same-origin allow-forms";
    const sandboxChanged = elements.frame.getAttribute("sandbox") !== sandbox;
    if (sandbox === null) elements.frame.removeAttribute("sandbox");
    else elements.frame.setAttribute("sandbox", sandbox);
    if (forceReload || sandboxChanged || elements.frame.getAttribute("src") !== url) elements.frame.src = url;
    else {
      installFrameListeners();
      refreshCurrentFileState();
    }
  }
}

function setViewport(viewport) {
  if (!elements.viewportButtons.some((button) => button.dataset.viewport === viewport)) return;
  state.viewport = viewport;
  elements.stage.dataset.viewport = viewport;
  for (const button of elements.viewportButtons) {
    const active = button.dataset.viewport === viewport;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  requestAnimationFrame(() => {
    renderOverlay();
    window.setTimeout(renderOverlay, 350);
  });
}

function setMode(mode) {
  if (!state.session) return;
  if (mode === "node" && targetKind() !== "html") {
    showToast("画像ではノード選択を使用できません。", true);
    return;
  }
  state.mode = mode;
  state.drag = null;
  clearTransientOverlay();
  elements.stage.dataset.mode = mode;
  elements.modeHelp.textContent = MODE_HELP[mode];
  for (const button of elements.modeButtons) {
    const active = button.dataset.mode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function renderSidebar() {
  const all = annotations();
  renderFilterSummary();
  const statusCounts = { open: 0, in_progress: 0, addressed: 0, resolved: 0 };
  for (const annotation of all) {
    const status = annotation.status || "open";
    if (status in statusCounts) statusCounts[status] += 1;
  }
  elements.annotationTotal.textContent = String(all.length);
  elements.statusCounts.replaceChildren(
    countItem(`未対応 ${statusCounts.open}`),
    countItem(`AI対応中 ${statusCounts.in_progress}`),
    countItem(`AI対応済み ${statusCounts.addressed}`),
    countItem(`解決済み ${statusCounts.resolved}`),
  );

  const filtered = all.filter((annotation) => state.filters.statuses.has(annotation.status || "open") && state.filters.kinds.has(annotation.kind));

  const existingCards = new Map(
    [...elements.annotationList.querySelectorAll(":scope > .annotation-card")]
      .map((card) => [card.dataset.annotationId, card]),
  );
  let cursor = elements.annotationList.firstElementChild;
  filtered.forEach((annotation) => {
    const id = annotationId(annotation);
    const number = all.indexOf(annotation) + 1;
    const renderKey = annotationCardRenderKey(annotation, number);
    let card = existingCards.get(id);
    existingCards.delete(id);
    if (!card || card.dataset.renderKey !== renderKey) {
      const replacement = createAnnotationCard(annotation, number, renderKey);
      if (card) {
        const wasCursor = card === cursor;
        card.replaceWith(replacement);
        if (wasCursor) cursor = replacement;
      }
      card = replacement;
    }
    if (card === cursor) cursor = cursor.nextElementSibling;
    else elements.annotationList.insertBefore(card, cursor);
  });
  existingCards.forEach((card) => card.remove());
  elements.annotationEmpty.hidden = filtered.length > 0;
  elements.annotationEmpty.textContent = all.length ? "条件に一致する注釈はありません。" : "注釈はまだありません。";
  renderHistory();
}

function countItem(text) {
  const span = document.createElement("span");
  span.textContent = text;
  return span;
}

function annotationCardRenderKey(annotation, number) {
  const messages = Array.isArray(annotation.messages)
    ? annotation.messages
    : Array.isArray(annotation.thread)
      ? annotation.thread
      : [];
  return JSON.stringify([
    number,
    annotation.status,
    annotation.updated_at,
    annotation.comment,
    annotation.page_path,
    annotation.kind,
    annotationWarning(annotation),
    messages.map((message) => [message.id, message.actor, message.at, message.body]),
  ]);
}

function createAnnotationCard(annotation, number, renderKey = annotationCardRenderKey(annotation, number)) {
  const id = annotationId(annotation);
  const status = annotation.status || "open";
  const card = document.createElement("article");
  card.className = "annotation-card";
  card.dataset.status = status;
  card.dataset.annotationId = id;
  card.dataset.renderKey = renderKey;

  const focusButton = document.createElement("button");
  focusButton.type = "button";
  focusButton.className = "card-focus";
  focusButton.addEventListener("click", () => focusAnnotation(annotation));

  const heading = document.createElement("div");
  heading.className = "card-heading";
  const numberBadge = document.createElement("span");
  numberBadge.className = "annotation-number";
  numberBadge.textContent = String(number);
  const statusLabel = document.createElement("span");
  statusLabel.className = `status-label ${status}`;
  statusLabel.textContent = STATUS_LABELS[status] ?? status;
  heading.append(numberBadge, statusLabel);

  const comment = document.createElement("p");
  comment.className = "annotation-comment";
  comment.textContent = annotation.comment ?? "（コメントなし）";

  const meta = document.createElement("div");
  meta.className = "card-meta";
  const kind = document.createElement("span");
  kind.textContent = annotation.kind === "dom" ? "ノード" : "範囲";
  const page = document.createElement("span");
  page.className = "page-path";
  page.title = annotation.page_path ?? "";
  page.textContent = annotation.page_path ?? "/";
  const time = document.createElement("time");
  time.dateTime = annotation.updated_at ?? annotation.created_at ?? "";
  time.textContent = formatTime(annotation.updated_at ?? annotation.created_at);
  meta.append(kind, page, time);
  focusButton.append(heading, comment, meta);
  card.append(focusButton);

  const warning = annotationWarning(annotation);
  if (warning) {
    const warningNode = document.createElement("p");
    warningNode.className = "anchor-warning";
    warningNode.textContent = warning;
    card.append(warningNode);
  }

  const messages = Array.isArray(annotation.messages)
    ? annotation.messages
    : Array.isArray(annotation.thread)
      ? annotation.thread
      : [];
  if (messages.length) {
    const thread = document.createElement("div");
    thread.className = "thread";
    for (const message of messages) thread.append(createMessage(message));
    card.append(thread);
  }

  card.append(createReplyForm(id, status));
  const actions = document.createElement("div");
  actions.className = "card-actions";
  const statusButton = document.createElement("button");
  statusButton.type = "button";
  statusButton.className = "status-button";
  if (status === "open") {
    statusButton.classList.add("waiting");
    statusButton.textContent = "AI対応待ち";
    statusButton.disabled = true;
  } else if (status === "in_progress") {
    statusButton.classList.add("waiting");
    statusButton.textContent = "AIが修正中";
    statusButton.disabled = true;
  } else if (status === "addressed") {
    statusButton.classList.add("resolve");
    statusButton.textContent = "解決にする";
    statusButton.addEventListener("click", () => updateStatus(id, "resolved", statusButton));
  } else if (status === "resolved") {
    statusButton.textContent = "再オープン";
    statusButton.addEventListener("click", () => updateStatus(id, "open", statusButton));
  } else {
    statusButton.textContent = "状態を確認中";
    statusButton.disabled = true;
  }
  actions.append(statusButton);
  card.append(actions);
  return card;
}

function createMessage(message) {
  const item = document.createElement("div");
  item.className = "message";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const actor = message.actor === "ai" ? "AI" : message.actor === "human" ? "人間" : (message.actor ?? "不明");
  meta.textContent = `${actor} · ${formatTime(message.at ?? message.created_at ?? message.timestamp)}`;
  const body = document.createElement("p");
  body.className = "message-body";
  body.textContent = message.body ?? message.comment ?? "";
  item.append(meta, body);
  return item;
}

function createReplyForm(id, previousStatus) {
  const form = document.createElement("form");
  form.className = "reply-form";
  const input = document.createElement("textarea");
  input.className = "reply-input";
  input.rows = 1;
  input.maxLength = 2000;
  input.required = true;
  input.setAttribute("aria-label", "返信内容");
  input.placeholder = "返信を入力";
  input.value = replyDrafts.get(id) ?? "";
  input.addEventListener("input", () => {
    if (input.value) replyDrafts.set(id, input.value);
    else replyDrafts.delete(id);
  });
  const button = document.createElement("button");
  button.className = "reply-button";
  button.type = "submit";
  button.textContent = "返信";
  form.append(input, button);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    button.disabled = true;
    try {
      const review = await request(`/api/annotations/${encodeURIComponent(id)}/messages`, {
        method: "POST",
        body: JSON.stringify({ body, actor: "human" }),
      });
      replyDrafts.delete(id);
      applyReview(review);
      const updated = annotations().find((annotation) => annotationId(annotation) === id);
      const reopened = previousStatus !== "open" && updated?.status === "open";
      if (reopened) window.dispatchEvent(new CustomEvent("visual-review:annotation-reopened", { detail: { annotationId: id, reason: "human-reply" } }));
      showToast(reopened ? "返信を追加し、再対応のため未対応に戻しました。" : "返信を追加しました。AIの対応を待ちます。");
    } catch (error) {
      showToast(`返信に失敗しました：${error.message}`, true);
      button.disabled = false;
    }
  });
  return form;
}

async function updateStatus(id, status, button) {
  button.disabled = true;
  try {
    const review = await request(`/api/annotations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status, actor: "human" }),
    });
    applyReview(review);
    if (status === "open") window.dispatchEvent(new CustomEvent("visual-review:annotation-reopened", { detail: { annotationId: id, reason: "manual-reopen" } }));
    showToast(status === "resolved" ? "注釈を解決済みにしました。" : "注釈を再オープンしました。");
  } catch (error) {
    showToast(`状態の更新に失敗しました：${error.message}`, true);
    button.disabled = false;
  }
}

function annotationWarning(annotation) {
  if ((annotation.status ?? "open") !== "open") return "";
  if (isAnnotationStale(annotation)) {
    return "参考：注釈作成後に対象が更新されています。必要な場合だけ位置を確認してください。";
  }
  if (annotation.kind === "dom" && pathsMatch(annotation.page_path, currentPagePath())) {
    try {
      if (!resolveAnchor(annotation.anchor)) return "対象ノードを現在のページで特定できません。";
    } catch (_error) {
      return "対象ノードを現在のページで特定できません。";
    }
  }
  return "";
}

function isAnnotationStale(annotation) {
  const fileState = state.currentFileState;
  return Boolean(
    (annotation.status ?? "open") === "open"
    && fileState?.sha256
    && annotation.source_hash
    && pathsMatch(annotation.page_path, fileState.path)
    && annotation.source_hash !== fileState.sha256,
  );
}

function renderHashWarning() {
  const stale = annotations().filter(isAnnotationStale);
  elements.hashWarning.hidden = stale.length === 0;
  elements.hashWarning.textContent = stale.length
    ? `参考：未対応の注釈${stale.length}件は作成後に対象が更新されています。必要な場合だけ位置を確認してください。`
    : "";
}

function sortedHistoryEvents() {
  return [...events()].sort((left, right) => (
    eventTime(right) - eventTime(left)
    || Number(right.revision ?? 0) - Number(left.revision ?? 0)
  ));
}

function renderHistory() {
  const sorted = sortedHistoryEvents();
  const signature = `${sorted.length}:${sorted[0]?.id ?? ""}:${sorted[0]?.revision ?? ""}`;
  if (signature !== state.historySignature) {
    state.historySignature = signature;
    state.historyRenderLimit = HISTORY_PAGE_SIZE;
  }
  elements.historyCount.textContent = String(sorted.length);
  if (elements.historyList.hidden) {
    elements.historyList.replaceChildren();
    elements.historyLoadMore.hidden = true;
    return;
  }

  const visible = sorted.slice(0, state.historyRenderLimit);
  const fragment = document.createDocumentFragment();
  for (const event of visible) {
    const item = document.createElement("li");
    const description = document.createElement("span");
    description.textContent = describeEvent(event);
    const time = document.createElement("time");
    time.className = "history-time";
    time.dateTime = event.at ?? event.created_at ?? event.timestamp ?? "";
    time.textContent = formatTime(event.at ?? event.created_at ?? event.timestamp);
    item.append(description, time);
    fragment.append(item);
  }
  elements.historyList.replaceChildren(fragment);
  const remaining = sorted.length - visible.length;
  elements.historyLoadMore.hidden = remaining <= 0;
  elements.historyLoadMore.textContent = `さらに${Math.min(HISTORY_PAGE_SIZE, remaining)}件読み込む`;
}

function loadMoreHistory() {
  state.historyRenderLimit += HISTORY_PAGE_SIZE;
  renderHistory();
}

function eventTime(event) {
  const value = Date.parse(event.at ?? event.created_at ?? event.timestamp ?? "");
  return Number.isNaN(value) ? 0 : value;
}

function describeEvent(event) {
  const actor = event.actor === "ai" ? "AI" : event.actor === "human" ? "人間" : "システム";
  const details = event.details && typeof event.details === "object" ? event.details : {};
  const type = event.type ?? event.action ?? "";
  const from = details.from ?? event.from_status;
  const to = details.to ?? event.to_status ?? event.status;
  if (from || to) {
    const fromLabel = STATUS_LABELS[from] ?? from ?? "不明";
    const toLabel = STATUS_LABELS[to] ?? to ?? "不明";
    return `${actor}が状態を「${fromLabel}」から「${toLabel}」に変更しました`;
  }
  const body = details.body ?? event.body;
  if (body || /message|reply/i.test(type)) return body ? `${actor}が返信しました：${body}` : `${actor}が返信しました`;
  const comment = details.comment ?? event.comment;
  if (comment || /annotat.*creat|creat.*annotat/i.test(type)) {
    return comment ? `${actor}が注釈を作成しました：${comment}` : `${actor}が注釈を作成しました`;
  }
  return `${actor}：${type || "レビューを更新しました"}`;
}

function formatTime(value) {
  if (!value) return "日時不明";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function handleFrameLoad() {
  installFrameListeners();
  refreshCurrentFileState();
}

async function refreshCurrentFileState() {
  if (!state.session) return;
  if (targetKind() === "image") {
    state.currentFileState = {
      path: repositoryPath(state.session.target.entry_path),
      sha256: state.session.target.sha256 ?? null,
    };
    renderSidebar();
    renderHashWarning();
    renderOverlay();
    return;
  }

  const requestedPath = currentPagePath();
  const requestId = ++state.fileStateRequestId;
  state.currentFileState = null;
  renderSidebar();
  renderHashWarning();
  renderOverlay();
  try {
    const fileState = await request(`/api/file-state?path=${encodeURIComponent(requestedPath)}`);
    if (requestId !== state.fileStateRequestId || !pathsMatch(currentPagePath(), requestedPath)) return;
    state.currentFileState = {
      path: repositoryPath(fileState.path ?? requestedPath),
      sha256: fileState.sha256 ?? null,
    };
  } catch (error) {
    if (requestId !== state.fileStateRequestId || !pathsMatch(currentPagePath(), requestedPath)) return;
    state.currentFileState = null;
    showToast(`現在のファイル状態を取得できませんでした。古さの判定を保留します：${error.message}`, true);
  }
  renderSidebar();
  renderHashWarning();
  renderOverlay();
}

function installFrameListeners() {
  if (targetKind() !== "html") return;
  try {
    const doc = elements.frame.contentDocument;
    const win = elements.frame.contentWindow;
    if (!doc || !win || state.boundDocuments.has(doc)) return;
    state.boundDocuments.add(doc);
    doc.addEventListener("pointerover", handleFramePointerOver, true);
    doc.addEventListener("pointerout", handleFramePointerOut, true);
    doc.addEventListener("pointerdown", handleFramePointerDown, true);
    doc.addEventListener("pointermove", handleFramePointerMove, true);
    doc.addEventListener("pointerup", handleFramePointerUp, true);
    doc.addEventListener("pointercancel", cancelDrag, true);
    doc.addEventListener("click", handleFrameClick, true);
    doc.addEventListener("keydown", handleFrameKeydown, true);
    win.addEventListener("scroll", renderOverlay, { passive: true });
    win.addEventListener("resize", renderOverlay, { passive: true });
    renderOverlay();
    if (state.pendingFocusId) {
      const annotation = annotations().find((item) => annotationId(item) === state.pendingFocusId);
      state.pendingFocusId = null;
      if (annotation) requestAnimationFrame(() => focusAnnotation(annotation));
    }
  } catch (error) {
    showToast(`対象ページを操作できません：${error.message}`, true);
  }
}

function handleFrameKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    cancelDrag();
    setMode("browse");
    return;
  }
  const tagName = event.target?.tagName?.toLowerCase();
  const typing = ["input", "textarea", "select"].includes(tagName) || event.target?.isContentEditable;
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
  const mode = { v: "browse", n: "node", r: "region" }[event.key.toLowerCase()];
  if (mode) {
    event.preventDefault();
    setMode(mode);
  }
}

function handleFramePointerOver(event) {
  if (state.mode !== "node" || !(event.target instanceof elements.frame.contentWindow.Element)) return;
  renderHoverOutline(event.target);
}

function handleFramePointerOut(event) {
  if (state.mode !== "node") return;
  if (event.relatedTarget && event.target.contains?.(event.relatedTarget)) return;
  clearTransientOverlay("hover-outline");
}

function isRestrictedNode(element) {
  const tag = element.tagName.toLowerCase();
  return NON_VISUAL_TAGS.has(tag) || (tag === "input" && element.getAttribute("type")?.toLowerCase() === "hidden");
}

function queueAnnotation(kind, anchor, summary) {
  const pagePath = currentPagePath();
  const fileState = state.currentFileState;
  if (!fileState?.sha256 || !pathsMatch(fileState.path, pagePath)) {
    state.pendingAnnotation = null;
    clearTransientOverlay("draft-region");
    showToast("対象ファイルの最新状態を確認できません。再読み込み後にもう一度選択してください。", true);
    refreshCurrentFileState();
    return false;
  }
  state.pendingAnnotation = {
    kind,
    page_path: pagePath,
    source_hash: fileState.sha256,
    anchor,
  };
  openCommentDialog(summary);
  return true;
}

function handleFrameClick(event) {
  if (state.mode === "browse") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (state.mode !== "node") return;
  const win = elements.frame.contentWindow;
  if (!(event.target instanceof win.Element)) return;
  if (isRestrictedNode(event.target)) {
    showToast("この非表示・非描画要素には注釈を付けられません。表示されている要素を選択してください。", true);
    return;
  }
  queueAnnotation(
    "dom",
    createDomAnchor(event.target),
    `ノード：${event.target.tagName.toLowerCase()} ${safeTextExcerpt(event.target, 80)}`,
  );
}

function handleFramePointerDown(event) {
  if (state.mode !== "region") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const win = elements.frame.contentWindow;
  state.drag = {
    type: "html",
    pointerId: event.pointerId,
    startX: event.pageX,
    startY: event.pageY,
    endX: event.pageX,
    endY: event.pageY,
    nearest: event.target instanceof win.Element ? event.target : null,
  };
  renderDraftRegion();
}

function handleFramePointerMove(event) {
  if (state.mode !== "region" || state.drag?.type !== "html") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  state.drag.endX = event.pageX;
  state.drag.endY = event.pageY;
  renderDraftRegion();
}

function handleFramePointerUp(event) {
  if (state.mode !== "region" || state.drag?.type !== "html") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  state.drag.endX = event.pageX;
  state.drag.endY = event.pageY;
  completeHtmlRegion();
}

function completeHtmlRegion() {
  const drag = state.drag;
  state.drag = null;
  if (!drag || Math.abs(drag.endX - drag.startX) < 5 || Math.abs(drag.endY - drag.startY) < 5) {
    clearTransientOverlay("draft-region");
    showToast("範囲が小さすぎます。もう一度ドラッグしてください。", true);
    return;
  }
  const doc = elements.frame.contentDocument;
  const win = elements.frame.contentWindow;
  const dimensions = documentDimensions(doc);
  const x = Math.min(drag.startX, drag.endX);
  const y = Math.min(drag.startY, drag.endY);
  const width = Math.abs(drag.endX - drag.startX);
  const height = Math.abs(drag.endY - drag.startY);
  const nearest = drag.nearest ? createLocator(drag.nearest) : null;
  queueAnnotation(
    "region",
    {
      space: "document",
      bounds: normalizeBounds(x, y, width, height, dimensions.width, dimensions.height),
      document: dimensions,
      viewport: {
        width: win.innerWidth,
        height: win.innerHeight,
        scroll_x: win.scrollX,
        scroll_y: win.scrollY,
      },
      viewport_mode: state.viewport,
      nearest,
    },
    `範囲：${Math.round(width)} × ${Math.round(height)} px`,
  );
}

function handleImagePointerDown(event) {
  if (state.mode !== "region" || targetKind() !== "image") return;
  event.preventDefault();
  const point = imagePoint(event.clientX, event.clientY);
  state.drag = { type: "image", pointerId: event.pointerId, startX: point.x, startY: point.y, endX: point.x, endY: point.y };
  try {
    elements.image.setPointerCapture?.(event.pointerId);
  } catch (_error) {
    // Synthetic or already-cancelled pointers can have no active capture.
  }
  renderDraftRegion();
}

function handleImagePointerMove(event) {
  if (state.drag?.type !== "image" || event.pointerId !== state.drag.pointerId) return;
  event.preventDefault();
  const point = imagePoint(event.clientX, event.clientY);
  state.drag.endX = point.x;
  state.drag.endY = point.y;
  renderDraftRegion();
}

function handleImagePointerUp(event) {
  if (state.drag?.type !== "image" || event.pointerId !== state.drag.pointerId) return;
  event.preventDefault();
  const point = imagePoint(event.clientX, event.clientY);
  state.drag.endX = point.x;
  state.drag.endY = point.y;
  const drag = state.drag;
  state.drag = null;
  if (Math.abs(drag.endX - drag.startX) < 5 || Math.abs(drag.endY - drag.startY) < 5) {
    clearTransientOverlay("draft-region");
    showToast("範囲が小さすぎます。もう一度ドラッグしてください。", true);
    return;
  }
  const rect = elements.image.getBoundingClientRect();
  const x = Math.min(drag.startX, drag.endX);
  const y = Math.min(drag.startY, drag.endY);
  const width = Math.abs(drag.endX - drag.startX);
  const height = Math.abs(drag.endY - drag.startY);
  queueAnnotation(
    "region",
    {
      space: "image",
      bounds: normalizeBounds(x, y, width, height, rect.width, rect.height),
      natural: { width: elements.image.naturalWidth, height: elements.image.naturalHeight },
    },
    `画像範囲：${Math.round(width)} × ${Math.round(height)} px`,
  );
}

function imagePoint(clientX, clientY) {
  const rect = elements.image.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(rect.width, clientX - rect.left)),
    y: Math.max(0, Math.min(rect.height, clientY - rect.top)),
  };
}

function cancelDrag() {
  state.drag = null;
  clearTransientOverlay("draft-region");
}

function frameworkSourceHint(element) {
  const doc = element.ownerDocument;
  const win = doc.defaultView;
  let current = element;
  while (current) {
    const vue = current.__vueParentComponent;
    if (vue) {
      const type = vue.type ?? {};
      return {
        framework: doc.querySelector("#__nuxt") ? "nuxt" : "vue",
        component: type.name ?? type.__name ?? "AnonymousComponent",
        file: type.__file ?? "",
      };
    }
    const reactKey = Object.keys(current).find((key) => key.startsWith("__reactFiber$"));
    if (reactKey) {
      let fiber = current[reactKey];
      while (fiber) {
        const type = fiber.type;
        const component = typeof type === "function" || typeof type === "object"
          ? type?.displayName ?? type?.name
          : "";
        const source = fiber._debugSource;
        if (component || source?.fileName) {
          return {
            framework: doc.querySelector("#__next") ? "next" : "react",
            component: component ?? "AnonymousComponent",
            file: source?.fileName ?? "",
          };
        }
        fiber = fiber.return;
      }
    }
    current = current.parentElement;
  }
  if (win.ng?.getOwningComponent) {
    const component = win.ng.getOwningComponent(element);
    if (component) return { framework: "angular", component: component.constructor?.name ?? "AnonymousComponent", file: "" };
  }
  if (doc.querySelector("[data-svelte-h]")) return { framework: "svelte", component: "", file: "" };
  const generator = doc.querySelector('meta[name="generator"]')?.content ?? "";
  if (/wordpress/i.test(generator) || doc.querySelector('link[href*="/wp-content/"], script[src*="/wp-includes/"]') || doc.body?.classList.contains("wp-site-blocks") || doc.body?.className.includes("wordpress")) {
    return { framework: "wordpress", component: doc.body?.className.split(/\s+/).slice(0, 8).join(" ") ?? "", file: "" };
  }
  return null;
}

function createDomAnchor(element) {
  const doc = element.ownerDocument;
  const win = doc.defaultView;
  const rect = element.getBoundingClientRect();
  const dimensions = documentDimensions(doc);
  const attributes = {};
  for (const name of SAFE_ATTRIBUTE_NAMES) {
    const value = element.getAttribute(name);
    if (value !== null) attributes[name] = value.slice(0, 300);
  }
  const anchor = {
    ...createLocator(element),
    attributes,
    rect: normalizeBounds(rect.left + win.scrollX, rect.top + win.scrollY, rect.width, rect.height, dimensions.width, dimensions.height),
    document: dimensions,
    viewport: {
      width: win.innerWidth,
      height: win.innerHeight,
      scroll_x: win.scrollX,
      scroll_y: win.scrollY,
    },
    viewport_mode: state.viewport,
  };
  const excerpt = safeTextExcerpt(element, 240);
  if (excerpt) anchor.text_excerpt = excerpt;
  const sourceHint = frameworkSourceHint(element);
  if (sourceHint) anchor.source_hint = sourceHint;
  return anchor;
}

function createLocator(element) {
  return {
    selector: cssSelector(element),
    xpath: xpathFor(element),
    tag: element.tagName.toLowerCase(),
  };
}

function cssSelector(element) {
  const doc = element.ownerDocument;
  if (element.id) {
    const candidate = `#${CSS.escape(element.id)}`;
    if (isUniqueSelector(doc, candidate, element)) return candidate;
  }
  for (const name of ["data-testid", "data-test", "data-qa", "data-cy", "data-id"]) {
    const value = element.getAttribute(name);
    if (!value) continue;
    const candidate = `[${name}="${CSS.escape(value)}"]`;
    if (isUniqueSelector(doc, candidate, element)) return candidate;
  }
  const parts = [];
  let node = element;
  while (node && node.nodeType === Node.ELEMENT_NODE) {
    const tag = node.tagName.toLowerCase();
    if (tag === "html") {
      parts.unshift("html");
      break;
    }
    let part = tag;
    const siblings = node.parentElement ? [...node.parentElement.children].filter((sibling) => sibling.tagName === node.tagName) : [];
    if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    parts.unshift(part);
    const candidate = parts.join(" > ");
    if (isUniqueSelector(doc, candidate, element)) return candidate;
    node = node.parentElement;
  }
  return parts.join(" > ");
}

function isUniqueSelector(doc, selector, element) {
  try {
    const matches = doc.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === element;
  } catch (_error) {
    return false;
  }
}

function xpathFor(element) {
  if (element.id) return `//*[@id=${xpathLiteral(element.id)}]`;
  const parts = [];
  let node = element;
  while (node?.nodeType === Node.ELEMENT_NODE) {
    const tag = node.tagName.toLowerCase();
    let index = 1;
    let sibling = node.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === node.tagName) index += 1;
      sibling = sibling.previousElementSibling;
    }
    parts.unshift(`${tag}[${index}]`);
    node = node.parentElement;
  }
  return `/${parts.join("/")}`;
}

function xpathLiteral(value) {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat('${value.replaceAll("'", "',\"'\",'")}')`;
}

function resolveAnchor(anchor) {
  if (!anchor || targetKind() !== "html") return null;
  const doc = elements.frame.contentDocument;
  if (!doc) return null;
  if (anchor.selector) {
    try {
      const matches = doc.querySelectorAll(anchor.selector);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) return null;
    } catch (_error) {
      // Fall through to XPath when a saved selector is no longer valid.
    }
  }
  if (anchor.xpath) {
    try {
      return doc.evaluate(anchor.xpath, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    } catch (_error) {
      return null;
    }
  }
  return null;
}

function controlledOpener(element) {
  const id = element.id;
  if (!id) return null;
  const doc = element.ownerDocument;
  return [...doc.querySelectorAll("[aria-controls], [data-open-layer]")].find((candidate) => (
    candidate.getAttribute("aria-controls") === id
    || candidate.getAttribute("data-open-layer") === id
  )) ?? null;
}

function dismissTransientContext(context) {
  const closeControl = context.querySelector("[data-close-layer], [data-dialog-close], [aria-label*='閉じる']");
  if (closeControl) closeControl.click();
  if (context.tagName === "DIALOG" && context.open) context.close();
  if (context.hasAttribute("popover")) {
    try {
      if (context.matches(":popover-open")) context.hidePopover();
    } catch (_error) {
      // Continue with the visibility attribute fallback.
    }
  }
  if (context.tagName === "DETAILS") context.open = false;
  if (!context.hidden && (context.matches("[role='dialog'], [aria-modal='true']") || state.revealedContexts.has(context))) {
    context.hidden = true;
  }
  if (context.hasAttribute("aria-hidden")) context.setAttribute("aria-hidden", "true");
  state.revealedContexts.delete(context);
}

function dismissUnrelatedTransientContexts(node) {
  const doc = node?.ownerDocument;
  if (!doc) return;
  const contexts = new Set(state.revealedContexts);
  for (const context of doc.querySelectorAll("dialog[open], [role='dialog']:not([hidden]), [aria-modal='true']:not([hidden])")) {
    if (context.getAttribute("aria-hidden") !== "true") contexts.add(context);
  }
  try {
    for (const context of doc.querySelectorAll("[popover]:popover-open")) contexts.add(context);
  } catch (_error) {
    // Popover selectors are unavailable in older browsers.
  }
  for (const context of contexts) {
    if (!context.isConnected) {
      state.revealedContexts.delete(context);
    } else if (!context.contains(node)) {
      dismissTransientContext(context);
    }
  }
}

function revealAnchorContext(node) {
  const doc = node?.ownerDocument;
  const win = doc?.defaultView;
  if (!doc || !win) return false;
  const contexts = [];
  let current = node.parentElement;
  while (current && current !== doc.body) {
    const controlled = Boolean(current.id && controlledOpener(current));
    const collapsedDetails = current.tagName === "DETAILS" && !current.open;
    const closedDialog = current.tagName === "DIALOG" && !current.open;
    const closedPopover = current.hasAttribute("popover") && !current.matches(":popover-open");
    const hidden = current.hidden || current.getAttribute("aria-hidden") === "true";
    const visuallyHiddenControlled = controlled && win.getComputedStyle(current).display === "none";
    if (collapsedDetails || closedDialog || closedPopover || hidden || visuallyHiddenControlled) contexts.push(current);
    current = current.parentElement;
  }

  let revealed = false;
  for (const context of contexts.reverse()) {
    if (context.tagName === "DETAILS" && !context.open) {
      const summary = context.querySelector(":scope > summary");
      if (summary) summary.click();
      else context.open = true;
      revealed = true;
      continue;
    }

    const opener = controlledOpener(context);
    if (opener) {
      opener.click();
      revealed = true;
    }
    if (context.tagName === "DIALOG" && !context.open) {
      try {
        context.showModal();
      } catch (_error) {
        context.setAttribute("open", "");
      }
      revealed = true;
    } else if (context.hasAttribute("popover") && !context.matches(":popover-open")) {
      try {
        context.showPopover();
      } catch (_error) {
        // Fall back to persisted visibility attributes below.
      }
      revealed = true;
    }
    if (context.hidden) {
      context.hidden = false;
      revealed = true;
    }
    if (context.getAttribute("aria-hidden") === "true") {
      context.setAttribute("aria-hidden", "false");
      revealed = true;
    }
  }
  if (revealed) contexts.forEach((context) => state.revealedContexts.add(context));
  return revealed;
}

function documentDimensions(doc) {
  const root = doc.documentElement;
  const body = doc.body;
  return {
    width: Math.max(root?.scrollWidth ?? 0, root?.offsetWidth ?? 0, body?.scrollWidth ?? 0, body?.offsetWidth ?? 0, 1),
    height: Math.max(root?.scrollHeight ?? 0, root?.offsetHeight ?? 0, body?.scrollHeight ?? 0, body?.offsetHeight ?? 0, 1),
  };
}

function normalizeBounds(x, y, width, height, totalWidth, totalHeight) {
  return {
    x: x / Math.max(totalWidth, 1),
    y: y / Math.max(totalHeight, 1),
    width: width / Math.max(totalWidth, 1),
    height: height / Math.max(totalHeight, 1),
  };
}

function compactText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function safeTextExcerpt(element, length) {
  const tag = element.tagName.toLowerCase();
  if (SENSITIVE_TEXT_TAGS.has(tag)) return "";
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const parts = [];
  let totalLength = 0;
  let node = walker.nextNode();
  while (node && totalLength < length) {
    const parent = node.parentElement;
    const sensitiveAncestor = parent?.closest("script, style, noscript, template, meta, link, input, textarea, select, option");
    if (!sensitiveAncestor) {
      const text = compactText(node.nodeValue);
      if (text) {
        parts.push(text);
        totalLength += text.length + 1;
      }
    }
    node = walker.nextNode();
  }
  return parts.join(" ").slice(0, length);
}

function renderOverlay() {
  const transient = [...elements.overlay.querySelectorAll(".hover-outline, .draft-region")];
  elements.overlay.replaceChildren();
  const all = annotations();
  all.forEach((annotation, index) => {
    if (!pathsMatch(annotation.page_path, currentPagePath())) return;
    const box = annotationBox(annotation);
    if (!box) {
      if (annotation.kind === "dom") renderStalePin(annotation, index + 1);
      return;
    }
    elements.overlay.append(createMark(annotation, index + 1, box));
  });
  elements.overlay.append(...transient);
}

function annotationBox(annotation) {
  if (targetKind() === "image") return imageAnnotationBox(annotation);
  try {
    if (annotation.kind === "dom") {
      const node = resolveAnchor(annotation.anchor);
      return node ? frameClientBox(node.getBoundingClientRect()) : null;
    }
    const bounds = annotation.anchor?.bounds ?? annotation.anchor?.rect;
    if (!bounds) return null;
    const doc = elements.frame.contentDocument;
    const win = elements.frame.contentWindow;
    const dimensions = documentDimensions(doc);
    return frameDocumentBox({
      x: bounds.x * dimensions.width,
      y: bounds.y * dimensions.height,
      width: bounds.width * dimensions.width,
      height: bounds.height * dimensions.height,
    }, win);
  } catch (_error) {
    return null;
  }
}

function frameClientBox(rect) {
  const stageRect = elements.stage.getBoundingClientRect();
  const frameRect = elements.frame.getBoundingClientRect();
  return {
    left: frameRect.left - stageRect.left + rect.left,
    top: frameRect.top - stageRect.top + rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function frameDocumentBox(rect, win) {
  return frameClientBox({
    left: rect.x - win.scrollX,
    top: rect.y - win.scrollY,
    width: rect.width,
    height: rect.height,
  });
}

function imageAnnotationBox(annotation) {
  const bounds = annotation.anchor?.bounds ?? annotation.anchor?.rect;
  if (annotation.kind !== "region" || !bounds || !elements.image.complete) return null;
  const stageRect = elements.stage.getBoundingClientRect();
  const imageRect = elements.image.getBoundingClientRect();
  return {
    left: imageRect.left - stageRect.left + bounds.x * imageRect.width,
    top: imageRect.top - stageRect.top + bounds.y * imageRect.height,
    width: bounds.width * imageRect.width,
    height: bounds.height * imageRect.height,
  };
}

function createMark(annotation, number, box) {
  const mark = document.createElement("div");
  mark.className = "review-mark";
  mark.classList.toggle("is-resolved", annotation.status === "resolved");
  mark.classList.toggle("is-highlighted", annotationId(annotation) === state.highlightedId);
  mark.classList.toggle("is-stale", isAnnotationStale(annotation));
  setBoxStyle(mark, box);
  const pin = document.createElement("span");
  pin.className = "review-pin";
  pin.textContent = String(number);
  mark.append(pin);
  return mark;
}

function renderStalePin(annotation, number) {
  const fallback = annotation.anchor?.rect;
  const doc = elements.frame.contentDocument;
  const win = elements.frame.contentWindow;
  if (!fallback || !doc || !win) return;
  const dimensions = documentDimensions(doc);
  const box = frameDocumentBox({
    x: fallback.x * dimensions.width,
    y: fallback.y * dimensions.height,
    width: Math.max(20, fallback.width * dimensions.width),
    height: Math.max(20, fallback.height * dimensions.height),
  }, win);
  const mark = createMark(annotation, number, box);
  mark.classList.add("is-stale");
  elements.overlay.append(mark);
}

function setBoxStyle(node, box) {
  node.style.left = `${box.left}px`;
  node.style.top = `${box.top}px`;
  node.style.width = `${Math.max(2, box.width)}px`;
  node.style.height = `${Math.max(2, box.height)}px`;
}

function renderHoverOutline(target) {
  clearTransientOverlay("hover-outline");
  const outline = document.createElement("div");
  outline.className = "hover-outline";
  setBoxStyle(outline, frameClientBox(target.getBoundingClientRect()));
  elements.overlay.append(outline);
}

function renderDraftRegion() {
  clearTransientOverlay("draft-region");
  const drag = state.drag;
  if (!drag) return;
  let box;
  if (drag.type === "html") {
    box = frameDocumentBox({
      x: Math.min(drag.startX, drag.endX),
      y: Math.min(drag.startY, drag.endY),
      width: Math.abs(drag.endX - drag.startX),
      height: Math.abs(drag.endY - drag.startY),
    }, elements.frame.contentWindow);
  } else {
    const stageRect = elements.stage.getBoundingClientRect();
    const imageRect = elements.image.getBoundingClientRect();
    box = {
      left: imageRect.left - stageRect.left + Math.min(drag.startX, drag.endX),
      top: imageRect.top - stageRect.top + Math.min(drag.startY, drag.endY),
      width: Math.abs(drag.endX - drag.startX),
      height: Math.abs(drag.endY - drag.startY),
    };
  }
  const draft = document.createElement("div");
  draft.className = "draft-region";
  setBoxStyle(draft, box);
  elements.overlay.append(draft);
}

function clearTransientOverlay(className) {
  const selector = className ? `.${className}` : ".hover-outline, .draft-region";
  elements.overlay.querySelectorAll(selector).forEach((node) => node.remove());
}

function openCommentDialog(summary) {
  elements.dialogTitle.textContent = state.pendingAnnotation?.kind === "dom" ? "ノードにコメント" : "範囲にコメント";
  elements.selectionSummary.textContent = summary;
  elements.commentInput.value = "";
  elements.dialog.showModal();
  requestAnimationFrame(() => elements.commentInput.focus());
}

async function saveAnnotation() {
  const pending = state.pendingAnnotation;
  const comment = elements.commentInput.value.trim();
  if (!pending || !comment) return;
  const fileState = state.currentFileState;
  const observedStateStillCurrent = Boolean(
    fileState?.sha256
    && pathsMatch(fileState.path, pending.page_path)
    && pending.source_hash === fileState.sha256,
  );
  if (!observedStateStillCurrent) {
    cancelComment();
    showToast("対象ファイルの状態が変わりました。再読み込み後に対象を選び直してください。", true);
    refreshCurrentFileState();
    return;
  }
  elements.commentSubmit.disabled = true;
  try {
    const review = await request("/api/annotations", {
      method: "POST",
      body: JSON.stringify({ ...pending, comment, actor: "human" }),
    });
    state.pendingAnnotation = null;
    elements.dialog.close();
    applyReview(review);
    setMode("browse");
    window.dispatchEvent(new CustomEvent("visual-review:annotation-created"));
    showToast("注釈を保存しました。");
  } catch (error) {
    showToast(`注釈の保存に失敗しました：${error.message}`, true);
  } finally {
    elements.commentSubmit.disabled = false;
  }
}

function cancelComment() {
  state.pendingAnnotation = null;
  if (elements.dialog.open) elements.dialog.close();
  clearTransientOverlay();
}

function focusAnnotation(annotation) {
  const id = annotationId(annotation);
  state.highlightedId = id;
  if (!pathsMatch(annotation.page_path, currentPagePath()) && targetKind() === "html") {
    state.pendingFocusId = id;
    state.currentFileState = null;
    state.fileStateRequestId += 1;
    renderHashWarning();
    elements.frame.src = targetUrlForPath(annotation.page_path);
    return;
  }
  if (targetKind() === "html") {
    try {
      if (annotation.kind === "dom") {
        const node = resolveAnchor(annotation.anchor);
        if (!node) {
          showToast("現在のページでは対象を特定できません。", true);
        } else {
          dismissUnrelatedTransientContexts(node);
          const revealed = revealAnchorContext(node);
          requestAnimationFrame(() => {
            node.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
            renderOverlay();
            window.setTimeout(renderOverlay, 350);
          });
          if (revealed) showToast("注釈を作成したモーダル・メニューを再表示しました。");
        }
      } else {
        const bounds = annotation.anchor?.bounds;
        const doc = elements.frame.contentDocument;
        const win = elements.frame.contentWindow;
        if (bounds && doc && win) {
          const dimensions = documentDimensions(doc);
          win.scrollTo({
            left: Math.max(0, bounds.x * dimensions.width - win.innerWidth / 2),
            top: Math.max(0, bounds.y * dimensions.height - win.innerHeight / 2),
            behavior: "smooth",
          });
        }
      }
    } catch (_error) {
      showToast("現在のページでは対象を特定できません。", true);
    }
  } else {
    const bounds = annotation.anchor?.bounds;
    if (bounds) {
      elements.imageWrap.scrollTo({
        left: Math.max(0, bounds.x * elements.image.offsetWidth - elements.imageWrap.clientWidth / 2),
        top: Math.max(0, bounds.y * elements.image.offsetHeight - elements.imageWrap.clientHeight / 2),
        behavior: "smooth",
      });
    }
  }
  renderOverlay();
  window.setTimeout(renderOverlay, 350);
}

function showToast(message, error = false) {
  window.clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("is-error", error);
  state.toastTimer = window.setTimeout(() => {
    elements.toast.textContent = "";
    elements.toast.classList.remove("is-error");
  }, 4200);
}

function isTypingTarget(target) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable;
}

elements.modeButtons.forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
elements.viewportButtons.forEach((button) => button.addEventListener("click", () => setViewport(button.dataset.viewport)));
elements.refreshButton.addEventListener("click", () => loadSession({ reloadTarget: true }));
window.addEventListener("visual-review:session-refreshed", (event) => {
  if (document.activeElement?.classList.contains("reply-input")) return;
  if (event instanceof CustomEvent && event.detail?.review) applyReview(event.detail);
});
elements.filterOpenButton.addEventListener("click", () => elements.filterDialog.showModal());
elements.filterCloseButton.addEventListener("click", () => elements.filterDialog.close());
for (const input of [...elements.statusFilterInputs, ...elements.kindFilterInputs]) input.addEventListener("change", updateFiltersFromControls);
elements.filterResetButton.addEventListener("click", () => {
  state.filters.statuses = new Set(DEFAULT_STATUS_FILTERS);
  state.filters.kinds = new Set(DEFAULT_KIND_FILTERS);
  syncFilterControls();
  persistFilters();
  renderSidebar();
});
elements.historyToggle.addEventListener("click", () => {
  const expanded = elements.historyToggle.getAttribute("aria-expanded") !== "true";
  elements.historyToggle.setAttribute("aria-expanded", String(expanded));
  elements.historyList.hidden = !expanded;
  if (expanded) state.historyRenderLimit = HISTORY_PAGE_SIZE;
  renderHistory();
});
elements.historyLoadMore.addEventListener("click", loadMoreHistory);
if ("IntersectionObserver" in window) {
  const historyObserver = new IntersectionObserver((entries) => {
    if (entries.some(({ isIntersecting }) => isIntersecting) && !elements.historyLoadMore.hidden) loadMoreHistory();
  }, { rootMargin: "160px" });
  historyObserver.observe(elements.historyLoadMore);
}
elements.commentForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveAnnotation();
});
elements.dialogCancelButtons.forEach((button) => button.addEventListener("click", cancelComment));
elements.dialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  cancelComment();
  setMode("browse");
});
elements.frame.addEventListener("load", handleFrameLoad);
elements.image.addEventListener("load", renderOverlay);
elements.image.addEventListener("error", () => showToast("対象画像を読み込めませんでした。", true));
elements.image.addEventListener("pointerdown", handleImagePointerDown);
elements.image.addEventListener("pointermove", handleImagePointerMove);
elements.image.addEventListener("pointerup", handleImagePointerUp);
elements.image.addEventListener("pointercancel", cancelDrag);
elements.imageWrap.addEventListener("scroll", renderOverlay, { passive: true });
window.addEventListener("resize", renderOverlay, { passive: true });
document.addEventListener("keydown", (event) => {
  const modalOpen = elements.dialog.open || elements.filterDialog.open || document.querySelector("#ai-settings-dialog")?.open;
  if (event.key === "Escape" && !modalOpen) {
    cancelDrag();
    setMode("browse");
    return;
  }
  if (isTypingTarget(event.target) || modalOpen || event.metaKey || event.ctrlKey || event.altKey) return;
  const mode = { v: "browse", n: "node", r: "region" }[event.key.toLowerCase()];
  if (mode) {
    event.preventDefault();
    setMode(mode);
  }
});

if (window.ResizeObserver) {
  const resizeObserver = new ResizeObserver(renderOverlay);
  resizeObserver.observe(elements.stage);
  resizeObserver.observe(elements.frame);
  resizeObserver.observe(elements.image);
}

restoreFilters();
syncFilterControls();
setViewport(state.viewport);
loadSession();
