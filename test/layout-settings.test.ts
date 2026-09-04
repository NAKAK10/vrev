import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_LAYOUT_SETTINGS,
  layoutSettingsPath,
  layoutSettingsRevision,
  readLayoutSettings,
  updateLayoutSettings,
} from "../src/index.js";

function workspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vrev-layout-settings-"));
  mkdirSync(path.join(root, ".git"));
  return root;
}

test("defaults are returned when the layout settings file is missing", () => {
  const root = workspace();
  const settings = readLayoutSettings(root);
  assert.deepEqual(settings, DEFAULT_LAYOUT_SETTINGS);
  assert.equal(layoutSettingsPath(root), path.join(realpathSync(root), ".vrev/layout-settings.json"));
});

test("updates persist and reject a stale revision", () => {
  const root = workspace();
  const initial = readLayoutSettings(root);
  const revision = layoutSettingsRevision(initial);
  const updated = updateLayoutSettings({ revision, header: { order: ["review/review-header"] } }, root);
  assert.deepEqual(updated.settings.header.order, ["review/review-header"]);
  assert.notEqual(updated.revision, revision);

  assert.throws(() => updateLayoutSettings({ revision, sidebar: { order: [] } }, root), /layout settings revision conflict/);

  const persisted = JSON.parse(readFileSync(layoutSettingsPath(root), "utf8")) as { header: { order: string[] } };
  assert.deepEqual(persisted.header.order, ["review/review-header"]);
});

test("a partial update to stage.active alone leaves other fields untouched", () => {
  const root = workspace();
  const revision = layoutSettingsRevision(readLayoutSettings(root));
  const afterHeader = updateLayoutSettings({ revision, header: { order: ["review/review-header"] }, sidebar: { order: ["annotation-workflow/review-sidebar"] } }, root);
  const afterStage = updateLayoutSettings({ revision: afterHeader.revision, stage: { active: "review/review-stage" } }, root);
  assert.deepEqual(afterStage.settings.header.order, ["review/review-header"]);
  assert.deepEqual(afterStage.settings.sidebar.order, ["annotation-workflow/review-sidebar"]);
  assert.equal(afterStage.settings.stage.active, "review/review-stage");
  assert.equal(afterStage.settings.stage.switcher_position, "bottom-right");
});

test("rejects malformed layout settings shapes, enums, and patterns", () => {
  const root = workspace();
  const revision = layoutSettingsRevision(readLayoutSettings(root));
  assert.throws(() => updateLayoutSettings({ revision, header: { order: ["not-a-key"] } }, root), /invalid/);
  assert.throws(() => updateLayoutSettings({ revision, header: { order: ["Review/review-header"] } }, root), /invalid/);
  assert.throws(() => updateLayoutSettings({ revision, header: { order: ["review/review-header", "review/review-header"] } }, root), /duplicated/);
  assert.throws(() => updateLayoutSettings({ revision, stage: { switcher_position: "middle" as never } }, root), /invalid/);
  assert.throws(() => updateLayoutSettings({ revision, stage: { active: "bad key" } }, root), /invalid/);
  assert.throws(() => updateLayoutSettings({ revision, extra: true } as never, root), /unsupported field/);
  assert.throws(() => updateLayoutSettings({ revision, header: { order: [], extra: true } } as never, root), /unsupported field/);

  mkdirSync(path.dirname(layoutSettingsPath(root)), { recursive: true });
  writeFileSync(layoutSettingsPath(root), JSON.stringify({ schema_version: 2, header: { order: [] }, sidebar: { order: [] }, stage: { active: null, switcher_position: "bottom-right" } }));
  assert.throws(() => readLayoutSettings(root), /schema_version/);
});
