// Pure static HTML scanning. No DOM, no `eval`, no network. A small hand-written
// scanner is used instead of a DOM parser so this module has zero dependencies and
// never executes any part of the analyzed page.

const NAV_CALL_RE = /location\s*\.\s*href\s*=\s*|location\s*\.\s*assign\s*\(\s*|location\s*\.\s*replace\s*\(\s*|window\s*\.\s*open\s*\(\s*/g;
const OPEN_TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*\/?>/gd;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const A_RE = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
const AREA_RE = /<area\b([^>]*)\/?>/gi;
const FORM_RE = /<form\b([^>]*)>([\s\S]*?)<\/form\s*>/gi;
const META_RE = /<meta\b([^>]*)\/?>/gi;
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gid;

function maskComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\n]/g, " "));
}

function buildLineIndex(text) {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) offsets.push(i + 1);
  return offsets;
}

function lineForOffset(offsets, index) {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function parseAttrs(attrString) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(attrString))) {
    const name = m[1].toLowerCase();
    attrs[name] = m[2] !== undefined ? m[2] : m[3];
  }
  return attrs;
}

function stripTags(text) {
  return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function truncateLabel(text) {
  const trimmed = (text ?? "").trim();
  return trimmed.length > 80 ? trimmed.slice(0, 80) : trimmed;
}

function isSkippableHref(value) {
  if (typeof value !== "string") return true;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return true;
  if (/^javascript:/i.test(trimmed)) return true;
  if (/^mailto:/i.test(trimmed)) return true;
  if (/^tel:/i.test(trimmed)) return true;
  return false;
}

function elementText(masked, tagName, openTagEnd) {
  const closeRe = new RegExp(`</${tagName}\\s*>`, "i");
  const rest = masked.slice(openTagEnd, openTagEnd + 4000);
  const idx = rest.search(closeRe);
  if (idx < 0) return "";
  return truncateLabel(stripTags(rest.slice(0, idx)));
}

/** Scans `text` for a location/window.open navigation call. String literal arguments become
 * transitions; anything else (a variable, concatenation, template literal) becomes an `unknown`
 * entry so the caller can surface it rather than silently miss a dynamic transition. */
function scanNavigationCalls(text, baseOffset, offsets, kind, label, transitions, unknown) {
  NAV_CALL_RE.lastIndex = 0;
  let m;
  while ((m = NAV_CALL_RE.exec(text))) {
    const after = text.slice(m.index + m[0].length);
    const literal = /^(['"])((?:(?!\1)[^\\]|\\.)*)\1/.exec(after);
    const absoluteIndex = baseOffset + m.index;
    const line = lineForOffset(offsets, absoluteIndex);
    if (literal) {
      const value = literal[2].replace(/\\(.)/g, "$1");
      transitions.push({ kind, target: value, label, line });
    } else {
      const snippet = (m[0] + after).slice(0, 60).replace(/\s+/g, " ").trim();
      unknown.push({ kind, line, snippet });
    }
  }
}

function anchorLabel(attrs, inner) {
  const text = truncateLabel(stripTags(inner));
  if (text) return text;
  if (attrs["aria-label"]) return truncateLabel(attrs["aria-label"]);
  if (attrs.title) return truncateLabel(attrs.title);
  const imgAlt = /<img\b[^>]*\balt\s*=\s*"([^"]*)"/i.exec(inner) ?? /<img\b[^>]*\balt\s*=\s*'([^']*)'/i.exec(inner);
  if (imgAlt?.[1]) return truncateLabel(imgAlt[1]);
  return "";
}

function formLabel(attrs, inner) {
  const button = /<button\b([^>]*)>([\s\S]*?)<\/button\s*>/i.exec(inner);
  if (button) {
    const buttonAttrs = parseAttrs(button[1]);
    if ((buttonAttrs.type ?? "submit").toLowerCase() !== "button") {
      const text = truncateLabel(stripTags(button[2]));
      if (text) return text;
    }
  }
  const submitInput = /<input\b([^>]*)>/gi;
  let match;
  while ((match = submitInput.exec(inner))) {
    const inputAttrs = parseAttrs(match[1]);
    if ((inputAttrs.type ?? "").toLowerCase() === "submit" && inputAttrs.value) return truncateLabel(inputAttrs.value);
  }
  if (attrs.name) return attrs.name;
  if (attrs.id) return attrs.id;
  return "フォーム";
}

const SCRIPT_MIME_ALLOWLIST = new Set(["", "text/javascript", "application/javascript", "module"]);

/**
 * Extracts every static navigation transition from one HTML document. Never opens, fetches,
 * or evaluates the page - this is a pure text scan.
 */
export function extractTransitions(html, { filePath } = {}) {
  void filePath;
  const masked = maskComments(html);
  const offsets = buildLineIndex(masked);
  const transitions = [];
  const unknown = [];

  A_RE.lastIndex = 0;
  let m;
  while ((m = A_RE.exec(masked))) {
    const attrs = parseAttrs(m[1]);
    if (isSkippableHref(attrs.href)) continue;
    transitions.push({ kind: "a", target: attrs.href, label: anchorLabel(attrs, m[2]), line: lineForOffset(offsets, m.index) });
  }

  AREA_RE.lastIndex = 0;
  while ((m = AREA_RE.exec(masked))) {
    const attrs = parseAttrs(m[1]);
    if (isSkippableHref(attrs.href)) continue;
    const label = truncateLabel(attrs["aria-label"] ?? attrs.title ?? attrs.alt ?? "");
    transitions.push({ kind: "area", target: attrs.href, label, line: lineForOffset(offsets, m.index) });
  }

  FORM_RE.lastIndex = 0;
  while ((m = FORM_RE.exec(masked))) {
    const attrs = parseAttrs(m[1]);
    const action = attrs.action;
    const hasAction = typeof action === "string" && action.trim() !== "" && !isSkippableHref(action);
    transitions.push({
      kind: "form",
      target: hasAction ? action : "",
      label: formLabel(attrs, m[2]),
      line: lineForOffset(offsets, m.index),
      self: !hasAction,
    });
  }

  META_RE.lastIndex = 0;
  while ((m = META_RE.exec(masked))) {
    const attrs = parseAttrs(m[1]);
    if ((attrs["http-equiv"] ?? "").toLowerCase() !== "refresh") continue;
    const content = (attrs.content ?? "").trim();
    const urlMatch = /url\s*=\s*(.+)$/i.exec(content);
    if (!urlMatch) continue;
    const url = urlMatch[1].trim().replace(/^['"]|['"]$/g, "");
    if (isSkippableHref(url)) continue;
    transitions.push({ kind: "meta-refresh", target: url, label: "自動遷移", line: lineForOffset(offsets, m.index) });
  }

  SCRIPT_RE.lastIndex = 0;
  while ((m = SCRIPT_RE.exec(masked))) {
    const attrs = parseAttrs(m[1]);
    const type = (attrs.type ?? "").toLowerCase();
    if (!SCRIPT_MIME_ALLOWLIST.has(type)) continue;
    const contentStart = m.indices[2][0];
    scanNavigationCalls(m[2], contentStart, offsets, "script", "script", transitions, unknown);
  }

  OPEN_TAG_RE.lastIndex = 0;
  while ((m = OPEN_TAG_RE.exec(masked))) {
    const tagName = m[1].toLowerCase();
    if (tagName === "script" || tagName === "style") continue;
    const attrs = parseAttrs(m[2]);
    const openEnd = m.index + m[0].length;
    const line = lineForOffset(offsets, m.index);

    const dataHref = attrs["data-href"] ?? attrs["data-navigate"] ?? attrs["data-link"];
    if (dataHref !== undefined && !isSkippableHref(dataHref)) {
      const label = elementText(masked, tagName, openEnd) || truncateLabel(attrs["aria-label"] ?? attrs.title ?? "");
      transitions.push({ kind: "data-attribute", target: dataHref, label, line });
    }

    for (const [name, value] of Object.entries(attrs)) {
      if (!/^on[a-z]+$/.test(name) || !value) continue;
      const label = elementText(masked, tagName, openEnd) || truncateLabel(attrs["aria-label"] ?? attrs.title ?? "");
      scanNavigationCalls(value, m.indices[2][0], buildLineIndex(masked), "script", label || "script", transitions, unknown);
    }
  }

  return { transitions, unknown };
}
