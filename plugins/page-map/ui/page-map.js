// Browser runtime for the page-map stage. Renders the transition graph on a Figma-like
// CSS-transform canvas (never an SVG viewBox camera) inside the panel the declarative document
// reserves for it. Frame previews are a *display* feature only: they load the already-analyzed
// page in a `sandbox=""` iframe (no scripts) purely so the graph is readable when zoomed in. The
// static analysis itself (server/) never opens a page - see README.md.
//
// This module performs no DOM/window access at module scope - every such reference lives inside
// `mount` (or a function called from it) so the pure helpers below can be imported and unit
// tested from plain Node (see test/graph-model.test.js).

const SVG_NS = "http://www.w3.org/2000/svg";

// The preview iframe itself is sized 1280x800 (PREVIEW_WIDTH x PREVIEW_HEIGHT) and CSS-scaled down
// by 0.25 (FRAME_WIDTH / PREVIEW_WIDTH) to fill the FRAME_WIDTH x FRAME_HEIGHT card - see the
// `/* page-map stage */` block in src/ui/renderer.css.
const FRAME_WIDTH = 320;
const FRAME_HEIGHT = 200;
const COLUMN_GAP = 140;
const ROW_GAP = 72;
const ROW_HEIGHT = FRAME_HEIGHT + ROW_GAP;
const NODE_LABEL_MAX_CHARS = 42;

const LOAD_SCREEN_WIDTH = 150;
const UNLOAD_SCREEN_WIDTH = 110;
const MAX_LOADED_PREVIEWS = 16;
const PREVIEW_DISABLE_PAGE_COUNT = 120;
const PREVIEW_STORAGE_KEY = "vrev.page-map.preview";

// Pointer travel (px) past which a press-and-drag counts as a pan rather than a click.
const PAN_CLICK_THRESHOLD = 4;

const MIN_SCALE = 0.05;
const MAX_SCALE = 4;

// Frame names are counter-scaled against the camera so they keep a constant on-screen size, the
// way Figma labels frames. Past this cap they stop growing and start shrinking with the canvas:
// without it, zooming far out leaves every name at full size overlapping its neighbours.
const NAME_MAX_SCALE = 2.6;
// Widest a frame name may draw, in on-screen px relative to the frame: 1.2 frame widths.
const NAME_MAX_WIDTH = FRAME_WIDTH * 1.2;
// A BFS layer wider than this wraps into extra columns, keeping the graph close to the viewport's
// aspect ratio instead of one very tall column (which would force a uselessly small fit zoom).
const MAX_ROWS_PER_COLUMN = 5;

function el(tag, className, attrs) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (attrs) for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function svg(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function baseName(pagePath) {
  const parts = String(pagePath).split("/");
  return parts[parts.length - 1] || pagePath;
}

function pageLabel(page) {
  return page.title || baseName(page.path);
}

/** Truncates a frame label to a fixed character budget so overly long titles don't blow out the name row. */
function ellipsizeLabel(label) {
  return label.length > NODE_LABEL_MAX_CHARS ? `${label.slice(0, NODE_LABEL_MAX_CHARS - 1)}…` : label;
}

async function fetchPageMap(pluginId) {
  const response = await fetch(`/api/plugin-host/v1/plugins/${encodeURIComponent(pluginId)}/queries/page-map.get`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ protocol: "plugin-bridge/1", request_id: crypto.randomUUID(), input: {} }),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.error?.message || "画面遷移マップを取得できませんでした");
  return result.data;
}

/** BFS layering from the entry over internal edges. Unreachable pages land in a trailing layer. */
function computeLayers(data) {
  const byPath = new Map(data.pages.map((page) => [page.path, page]));
  const outgoing = new Map();
  for (const edge of data.edges) {
    if (edge.from === edge.to || !byPath.has(edge.to)) continue;
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, new Set());
    outgoing.get(edge.from).add(edge.to);
  }
  const depth = new Map();
  const queue = [];
  if (byPath.has(data.entry_path)) { depth.set(data.entry_path, 0); queue.push(data.entry_path); }
  while (queue.length) {
    const current = queue.shift();
    for (const next of outgoing.get(current) ?? []) {
      if (depth.has(next)) continue;
      depth.set(next, depth.get(current) + 1);
      queue.push(next);
    }
  }
  const maxDepth = Math.max(0, ...depth.values());
  const unreachableLayer = maxDepth + 1;
  const layers = new Map();
  for (const page of data.pages) {
    const layer = depth.has(page.path) ? depth.get(page.path) : unreachableLayer;
    if (!layers.has(layer)) layers.set(layer, []);
    layers.get(layer).push(page);
  }
  return layers;
}

/** Lays out one fixed-size frame rect (FRAME_WIDTH x FRAME_HEIGHT) per page, columns per BFS
 *  layer. Pure and DOM-free so it can be unit tested directly. */
export function layoutNodes(layers) {
  const positions = new Map();
  const sortedLayerKeys = [...layers.keys()].sort((a, b) => a - b);
  let x = 60;
  for (const layerIndex of sortedLayerKeys) {
    const pages = layers.get(layerIndex).sort((a, b) => a.path.localeCompare(b.path));
    // Spread a tall layer over several columns, balanced so the columns are of even height.
    const columnCount = Math.max(1, Math.ceil(pages.length / MAX_ROWS_PER_COLUMN));
    const rowsPerColumn = Math.ceil(pages.length / columnCount);
    pages.forEach((page, index) => {
      const column = Math.floor(index / rowsPerColumn);
      const row = index % rowsPerColumn;
      const label = ellipsizeLabel(pageLabel(page));
      positions.set(page.path, {
        x: x + column * (FRAME_WIDTH + COLUMN_GAP),
        y: 60 + row * ROW_HEIGHT,
        width: FRAME_WIDTH,
        height: FRAME_HEIGHT,
        page,
        label,
      });
    });
    x += columnCount * (FRAME_WIDTH + COLUMN_GAP);
  }
  return positions;
}

/** World-space bounding box of a collection of {x,y,width,height} rects, falling back to a
 *  fixed default box when the collection is empty. */
function boundsOf(rects) {
  const list = rects instanceof Map ? [...rects.values()] : rects;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { x, y, width, height } of list) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 400, maxY: 300 };
  return { minX, minY, maxX, maxY };
}

function rectsIntersect(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function expandRect(rect, fraction) {
  const dx = rect.width * fraction;
  const dy = rect.height * fraction;
  return { x: rect.x - dx, y: rect.y - dy, width: rect.width + dx * 2, height: rect.height + dy * 2 };
}

/** Cursor-anchored zoom: returns the camera {tx,ty,k} such that the world point currently under
 *  (pointerX, pointerY) - both in viewport CSS px - stays under the cursor after the zoom. */
export function zoomAt(camera, factor, pointerX, pointerY, minScale = MIN_SCALE, maxScale = MAX_SCALE) {
  const k = Math.min(maxScale, Math.max(minScale, camera.k * factor));
  const ratio = k / camera.k;
  return { k, tx: pointerX - (pointerX - camera.tx) * ratio, ty: pointerY - (pointerY - camera.ty) * ratio };
}

/** Camera that fits `bounds` (world-space {minX,minY,maxX,maxY}) inside a viewport of the given
 *  size, centered, never exceeding maxScale. Degenerates gracefully for a zero-size bounds. */
export function fitTransform(bounds, viewportWidth, viewportHeight, padding = 48, maxScale = 1) {
  const boundsWidth = Math.max(1, bounds.maxX - bounds.minX);
  const boundsHeight = Math.max(1, bounds.maxY - bounds.minY);
  const availableWidth = Math.max(1, viewportWidth - padding * 2);
  const availableHeight = Math.max(1, viewportHeight - padding * 2);
  const k = Math.min(maxScale, availableWidth / boundsWidth, availableHeight / boundsHeight);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  return { k, tx: viewportWidth / 2 - centerX * k, ty: viewportHeight / 2 - centerY * k };
}

/** Camera that centers world-space `rect` in a viewport of the given size at scale `k`. */
export function centerOn(rect, viewportWidth, viewportHeight, k) {
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  return { k, tx: viewportWidth / 2 - centerX * k, ty: viewportHeight / 2 - centerY * k };
}

/** Builds the `/target/<...>` preview URL for a page path, matching `targetUrlForPage` in
 *  src/ui/renderer.js (leading slashes stripped, segments individually encoded, "/" preserved). */
export function targetPreviewUrl(pagePath) {
  return `/target/${String(pagePath).replace(/^\/+/, "").split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
}

function loadPreviewPreference(pageCount) {
  try {
    const stored = localStorage.getItem(PREVIEW_STORAGE_KEY);
    if (stored === "1") return true;
    if (stored === "0") return false;
  } catch {
    // Storage unavailable (private mode, disabled cookies, ...) - fall through to the default.
  }
  return pageCount <= PREVIEW_DISABLE_PAGE_COUNT;
}

function savePreviewPreference(enabled) {
  try {
    localStorage.setItem(PREVIEW_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Best-effort only; the toggle still works for the current session.
  }
}

export async function mount({ root, pluginId, toast }) {
  const canvas = root.querySelector('[data-definition-id="page-map-canvas"]');
  if (!(canvas instanceof HTMLElement)) return () => {};

  let data = null;
  let selectedPath = null;
  let searchTerm = "";
  let camera = { tx: 0, ty: 0, k: 1 };
  let userMovedCamera = false;
  let previewsEnabled = true;
  let lastPositions = new Map();
  const frameStates = new Map();
  let edgePaths = [];
  let pendingFrame = false;
  let panState = null;
  // Set once a pan passes PAN_CLICK_THRESHOLD, so the click that ends the drag does not also
  // select whichever frame the drag happened to start on.
  let panDragged = false;

  const shell = el("div", "vr-page-map-shell");
  const sideColumn = el("div", "vr-page-map-side");
  const listColumn = el("div", "vr-page-map-list");
  const detailColumn = el("div", "vr-page-map-detail");
  sideColumn.append(listColumn, detailColumn);
  const graphColumn = el("div", "vr-page-map-graph");
  shell.append(sideColumn, graphColumn);
  canvas.replaceChildren(shell);

  const world = el("div", "vr-page-map-world");
  const edgesSvg = svg("svg", { class: "vr-page-map-edges", role: "img", "aria-label": "画面遷移グラフ" });
  const marker = svg("marker", { id: "vr-page-map-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: "auto-start-reverse" });
  marker.append(svg("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "var(--vr-color-border-strong, #94a3b8)" }));
  const defs = svg("defs");
  defs.append(marker);
  edgesSvg.append(defs);
  world.append(edgesSvg);
  graphColumn.append(world);

  const toolbar = el("div", "vr-page-map-toolbar");
  const fitButton = el("button", "vr-page-map-fit-button");
  fitButton.type = "button";
  fitButton.textContent = "全体表示";
  fitButton.addEventListener("click", () => fitToViewport());
  const zoomOutButton = el("button", "vr-page-map-zoom-button");
  zoomOutButton.type = "button";
  zoomOutButton.textContent = "−";
  zoomOutButton.setAttribute("aria-label", "縮小");
  zoomOutButton.addEventListener("click", () => stepZoom(1 / 1.25));
  const zoomReadout = el("span", "vr-page-map-zoom-readout");
  zoomReadout.textContent = "100%";
  const zoomInButton = el("button", "vr-page-map-zoom-button");
  zoomInButton.type = "button";
  zoomInButton.textContent = "＋";
  zoomInButton.setAttribute("aria-label", "拡大");
  zoomInButton.addEventListener("click", () => stepZoom(1.25));
  const previewLabel = el("label", "vr-page-map-preview-toggle");
  const previewCheckbox = el("input");
  previewCheckbox.type = "checkbox";
  previewCheckbox.addEventListener("change", () => {
    previewsEnabled = previewCheckbox.checked;
    savePreviewPreference(previewsEnabled);
    if (!previewsEnabled) for (const frame of frameStates.values()) if (frame.loaded) unloadFrame(frame);
    scheduleFrame();
  });
  previewLabel.append(previewCheckbox, document.createTextNode("プレビュー"));
  toolbar.append(fitButton, zoomOutButton, zoomReadout, zoomInButton, previewLabel);
  graphColumn.append(toolbar);

  function scheduleFrame() {
    if (pendingFrame) return;
    pendingFrame = true;
    requestAnimationFrame(() => {
      pendingFrame = false;
      applyCameraFrame();
    });
  }

  function applyCameraFrame() {
    world.style.transform = `translate(${camera.tx}px, ${camera.ty}px) scale(${camera.k})`;
    world.style.setProperty("--vr-page-map-inv-scale", String(1 / camera.k));
    // Names track the inverse scale until NAME_MAX_SCALE, then shrink with the canvas so a
    // zoomed-out overview stays legible instead of collapsing into overlapping labels.
    const nameScale = Math.min(1 / camera.k, NAME_MAX_SCALE);
    world.style.setProperty("--vr-page-map-name-scale", String(nameScale));
    world.style.setProperty("--vr-page-map-name-max-width", `${NAME_MAX_WIDTH / nameScale}px`);
    zoomReadout.textContent = `${Math.round(camera.k * 100)}%`;
    updateLod();
  }

  function viewportWorldRect() {
    const vw = graphColumn.clientWidth;
    const vh = graphColumn.clientHeight;
    return { x: (0 - camera.tx) / camera.k, y: (0 - camera.ty) / camera.k, width: vw / camera.k, height: vh / camera.k };
  }

  function updateLod() {
    if (!frameStates.size) return;
    const viewport = viewportWorldRect();
    const loadZone = expandRect(viewport, 0.25);
    const keepZone = expandRect(viewport, 1);
    const screenFrameWidth = FRAME_WIDTH * camera.k;
    const centerX = viewport.x + viewport.width / 2;
    const centerY = viewport.y + viewport.height / 2;
    const distanceToCenter = (frame) => {
      const cx = frame.rect.x + frame.rect.width / 2;
      const cy = frame.rect.y + frame.rect.height / 2;
      return Math.hypot(cx - centerX, cy - centerY);
    };

    const loadCandidates = [];
    for (const frame of frameStates.values()) {
      const shouldUnload = !previewsEnabled || screenFrameWidth < UNLOAD_SCREEN_WIDTH || !rectsIntersect(frame.rect, keepZone);
      if (frame.loaded && shouldUnload) { unloadFrame(frame); continue; }
      const shouldLoad = previewsEnabled && frame.page.exists && screenFrameWidth >= LOAD_SCREEN_WIDTH && rectsIntersect(frame.rect, loadZone);
      if (!frame.loaded && shouldLoad) loadCandidates.push(frame);
      else if (!frame.loaded) renderPlaceholder(frame);
    }

    loadCandidates.sort((a, b) => distanceToCenter(a) - distanceToCenter(b));
    let loadedCount = 0;
    for (const frame of frameStates.values()) if (frame.loaded) loadedCount++;
    for (const frame of loadCandidates) {
      if (loadedCount >= MAX_LOADED_PREVIEWS) break;
      loadFrame(frame);
      loadedCount++;
    }

    const loaded = [...frameStates.values()].filter((frame) => frame.loaded);
    if (loaded.length > MAX_LOADED_PREVIEWS) {
      loaded.sort((a, b) => distanceToCenter(b) - distanceToCenter(a));
      for (const frame of loaded.slice(0, loaded.length - MAX_LOADED_PREVIEWS)) unloadFrame(frame);
    }
  }

  function renderPlaceholder(frame) {
    frame.previewArea.replaceChildren();
    const placeholder = el("div", "vr-page-map-frame-placeholder");
    const title = el("span", "vr-page-map-frame-placeholder-title");
    title.textContent = frame.label;
    const counts = el("span", "vr-page-map-frame-placeholder-counts");
    counts.textContent = `IN ${frame.page.in_count} / OUT ${frame.page.out_count}`;
    const reason = el("span", "vr-page-map-frame-placeholder-reason");
    reason.textContent = !frame.page.exists ? "ファイルがありません" : !previewsEnabled ? "プレビューは無効です" : "拡大するとプレビューを表示";
    placeholder.append(title, counts, reason);
    frame.previewArea.append(placeholder);
  }

  function loadFrame(frame) {
    frame.previewArea.replaceChildren();
    const iframe = document.createElement("iframe");
    iframe.className = "vr-page-map-preview-frame";
    iframe.setAttribute("sandbox", ""); // no scripts, no same-origin: a static visual preview only
    iframe.setAttribute("scrolling", "no");
    iframe.setAttribute("loading", "lazy");
    iframe.setAttribute("tabindex", "-1");
    iframe.setAttribute("aria-hidden", "true");
    iframe.title = `${frame.label}のプレビュー`;
    iframe.src = targetPreviewUrl(frame.page.path);
    frame.previewArea.append(iframe);
    frame.loaded = true;
    frame.iframeEl = iframe;
  }

  function unloadFrame(frame) {
    if (frame.iframeEl) {
      frame.iframeEl.src = "";
      frame.iframeEl.remove();
      frame.iframeEl = null;
    }
    frame.loaded = false;
    renderPlaceholder(frame);
  }

  function fitToViewport() {
    const vw = graphColumn.clientWidth;
    const vh = graphColumn.clientHeight;
    if (!vw || !vh) { requestAnimationFrame(fitToViewport); return; }
    camera = fitTransform(boundsOf(lastPositions), vw, vh, 48, 1);
    userMovedCamera = false;
    scheduleFrame();
  }

  function stepZoom(factor) {
    const vw = graphColumn.clientWidth;
    const vh = graphColumn.clientHeight;
    camera = zoomAt(camera, factor, vw / 2, vh / 2);
    userMovedCamera = true;
    scheduleFrame();
  }

  const resizeObserver = new ResizeObserver(() => {
    if (!lastPositions.size) return;
    if (!userMovedCamera) fitToViewport();
    else scheduleFrame();
  });
  resizeObserver.observe(graphColumn);

  function render() {
    if (!data) return;
    renderList();
    applySelectionVisuals();
    renderDetail();
  }

  function renderList() {
    listColumn.replaceChildren();
    const search = el("input", "vr-page-map-search");
    search.type = "search";
    search.placeholder = "ページを検索";
    search.value = searchTerm;
    search.addEventListener("input", () => { searchTerm = search.value; renderList(); });
    listColumn.append(search);

    const list = el("ul", "vr-page-map-page-list");
    const term = searchTerm.trim().toLowerCase();
    for (const page of [...data.pages].sort((a, b) => a.path.localeCompare(b.path))) {
      if (term && !page.path.toLowerCase().includes(term) && !(page.title || "").toLowerCase().includes(term)) continue;
      const item = el("li", "vr-page-map-page-item");
      if (page.path === selectedPath) item.classList.add("is-selected");
      const button = el("button", "vr-page-map-page-button");
      button.type = "button";
      const name = el("span", "vr-page-map-page-name");
      name.textContent = pageLabel(page);
      button.append(name);
      if (page.path === data.entry_path) { const badge = el("span", "vr-page-map-badge is-entry"); badge.textContent = "起点"; button.append(badge); }
      if (!page.reachable) { const badge = el("span", "vr-page-map-badge is-unreachable"); badge.textContent = "未到達"; button.append(badge); }
      if (!page.exists) { const badge = el("span", "vr-page-map-badge is-missing"); badge.textContent = "ファイルなし"; button.append(badge); }
      const counts = el("span", "vr-page-map-counts");
      counts.textContent = `IN ${page.in_count} / OUT ${page.out_count}`;
      button.append(counts);
      button.addEventListener("click", () => selectFromList(page.path));
      item.append(button);
      list.append(item);
    }
    listColumn.append(list);
  }

  function buildGraph() {
    const layers = computeLayers(data);
    const positions = layoutNodes(layers);
    lastPositions = positions;

    const bounds = boundsOf(positions);
    edgesSvg.setAttribute("width", String(Math.max(1, bounds.maxX - bounds.minX + 200)));
    edgesSvg.setAttribute("height", String(Math.max(1, bounds.maxY - bounds.minY + 200)));
    edgesSvg.replaceChildren(defs);
    edgePaths = [];
    for (const edge of data.edges) {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to || from === to) continue;
      const fromX = from.x + from.width;
      const fromY = from.y + from.height / 2;
      const toX = to.x;
      const toY = to.y + to.height / 2;
      const midOffset = Math.max(24, (toX - fromX) / 2);
      const path = svg("path", {
        d: `M ${fromX} ${fromY} C ${fromX + midOffset} ${fromY}, ${toX - midOffset} ${toY}, ${toX} ${toY}`,
        class: "vr-page-map-edge",
        "vector-effect": "non-scaling-stroke",
        "marker-end": "url(#vr-page-map-arrow)",
      });
      edgesSvg.append(path);
      edgePaths.push({ edge, path });
    }

    for (const frame of frameStates.values()) unloadFrame(frame);
    frameStates.clear();
    world.querySelectorAll(".vr-page-map-frame").forEach((node) => node.remove());
    for (const pos of positions.values()) {
      const frame = buildFrameElement(pos);
      frame.rect = { x: pos.x, y: pos.y, width: pos.width, height: pos.height };
      frame.loaded = false;
      frame.iframeEl = null;
      renderPlaceholder(frame);
      frameStates.set(pos.page.path, frame);
      world.append(frame.el);
    }
  }

  function buildFrameElement(pos) {
    const { x, y, width, height, page, label } = pos;
    const frameEl = el("div", "vr-page-map-frame");
    frameEl.style.left = `${x}px`;
    frameEl.style.top = `${y}px`;
    frameEl.style.width = `${width}px`;
    frameEl.style.height = `${height}px`;
    frameEl.tabIndex = 0;
    frameEl.setAttribute("role", "button");
    frameEl.setAttribute("aria-label", label);
    if (page.path === data.entry_path) frameEl.classList.add("is-entry");
    if (!page.reachable) frameEl.classList.add("is-unreachable");
    if (!page.exists) frameEl.classList.add("is-missing");

    const nameRow = el("div", "vr-page-map-frame-name");
    const nameText = el("span", "vr-page-map-frame-title");
    nameText.textContent = label;
    nameRow.append(nameText);
    if (page.path === data.entry_path) { const badge = el("span", "vr-page-map-badge is-entry"); badge.textContent = "起点"; nameRow.append(badge); }
    if (!page.reachable) { const badge = el("span", "vr-page-map-badge is-unreachable"); badge.textContent = "未到達"; nameRow.append(badge); }
    if (!page.exists) { const badge = el("span", "vr-page-map-badge is-missing"); badge.textContent = "ファイルなし"; nameRow.append(badge); }
    const openButton = el("button", "vr-page-map-frame-open-button");
    openButton.type = "button";
    openButton.textContent = "開く";
    openButton.addEventListener("click", (event) => { event.stopPropagation(); void openPage(page.path, toast); });
    nameRow.append(openButton);

    const previewArea = el("div", "vr-page-map-frame-preview");
    frameEl.append(nameRow, previewArea);

    frameEl.addEventListener("click", () => selectFromFrame(page.path));
    frameEl.addEventListener("dblclick", () => void openPage(page.path, toast));
    frameEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectFromFrame(page.path); }
    });

    return { el: frameEl, previewArea, page, label };
  }

  function applySelectionVisuals() {
    const hasSelection = selectedPath !== null;
    edgesSvg.classList.toggle("is-filtered", hasSelection);
    edgesSvg.querySelectorAll(".vr-page-map-edge-label").forEach((node) => node.remove());
    for (const { edge, path } of edgePaths) {
      const isHighlighted = hasSelection && (edge.from === selectedPath || edge.to === selectedPath);
      path.classList.toggle("is-highlighted", isHighlighted);
      if (!isHighlighted) continue;
      const from = lastPositions.get(edge.from);
      const to = lastPositions.get(edge.to);
      if (!from || !to) continue;
      const midX = (from.x + from.width + to.x) / 2;
      const midY = (from.y + from.height / 2 + to.y + to.height / 2) / 2;
      const label = svg("text", { x: midX, y: midY, class: "vr-page-map-edge-label" });
      label.textContent = edge.label || edge.kind;
      edgesSvg.append(label);
    }
    for (const [path, frame] of frameStates) frame.el.classList.toggle("is-selected", path === selectedPath);
  }

  function selectFromFrame(path) {
    selectedPath = path;
    applySelectionVisuals();
    renderList();
    renderDetail();
  }

  function selectFromList(path) {
    selectedPath = path;
    const frame = frameStates.get(path);
    if (frame) {
      camera = centerOn(frame.rect, graphColumn.clientWidth, graphColumn.clientHeight, Math.max(camera.k, 0.6));
      userMovedCamera = true;
      scheduleFrame();
    }
    applySelectionVisuals();
    renderList();
    renderDetail();
  }

  function renderDetail() {
    detailColumn.replaceChildren();
    const page = data.pages.find((item) => item.path === selectedPath);
    if (!page) {
      const empty = el("p", "vr-page-map-detail-empty");
      empty.textContent = "ノードを選択すると詳細を表示します。";
      detailColumn.append(empty);
      return;
    }
    const title = el("h3", "vr-page-map-detail-title");
    title.textContent = pageLabel(page);
    const pathLine = el("p", "vr-page-map-detail-path");
    pathLine.textContent = page.path;
    detailColumn.append(title, pathLine);

    const openButton = el("button", "vr-page-map-open-button");
    openButton.type = "button";
    openButton.textContent = "このページを開く";
    openButton.addEventListener("click", () => void openPage(page.path, toast));
    detailColumn.append(openButton);

    const incoming = data.edges.filter((edge) => edge.to === page.path);
    const outgoing = data.edges.filter((edge) => edge.from === page.path);
    const unknownForPage = data.unknown.filter((entry) => entry.from === page.path);

    detailColumn.append(edgeList("受信", incoming, (edge) => edge.from));
    detailColumn.append(edgeList("発信", outgoing, (edge) => edge.to));

    if (unknownForPage.length) {
      const note = el("p", "vr-page-map-detail-unknown");
      note.textContent = `解析できなかった遷移: ${unknownForPage.length}件`;
      detailColumn.append(note);
    }
  }

  function edgeList(title, edges, endpoint) {
    const wrap = el("div", "vr-page-map-edge-group");
    const heading = el("h4");
    heading.textContent = `${title}（${edges.length}）`;
    wrap.append(heading);
    const list = el("ul", "vr-page-map-edge-list");
    for (const edge of edges) {
      const item = el("li");
      item.textContent = `${endpoint(edge)} - ${edge.label || edge.kind}（${edge.kind}, L${edge.line}）`;
      list.append(item);
    }
    wrap.append(list);
    return wrap;
  }

  async function openPage(pagePath, notify) {
    try {
      const layoutResponse = await fetch("/api/settings/layout");
      const layoutPayload = await layoutResponse.json();
      const surfaceResponse = await fetch("/api/plugin-host/v1/surfaces/review");
      const surfacePayload = await surfaceResponse.json();
      const targetStageKey = surfacePayload?.layout?.target_stage_key;
      if (targetStageKey) {
        await fetch("/api/settings/layout", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision: layoutPayload.revision, stage: { active: targetStageKey } }),
        });
      }
    } catch {
      notify?.("レイアウト設定を更新できませんでした。移動のみ行います。", "warning");
    }
    location.assign(`/?page=${encodeURIComponent(pagePath)}`);
  }

  function onWheel(event) {
    event.preventDefault();
    const rect = graphColumn.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const factor = Math.min(2, Math.max(0.5, Math.exp(-event.deltaY * 0.0015)));
    camera = zoomAt(camera, factor, pointerX, pointerY);
    userMovedCamera = true;
    scheduleFrame();
  }
  function onPointerDown(event) {
    if (event.button !== 0) return;
    // Cleared on every press, including one on a control, so a drag that ended without a click
    // (pointer released outside the window) can never swallow the next genuine click.
    panDragged = false;
    // Controls layered over the canvas (the toolbar, a frame's 開く button) must keep their own
    // click: starting a pan here would capture the pointer on the viewport and the browser would
    // then deliver the click to the capture target instead of the control.
    if (event.target instanceof Element && event.target.closest(".vr-page-map-toolbar, button, input, label, select")) return;
    panState = { startX: event.clientX, startY: event.clientY, originTx: camera.tx, originTy: camera.ty };
    graphColumn.setPointerCapture?.(event.pointerId);
    graphColumn.classList.add("is-panning");
  }
  function onPointerMove(event) {
    if (!panState) return;
    const dx = event.clientX - panState.startX;
    const dy = event.clientY - panState.startY;
    if (!panDragged && Math.hypot(dx, dy) > PAN_CLICK_THRESHOLD) panDragged = true;
    camera = { ...camera, tx: panState.originTx + dx, ty: panState.originTy + dy };
    userMovedCamera = true;
    scheduleFrame();
  }
  function onPointerUp() {
    panState = null;
    graphColumn.classList.remove("is-panning");
  }

  /** Swallows the click that terminates a pan, so dragging across the board never changes the
   *  selection. A plain click (no movement past the threshold) is left alone. */
  function onClickCapture(event) {
    if (!panDragged) return;
    panDragged = false;
    event.stopPropagation();
    event.preventDefault();
  }

  graphColumn.addEventListener("click", onClickCapture, true);
  graphColumn.addEventListener("wheel", onWheel, { passive: false });
  graphColumn.addEventListener("pointerdown", onPointerDown);
  graphColumn.addEventListener("pointermove", onPointerMove);
  graphColumn.addEventListener("pointerup", onPointerUp);
  graphColumn.addEventListener("pointerleave", onPointerUp);

  try {
    data = await fetchPageMap(pluginId);
    if (data.truncated) toast?.(`解析が途中で打ち切られました（${data.warnings[0] ?? ""}）`, "warning");
    previewsEnabled = loadPreviewPreference(data.pages.length);
    previewCheckbox.checked = previewsEnabled;
    buildGraph();
    fitToViewport();
    render();
  } catch (error) {
    const message = error instanceof Error ? error.message : "画面遷移マップを取得できませんでした";
    const failure = el("p", "vr-page-map-detail-empty");
    failure.textContent = message;
    canvas.replaceChildren(failure);
    toast?.(message, "error");
  }

  return () => {
    resizeObserver.disconnect();
    graphColumn.removeEventListener("click", onClickCapture, true);
    graphColumn.removeEventListener("wheel", onWheel);
    graphColumn.removeEventListener("pointerdown", onPointerDown);
    graphColumn.removeEventListener("pointermove", onPointerMove);
    graphColumn.removeEventListener("pointerup", onPointerUp);
    graphColumn.removeEventListener("pointerleave", onPointerUp);
    for (const frame of frameStates.values()) unloadFrame(frame);
  };
}
