function hoverMark(layer) {
  let mark = layer.querySelector(":scope > .vr-node-hover-mark");
  if (!mark) {
    mark = document.createElement("div");
    mark.className = "vr-node-hover-mark";
    mark.setAttribute("aria-hidden", "true");
    layer.append(mark);
  }
  return mark;
}

function clearHover(layer) {
  layer.querySelector(":scope > .vr-node-hover-mark")?.remove();
}

function frameWrapper(stage, frame) {
  const current = frame.parentElement;
  if (current?.dataset.reviewViewportWrapper === "true") return current;
  const wrapper = document.createElement("div");
  wrapper.dataset.reviewViewportWrapper = "true";
  wrapper.style.setProperty("position", "relative");
  wrapper.style.setProperty("flex", "none");
  wrapper.style.setProperty("overflow", "hidden");
  frame.before(wrapper);
  wrapper.append(frame);
  return wrapper;
}

function restoreUnscaledFrame(frame) {
  const wrapper = frame.parentElement?.dataset.reviewViewportWrapper === "true" ? frame.parentElement : null;
  frame.style.removeProperty("position");
  frame.style.removeProperty("inset");
  frame.style.removeProperty("transform");
  frame.style.removeProperty("transform-origin");
  if (wrapper) { wrapper.before(frame); wrapper.remove(); }
}

function scaleAnnotationMarks(layer, stage, frame, scale) {
  const stageRect = stage.getBoundingClientRect();
  const frameRect = frame.getBoundingClientRect();
  const frameLeft = frameRect.left - stageRect.left;
  const frameTop = frameRect.top - stageRect.top;
  for (const mark of layer.querySelectorAll(":scope > .vr-annotation-mark")) {
    const original = mark.__reviewViewportOriginal ??= {
      left: Number.parseFloat(mark.style.left), top: Number.parseFloat(mark.style.top),
      width: Number.parseFloat(mark.style.width), height: Number.parseFloat(mark.style.height),
    };
    mark.style.left = `${frameLeft + (original.left - frameLeft) * scale}px`;
    mark.style.top = `${frameTop + (original.top - frameTop) * scale}px`;
    mark.style.width = `${original.width * scale}px`;
    mark.style.height = `${original.height * scale}px`;
  }
}

function installCustomViewportFit(root, stage, frame, layer) {
  stage.__reviewViewportFitCleanup?.();
  let lastSignature = "";
  let frameScale = 1;
  const sync = () => {
    if (!stage.isConnected || !frame.isConnected) return;
    if (stage.dataset.viewport !== "custom") {
      restoreUnscaledFrame(frame);
      frameScale = 1;
      stage.dataset.reviewViewportScale = "1";
      lastSignature = "";
      scaleAnnotationMarks(layer, stage, frame, 1);
      return;
    }
    const width = Number.parseFloat(frame.style.width) || frame.offsetWidth;
    const height = Number.parseFloat(frame.style.height) || frame.offsetHeight;
    const availableWidth = Math.max(1, stage.clientWidth - 32);
    const availableHeight = Math.max(1, stage.clientHeight - 32);
    const scale = Math.min(1, availableWidth / width, availableHeight / height);
    const signature = `${width}:${height}:${availableWidth}:${availableHeight}:${scale}`;
    if (signature === lastSignature) return;
    lastSignature = signature;
    frameScale = scale;
    const wrapper = frameWrapper(stage, frame);
    wrapper.style.width = `${width * scale}px`;
    wrapper.style.height = `${height * scale}px`;
    frame.style.setProperty("position", "absolute");
    frame.style.setProperty("inset", "0");
    frame.style.setProperty("transform-origin", "top left");
    frame.style.setProperty("transform", `scale(${scale})`);
    stage.dataset.reviewViewportScale = String(scale);
    scaleAnnotationMarks(layer, stage, frame, scale);
    frame.contentWindow?.dispatchEvent(new Event("resize"));
  };
  const resizeObserver = new ResizeObserver(() => sync());
  const viewportObserver = new MutationObserver(() => sync());
  const markObserver = new MutationObserver(() => scaleAnnotationMarks(layer, stage, frame, frameScale));
  resizeObserver.observe(stage);
  viewportObserver.observe(stage, { attributes: true, attributeFilter: ["data-viewport"] });
  markObserver.observe(layer, { childList: true });
  frame.addEventListener("load", sync);
  requestAnimationFrame(sync);
  const cleanup = () => {
    resizeObserver.disconnect(); viewportObserver.disconnect(); markObserver.disconnect();
    frame.removeEventListener("load", sync);
  };
  stage.__reviewViewportFitCleanup = cleanup;
  return cleanup;
}

function enableVisibleInertNavigation(doc, win) {
  const changed = [];
  if (doc.defaultView?.frameElement?.closest?.(".vr-target-stage")?.dataset.mode !== "browse") return () => {};
  for (const node of doc.querySelectorAll("[inert]")) {
    if (!node.querySelector("a[href]")) continue;
    const rect = node.getBoundingClientRect();
    const style = win.getComputedStyle(node);
    const visible = style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < win.innerWidth && rect.top < win.innerHeight;
    if (!visible) continue;
    changed.push({ node, ariaHidden: node.getAttribute("aria-hidden") });
    node.removeAttribute("inert");
    if (node.getAttribute("aria-hidden") === "true") node.removeAttribute("aria-hidden");
  }
  return () => {
    for (const { node, ariaHidden } of changed) {
      if (!node.isConnected) continue;
      node.setAttribute("inert", "");
      if (ariaHidden === null) node.removeAttribute("aria-hidden"); else node.setAttribute("aria-hidden", ariaHidden);
    }
  };
}

export function mount({ root }) {
  const stage = root.querySelector(".vr-target-stage");
  const frame = stage?.querySelector("iframe");
  const layer = root.querySelector(".vr-annotation-mark-layer");
  if (!stage || !frame || !layer) return undefined;

  const keydown = (event) => {
    if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || document.querySelector("dialog[open]")) return;
    if (typeof event.target?.closest === "function" && event.target.closest("input, textarea, select, [contenteditable='true']")) return;
    const mode = { v: "browse", n: "node", r: "region" }[event.key.toLowerCase()];
    if (!mode) return;
    const button =
      document.querySelector(`[data-plugin-id="review"][data-slot="review.header"] .vr-selection-mode-button[data-value="${mode}"]`) ??
      root.querySelector(`.vr-selection-mode-button[data-value="${mode}"]`);
    if (!button) return;
    event.preventDefault();
    button.click();
  };
  window.addEventListener("keydown", keydown);

  let frameCleanup = () => {};
  const install = () => {
    frameCleanup();
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    if (!doc || !win) return;
    if (!doc.documentElement) {
      const retry = window.setTimeout(install, 16);
      frameCleanup = () => window.clearTimeout(retry);
      return;
    }

    let restoreNavigation = enableVisibleInertNavigation(doc, win);
    const refreshNavigation = () => {
      restoreNavigation();
      restoreNavigation = enableVisibleInertNavigation(doc, win);
    };
    win.addEventListener("resize", refreshNavigation);
    const move = (event) => {
      if (stage.dataset.mode !== "node" || !(event.target instanceof win.Element)) {
        clearHover(layer);
        return;
      }
      const targetRect = event.target.getBoundingClientRect();
      const frameRect = frame.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      const mark = hoverMark(layer);
      const scale = Number(stage.dataset.reviewViewportScale || 1);
      mark.style.left = `${frameRect.left - stageRect.left + targetRect.left * scale}px`;
      mark.style.top = `${frameRect.top - stageRect.top + targetRect.top * scale}px`;
      mark.style.width = `${targetRect.width * scale}px`;
      mark.style.height = `${targetRect.height * scale}px`;
    };
    const leave = () => clearHover(layer);
    const click = () => clearHover(layer);
    doc.addEventListener("mousemove", move, true);
    doc.addEventListener("mouseleave", leave, true);
    doc.addEventListener("click", click, true);
    doc.addEventListener("keydown", keydown, true);
    const previousCursor = doc.documentElement.style.cursor;
    if (stage.dataset.mode === "node") doc.documentElement.style.cursor = "crosshair";
    frameCleanup = () => {
      doc.removeEventListener("mousemove", move, true);
      doc.removeEventListener("mouseleave", leave, true);
      doc.removeEventListener("click", click, true);
      doc.removeEventListener("keydown", keydown, true);
      win.removeEventListener("resize", refreshNavigation);
      doc.documentElement.style.cursor = previousCursor;
      restoreNavigation();
      clearHover(layer);
    };
  };

  frame.addEventListener("load", install);
  install();
  const viewportFitCleanup = installCustomViewportFit(root, stage, frame, layer);
  return () => {
    window.removeEventListener("keydown", keydown);
    frame.removeEventListener("load", install);
    frameCleanup();
    viewportFitCleanup();
    if (stage.__reviewViewportFitCleanup === viewportFitCleanup) delete stage.__reviewViewportFitCleanup;
  };
}
