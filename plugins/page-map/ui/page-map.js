// Browser runtime for the page-map stage. Renders the transition graph directly (SVG built
// with createElementNS, never innerHTML) inside the panel the declarative document reserves
// for it. This module never renders or fetches a reviewed page - it only draws the analysis
// result returned by the page-map.get bridge query.

const SVG_NS = "http://www.w3.org/2000/svg";

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

const NODE_HEIGHT = 48;
const NODE_LABEL_MAX_CHARS = 28;

/** Truncates a node label to a fixed character budget so overly long titles don't blow out the graph layout. */
function ellipsizeLabel(label) {
  return label.length > NODE_LABEL_MAX_CHARS ? `${label.slice(0, NODE_LABEL_MAX_CHARS - 1)}…` : label;
}

/** Node rect width grows with the (already-capped) label length, keeping the 12px label readable without over-widening the graph. */
function nodeWidth(label) {
  return Math.max(140, Math.min(240, Math.round(label.length * 7.2) + 32));
}

function layoutNodes(layers) {
  const positions = new Map();
  const columnGap = 60;
  const rowHeight = 88;
  const sortedLayerKeys = [...layers.keys()].sort((a, b) => a - b);
  let x = 60;
  for (const layerIndex of sortedLayerKeys) {
    const pages = layers.get(layerIndex).sort((a, b) => a.path.localeCompare(b.path));
    let layerWidth = 140;
    pages.forEach((page, row) => {
      const label = ellipsizeLabel(page.title || baseName(page.path));
      const width = nodeWidth(label);
      layerWidth = Math.max(layerWidth, width);
      positions.set(page.path, { x, y: 50 + row * rowHeight, page, label, width });
    });
    x += layerWidth + columnGap;
  }
  return positions;
}

export async function mount({ root, pluginId, toast }) {
  const canvas = root.querySelector('[data-definition-id="page-map-canvas"]') ?? [...root.querySelectorAll(".vr-panel")].at(-1);
  if (!(canvas instanceof HTMLElement)) return () => {};

  let data = null;
  let selectedPath = null;
  let searchTerm = "";
  let viewBox = { x: 0, y: 0, width: 1200, height: 800 };
  let pan = null;
  let lastPositions = new Map();

  const shell = el("div", "vr-page-map-shell");
  const sideColumn = el("div", "vr-page-map-side");
  const listColumn = el("div", "vr-page-map-list");
  const detailColumn = el("div", "vr-page-map-detail");
  sideColumn.append(listColumn, detailColumn);
  const graphColumn = el("div", "vr-page-map-graph");
  shell.append(sideColumn, graphColumn);
  canvas.replaceChildren(shell);

  const graphSvg = svg("svg", { class: "vr-page-map-svg", role: "img", "aria-label": "画面遷移グラフ" });
  const fitButton = el("button", "vr-page-map-fit-button");
  fitButton.type = "button";
  fitButton.textContent = "全体表示";
  fitButton.addEventListener("click", () => fitToGraph());
  graphColumn.append(graphSvg, fitButton);

  const marker = svg("marker", { id: "vr-page-map-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: "auto-start-reverse" });
  marker.append(svg("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "var(--vr-color-border-strong, #94a3b8)" }));
  const defs = svg("defs");
  defs.append(marker);
  graphSvg.append(defs);

  /** Fits the viewBox to the full graph bounds (plus padding), matched to the container's aspect ratio.
   *  Retries on the next frame if the SVG hasn't been laid out yet (clientWidth/Height still 0). */
  function fitToGraph() {
    const positions = [...lastPositions.values()];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const { x, y, width } of positions) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + width);
      maxY = Math.max(maxY, y + NODE_HEIGHT);
    }
    if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 400; maxY = 300; }
    const pad = 48;
    let boundsWidth = maxX - minX + pad * 2;
    let boundsHeight = maxY - minY + pad * 2;
    const containerWidth = graphSvg.clientWidth;
    const containerHeight = graphSvg.clientHeight;
    if (!containerWidth || !containerHeight) { requestAnimationFrame(fitToGraph); return; }
    const containerAspect = containerWidth / containerHeight;
    if (boundsWidth / boundsHeight > containerAspect) boundsHeight = boundsWidth / containerAspect;
    else boundsWidth = boundsHeight * containerAspect;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    viewBox = { x: centerX - boundsWidth / 2, y: centerY - boundsHeight / 2, width: boundsWidth, height: boundsHeight };
    graphSvg.setAttribute("viewBox", `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`);
  }

  const resizeObserver = new ResizeObserver(() => {
    if (!lastPositions.size) return;
    fitToGraph();
  });
  resizeObserver.observe(graphColumn);

  function pageLabel(page) {
    return page.title || baseName(page.path);
  }

  function render() {
    if (!data) return;
    renderList();
    renderGraph();
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
      button.addEventListener("click", () => { selectedPath = page.path; render(); });
      item.append(button);
      list.append(item);
    }
    listColumn.append(list);
  }

  function renderGraph() {
    const layers = computeLayers(data);
    const positions = layoutNodes(layers);
    const isFirstGraphRender = lastPositions.size === 0;
    lastPositions = positions;

    while (graphSvg.children.length > 1) graphSvg.removeChild(graphSvg.lastChild);

    const edgeLayer = svg("g", { class: "vr-page-map-edges" });
    const nodeLayer = svg("g", { class: "vr-page-map-nodes" });

    for (const edge of data.edges) {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to || from === to) continue;
      const isHighlighted = selectedPath !== null && (edge.from === selectedPath || edge.to === selectedPath);
      const fromX = from.x + from.width;
      const midOffset = Math.max(24, (to.x - fromX) / 2);
      const path = svg("path", {
        d: `M ${fromX} ${from.y + 24} C ${fromX + midOffset} ${from.y + 24}, ${to.x - midOffset} ${to.y + 24}, ${to.x} ${to.y + 24}`,
        class: `vr-page-map-edge${isHighlighted ? " is-highlighted" : ""}`,
        "marker-end": "url(#vr-page-map-arrow)",
      });
      edgeLayer.append(path);
      if (isHighlighted) {
        const midX = (fromX + to.x) / 2;
        const midY = (from.y + to.y) / 2 + 16;
        const label = svg("text", { x: midX, y: midY, class: "vr-page-map-edge-label" });
        label.textContent = edge.label || edge.kind;
        edgeLayer.append(label);
      }
    }

    for (const { x, y, page, label, width } of positions.values()) {
      const group = svg("g", { class: "vr-page-map-node", transform: `translate(${x}, ${y})`, tabindex: 0, role: "button" });
      if (page.path === selectedPath) group.classList.add("is-selected");
      if (!page.reachable) group.classList.add("is-unreachable");
      if (!page.exists) group.classList.add("is-missing");
      const rect = svg("rect", { width, height: NODE_HEIGHT, rx: 8, class: "vr-page-map-node-rect" });
      const text = svg("text", { x: 12, y: 28, class: "vr-page-map-node-text" });
      text.textContent = label;
      group.append(rect, text);
      group.addEventListener("click", () => { selectedPath = page.path; render(); });
      group.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectedPath = page.path; render(); } });
      nodeLayer.append(group);
    }

    graphSvg.append(edgeLayer, nodeLayer);

    if (isFirstGraphRender) fitToGraph();
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
    const scale = event.deltaY > 0 ? 1.1 : 0.9;
    const nextWidth = Math.min(6000, Math.max(300, viewBox.width * scale));
    const nextHeight = Math.min(4000, Math.max(200, viewBox.height * scale));
    viewBox = { ...viewBox, width: nextWidth, height: nextHeight };
    graphSvg.setAttribute("viewBox", `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`);
  }
  function onPointerDown(event) {
    pan = { startX: event.clientX, startY: event.clientY, originX: viewBox.x, originY: viewBox.y };
    graphSvg.setPointerCapture?.(event.pointerId);
  }
  function onPointerMove(event) {
    if (!pan) return;
    const scaleX = viewBox.width / graphSvg.clientWidth;
    const scaleY = viewBox.height / graphSvg.clientHeight;
    viewBox = { ...viewBox, x: pan.originX - (event.clientX - pan.startX) * scaleX, y: pan.originY - (event.clientY - pan.startY) * scaleY };
    graphSvg.setAttribute("viewBox", `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`);
  }
  function onPointerUp() { pan = null; }

  graphSvg.addEventListener("wheel", onWheel, { passive: false });
  graphSvg.addEventListener("pointerdown", onPointerDown);
  graphSvg.addEventListener("pointermove", onPointerMove);
  graphSvg.addEventListener("pointerup", onPointerUp);
  graphSvg.addEventListener("pointerleave", onPointerUp);

  try {
    data = await fetchPageMap(pluginId);
    if (data.truncated) toast?.(`解析が途中で打ち切られました（${data.warnings[0] ?? ""}）`, "warning");
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
    graphSvg.removeEventListener("wheel", onWheel);
    graphSvg.removeEventListener("pointerdown", onPointerDown);
    graphSvg.removeEventListener("pointermove", onPointerMove);
    graphSvg.removeEventListener("pointerup", onPointerUp);
    graphSvg.removeEventListener("pointerleave", onPointerUp);
  };
}
