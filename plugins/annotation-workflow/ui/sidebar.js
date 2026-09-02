const expandedMessages = new Set();
const MESSAGE_SELECTOR = '[id^="annotation-comment--"], [id^="thread-body--"]';

function collapse(node) {
  node.style.setProperty("display", "-webkit-box");
  node.style.setProperty("-webkit-box-orient", "vertical");
  node.style.setProperty("-webkit-line-clamp", "3");
  node.style.setProperty("overflow", "hidden");
}

function expand(node) {
  node.style.removeProperty("display");
  node.style.removeProperty("-webkit-box-orient");
  node.style.removeProperty("-webkit-line-clamp");
  node.style.removeProperty("overflow");
}

function setExpanded(node, expanded) {
  if (expanded) {
    expand(node);
    expandedMessages.add(node.id);
  } else {
    collapse(node);
    expandedMessages.delete(node.id);
  }
  node.dataset.workflowExpanded = String(expanded);
  node.setAttribute("aria-expanded", String(expanded));
  node.title = expanded ? "クリックして折りたたむ" : "クリックして全文を表示";
}

function makeExpandable(node) {
  node.dataset.workflowExpandable = "true";
  node.style.setProperty("cursor", "pointer");
  if (node.tagName !== "BUTTON") {
    node.setAttribute("role", "button");
    node.tabIndex = 0;
  }
  setExpanded(node, expandedMessages.has(node.id));
}

function prepare(node) {
  if (!(node instanceof HTMLElement) || !node.id) return;
  if (expandedMessages.has(node.id)) {
    makeExpandable(node);
    return;
  }
  collapse(node);
  requestAnimationFrame(() => {
    if (!node.isConnected) return;
    const clampedHeight = node.getBoundingClientRect().height;
    expand(node);
    const fullHeight = node.getBoundingClientRect().height;
    if (fullHeight > clampedHeight + 1) makeExpandable(node);
    else expand(node);
  });
}

function expandableMessage(root, target) {
  if (!(target instanceof Element)) return null;
  const node = target.closest(MESSAGE_SELECTOR);
  return node instanceof HTMLElement && root.contains(node) && node.dataset.workflowExpandable === "true" ? node : null;
}

export function mount({ root }) {
  for (const node of root.querySelectorAll(MESSAGE_SELECTOR)) prepare(node);

  const click = (event) => {
    const node = expandableMessage(root, event.target);
    if (!node) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    setExpanded(node, node.dataset.workflowExpanded !== "true");
  };
  const keydown = (event) => {
    const node = expandableMessage(root, event.target);
    if (!node || node.tagName === "BUTTON" || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    setExpanded(node, node.dataset.workflowExpanded !== "true");
  };
  const focusin = (event) => {
    const node = expandableMessage(root, event.target);
    if (!node || node.tagName === "BUTTON") return;
    node.style.setProperty("outline", "2px solid var(--vr-color-focus)");
    node.style.setProperty("outline-offset", "2px");
    node.style.setProperty("border-radius", "3px");
  };
  const focusout = (event) => {
    const node = expandableMessage(root, event.target);
    if (!node || node.tagName === "BUTTON") return;
    node.style.removeProperty("outline");
    node.style.removeProperty("outline-offset");
    node.style.removeProperty("border-radius");
  };

  root.addEventListener("click", click, true);
  root.addEventListener("keydown", keydown, true);
  root.addEventListener("focusin", focusin, true);
  root.addEventListener("focusout", focusout, true);
  return () => {
    root.removeEventListener("click", click, true);
    root.removeEventListener("keydown", keydown, true);
    root.removeEventListener("focusin", focusin, true);
    root.removeEventListener("focusout", focusout, true);
  };
}
