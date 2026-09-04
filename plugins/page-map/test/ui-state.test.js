import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const stagePath = fileURLToPath(new URL("../ui/stage.ui.json", import.meta.url));
const browserModulePath = fileURLToPath(new URL("../ui/page-map.js", import.meta.url));
const stage = JSON.parse(readFileSync(stagePath, "utf8"));

function stateFor(node) {
  const operands = node.when?.eq;
  return operands?.[0]?.path === "/analysis_state" ? operands[1]?.literal : null;
}

test("declarative UI separates ready, empty, unsupported, incomplete, and query-error states", () => {
  const children = stage.root.children;
  const header = children.find((node) => node.props?.variant?.literal === "page-map-header");
  const counts = header.children.filter((node) => node.type === "count");
  const refresh = header.children.find((node) => node.id === "page-map-refresh");
  const canvas = children.find((node) => node.id === "page-map-canvas");
  const emptyStates = children.filter((node) => node.type === "empty-state");

  assert.equal(counts.length, 3);
  assert.ok(counts.every((node) => stateFor(node) === "ready"));
  assert.deepEqual(refresh.when.in[1].literal, ["ready", "empty", "incomplete"]);
  assert.equal(stateFor(canvas), "ready");
  assert.deepEqual(emptyStates.map(stateFor).filter(Boolean).sort(), ["empty", "incomplete", "unsupported"]);
  assert.ok(emptyStates.some((node) => node.when?.not?.exists?.path === "/analysis_state"));
});

test("browser module mounts only the declared page-map canvas", () => {
  const source = readFileSync(browserModulePath, "utf8");
  assert.match(source, /root\.querySelector\('\[data-definition-id="page-map-canvas"\]'\)/);
  assert.doesNotMatch(source, /querySelectorAll\("\.vr-panel"\)/);
});
