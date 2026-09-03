// Unit tests for the canvas camera model and layout, imported from the browser module. The module
// deliberately performs no DOM access at module scope, so these pure helpers load in plain Node.

import assert from "node:assert/strict";
import test from "node:test";

import { centerOn, fitTransform, layoutNodes, targetPreviewUrl, zoomAt } from "../ui/page-map.js";

/** World coordinate currently displayed at a viewport coordinate under the given camera. */
function worldAt(camera, viewportX, viewportY) {
  return { x: (viewportX - camera.tx) / camera.k, y: (viewportY - camera.ty) / camera.k };
}

test("zoomAt keeps the world point under the cursor fixed", () => {
  for (const camera of [{ tx: 0, ty: 0, k: 1 }, { tx: -320, ty: 145, k: 0.42 }, { tx: 88, ty: -12, k: 2.5 }]) {
    for (const [pointerX, pointerY] of [[0, 0], [137, 96], [640, 400]]) {
      for (const factor of [1.25, 0.8, 2, 0.5]) {
        const before = worldAt(camera, pointerX, pointerY);
        const next = zoomAt(camera, factor, pointerX, pointerY);
        const after = worldAt(next, pointerX, pointerY);
        assert.ok(Math.abs(before.x - after.x) < 1e-9, `x drifted: ${before.x} -> ${after.x}`);
        assert.ok(Math.abs(before.y - after.y) < 1e-9, `y drifted: ${before.y} -> ${after.y}`);
      }
    }
  }
});

test("zoomAt clamps the scale to the allowed range", () => {
  assert.equal(zoomAt({ tx: 0, ty: 0, k: 1 }, 100, 10, 10, 0.05, 4).k, 4);
  assert.equal(zoomAt({ tx: 0, ty: 0, k: 1 }, 0.0001, 10, 10, 0.05, 4).k, 0.05);
});

test("zoomAt is a no-op for the offset when the clamp cancels the zoom", () => {
  const camera = { tx: 42, ty: -17, k: 4 };
  const next = zoomAt(camera, 2, 300, 200, 0.05, 4);
  assert.equal(next.k, 4);
  assert.equal(next.tx, 42);
  assert.equal(next.ty, -17);
});

test("fitTransform centers the bounds in the viewport", () => {
  const bounds = { minX: 100, minY: 50, maxX: 900, maxY: 450 };
  const camera = fitTransform(bounds, 800, 600);
  const center = worldAt(camera, 400, 300);
  assert.ok(Math.abs(center.x - 500) < 1e-9);
  assert.ok(Math.abs(center.y - 250) < 1e-9);
});

test("fitTransform never exceeds maxScale and fits oversized bounds", () => {
  assert.equal(fitTransform({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 800, 600, 48, 1).k, 1);
  const wide = fitTransform({ minX: 0, minY: 0, maxX: 8000, maxY: 400 }, 800, 600, 48, 1);
  assert.ok(wide.k < 1);
  assert.ok(8000 * wide.k <= 800);
});

test("fitTransform stays finite for a zero-size bounds", () => {
  const camera = fitTransform({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, 800, 600);
  assert.ok(Number.isFinite(camera.k) && Number.isFinite(camera.tx) && Number.isFinite(camera.ty));
  assert.ok(camera.k > 0);
});

test("centerOn puts the rect center at the viewport center", () => {
  const camera = centerOn({ x: 900, y: 340, width: 320, height: 200 }, 640, 480, 0.75);
  const center = worldAt(camera, 320, 240);
  assert.ok(Math.abs(center.x - 1060) < 1e-9);
  assert.ok(Math.abs(center.y - 440) < 1e-9);
  assert.equal(camera.k, 0.75);
});

test("targetPreviewUrl encodes each segment and preserves separators", () => {
  assert.equal(targetPreviewUrl("a/b.html"), "/target/a/b.html");
  assert.equal(targetPreviewUrl("/a/b.html"), "/target/a/b.html");
  assert.equal(targetPreviewUrl("dir name/page one.html"), "/target/dir%20name/page%20one.html");
  assert.equal(targetPreviewUrl(".code/htmls/日本語/index.html"), "/target/.code/htmls/%E6%97%A5%E6%9C%AC%E8%AA%9E/index.html");
});

function page(path) {
  return { path, title: path, exists: true, reachable: true, in_count: 0, out_count: 0 };
}

test("layoutNodes never overlaps two frames and advances x per layer", () => {
  const layers = new Map([
    [0, [page("index.html")]],
    [1, [page("a.html"), page("b.html"), page("c.html")]],
    [2, [page("d.html")]],
  ]);
  const positions = [...layoutNodes(layers).values()];
  assert.equal(positions.length, 5);
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = i + 1; j < positions.length; j += 1) {
      const a = positions[i];
      const b = positions[j];
      const overlaps = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
      assert.equal(overlaps, false, `frames overlap: ${JSON.stringify(a.page.path)} / ${JSON.stringify(b.page.path)}`);
    }
  }
  const layout = layoutNodes(layers);
  assert.ok(layout.get("index.html").x < layout.get("a.html").x);
  assert.ok(layout.get("a.html").x < layout.get("d.html").x);
});
