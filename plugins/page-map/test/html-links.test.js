import assert from "node:assert/strict";
import test from "node:test";

import { extractTransitions } from "../server/html-links.js";

test("extracts anchor, area, form, meta-refresh, data-attribute and script transitions", () => {
  const html = `<!doctype html><html><body>
<a href="./b.html">Bへ</a>
<a href="#">skip</a>
<a href="javascript:void(0)">skip</a>
<a href="mailto:a@example.com">skip</a>
<a href="https://example.com/ext">外部</a>
<area href="c.html" alt="Cへ" shape="rect">
<form action="submit.html"><button>送信</button></form>
<form><input type="submit" value="保存"></form>
<meta http-equiv="refresh" content="3; url=redirect.html">
<button data-href="d.html">Dへ</button>
<button onclick="location.href='e.html'">Eへ</button>
<script>
  location.assign("f.html");
  location.href = base + id;
  window.open("https://g.example/");
</script>
</body></html>`;
  const { transitions, unknown } = extractTransitions(html, { filePath: "x.html" });

  const byTarget = Object.fromEntries(transitions.map((entry) => [entry.target, entry]));
  assert.equal(byTarget["./b.html"].kind, "a");
  assert.equal(byTarget["./b.html"].label, "Bへ");
  assert.equal(byTarget["https://example.com/ext"].label, "外部");
  assert.equal(byTarget["c.html"].kind, "area");
  assert.equal(byTarget["c.html"].label, "Cへ");
  assert.equal(byTarget["submit.html"].kind, "form");
  assert.equal(byTarget["submit.html"].label, "送信");
  assert.equal(byTarget["redirect.html"].kind, "meta-refresh");
  assert.equal(byTarget["d.html"].kind, "data-attribute");
  assert.equal(byTarget["d.html"].label, "Dへ");
  assert.equal(byTarget["e.html"].kind, "script");
  assert.equal(byTarget["e.html"].label, "Eへ");
  assert.equal(byTarget["f.html"].kind, "script");

  const selfForm = transitions.find((entry) => entry.kind === "form" && entry.self);
  assert.ok(selfForm);
  assert.equal(selfForm.label, "保存");

  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].kind, "script");
  assert.match(unknown[0].snippet, /location\.href = base \+ id/);

  assert.equal(transitions.some(({ target }) => target === "#"), false);
  assert.equal(transitions.some(({ target }) => target?.startsWith("javascript:")), false);
  assert.equal(transitions.some(({ target }) => target?.startsWith("mailto:")), false);
});

test("skips content inside HTML comments", () => {
  const html = `<!-- <a href="hidden.html">hidden</a> -->\n<a href="visible.html">visible</a>`;
  const { transitions } = extractTransitions(html, { filePath: "x.html" });
  assert.deepEqual(transitions.map(({ target }) => target), ["visible.html"]);
});

test("reports line numbers", () => {
  const html = `line1\nline2\n<a href="target.html">Go</a>\n`;
  const { transitions } = extractTransitions(html, { filePath: "x.html" });
  assert.equal(transitions[0].line, 3);
});

test("form without action is a self edge", () => {
  const html = `<form><button type="submit">Save</button></form>`;
  const { transitions } = extractTransitions(html, { filePath: "x.html" });
  assert.equal(transitions[0].kind, "form");
  assert.equal(transitions[0].self, true);
});
