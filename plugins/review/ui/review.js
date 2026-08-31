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
    const button = root.querySelector(`.vr-selection-mode-button[data-value="${mode}"]`);
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
      mark.style.left = `${frameRect.left - stageRect.left + targetRect.left}px`;
      mark.style.top = `${frameRect.top - stageRect.top + targetRect.top}px`;
      mark.style.width = `${targetRect.width}px`;
      mark.style.height = `${targetRect.height}px`;
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
  return () => {
    window.removeEventListener("keydown", keydown);
    frame.removeEventListener("load", install);
    frameCleanup();
  };
}
