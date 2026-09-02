import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureDefaultPlugins } from "../src/cli.js";
import { installPlugin, layoutSettingsPath, loadPluginUiSurface, updateLayoutSettings, type LayoutSettingsUpdateInput } from "../src/index.js";
import type { PluginUiSlotV1 } from "../src/plugin-manifest.js";

function workspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "visual-review-ui-surface-"));
  mkdirSync(path.join(root, ".git"));
  return root;
}

const MINIMAL_DOCUMENT = JSON.stringify({ schema_version: 1, root: { type: "app-shell", children: [] } });

interface FixtureContribution {
  id: string;
  slot: PluginUiSlotV1;
  order?: number;
  title?: string;
  browserModule?: boolean;
}

async function installFixturePlugin(root: string, id: string, contributions: FixtureContribution[]): Promise<void> {
  const source = path.join(root, "sources", id);
  mkdirSync(path.join(source, "ui"), { recursive: true });
  writeFileSync(path.join(source, "README.md"), "# Fixture\n");
  for (const contribution of contributions) {
    writeFileSync(path.join(source, `ui/${contribution.id}.json`), MINIMAL_DOCUMENT);
    if (contribution.browserModule) writeFileSync(path.join(source, `ui/${contribution.id}.js`), "export function mount(){ return () => {}; }\n");
  }
  writeFileSync(path.join(source, "visual-review.plugin.json"), JSON.stringify({
    schema_version: 4,
    id,
    version: "1.0.0",
    display: { title: id, summary: "UI surface fixture", readme: "./README.md" },
    configuration: [],
    ui: {
      renderer_api_version: 1,
      bridge_api_version: 1,
      contributions: contributions.map((contribution, index) => ({
        id: contribution.id,
        slot: contribution.slot,
        document: `./ui/${contribution.id}.json`,
        ...(contribution.browserModule ? { browser_module: `./ui/${contribution.id}.js` } : {}),
        order: contribution.order ?? index,
        ...(contribution.title ? { title: contribution.title } : {}),
      })),
    },
  }));
  await installPlugin(source, root);
}

function saveLayout(root: string, input: Omit<LayoutSettingsUpdateInput, "revision">): void {
  const surface = loadPluginUiSurface(root);
  updateLayoutSettings({ revision: surface.layout.revision, ...input }, root);
}

test("bundled default plugins populate the header, sidebar, and stage slots", async () => {
  const root = workspace();
  await ensureDefaultPlugins(root);
  const surface = loadPluginUiSurface(root);

  assert.ok(surface.layout.header_items.some(({ key }) => key === "review/review-header"));
  assert.ok(surface.layout.sidebar_items.some(({ key }) => key === "annotation-workflow/review-sidebar"));
  assert.deepEqual(surface.layout.stage_views.map(({ key }) => key), ["review/review-stage"]);
  assert.equal(surface.layout.active_stage, "review/review-stage");
  assert.equal(surface.layout.stage_switcher_position, "bottom-right");
  assert.equal(typeof surface.layout.revision, "string");
  assert.ok(surface.layout.revision.length > 0);

  const header = surface.contributions.find(({ slot }) => slot === "review.header");
  assert.equal(header?.title, "レビュー操作");
});

test("layout settings order reorders header and sidebar contributions", async () => {
  const root = workspace();
  await installFixturePlugin(root, "alpha", [
    { id: "header-a", slot: "review.header", order: 0 },
    { id: "sidebar-a", slot: "review.sidebar", order: 0 },
  ]);
  await installFixturePlugin(root, "beta", [
    { id: "header-b", slot: "review.header", order: 0 },
    { id: "sidebar-b", slot: "review.sidebar", order: 0 },
  ]);

  const initial = loadPluginUiSurface(root);
  assert.deepEqual(initial.layout.header_items.map(({ key }) => key), ["alpha/header-a", "beta/header-b"]);

  saveLayout(root, {
    header: { order: ["beta/header-b", "alpha/header-a"] },
    sidebar: { order: ["beta/sidebar-b"] },
  });

  const reordered = loadPluginUiSurface(root);
  assert.deepEqual(reordered.layout.header_items.map(({ key }) => key), ["beta/header-b", "alpha/header-a"]);
  assert.deepEqual(
    reordered.contributions.filter(({ slot }) => slot === "review.header").map((item) => `${item.plugin_id}/${item.id}`),
    ["beta/header-b", "alpha/header-a"],
  );
  // sidebar/sidebar-b is named first; the unnamed alpha/sidebar-a falls back to manifest order after it.
  assert.deepEqual(reordered.layout.sidebar_items.map(({ key }) => key), ["beta/sidebar-b", "alpha/sidebar-a"]);
});

test("a review.main contribution is dropped with an UNAVAILABLE diagnostic", async () => {
  const root = workspace();
  await installFixturePlugin(root, "legacy", [{ id: "legacy-main", slot: "review.main" }]);

  const surface = loadPluginUiSurface(root);
  assert.equal(surface.contributions.some(({ slot }) => slot === "review.main"), false);
  assert.deepEqual(surface.diagnostics, [{
    plugin_id: "legacy",
    contribution_id: "legacy-main",
    code: "UNAVAILABLE",
    message: "review.main is no longer rendered; migrate to review.stage",
  }]);
});

test("active_stage follows layout settings and falls back to the first declared stage view", async () => {
  const root = workspace();
  await installFixturePlugin(root, "views", [
    { id: "stage-one", slot: "review.stage", order: 0, browserModule: true },
    { id: "stage-two", slot: "review.stage", order: 1 },
  ]);

  const initial = loadPluginUiSurface(root);
  assert.equal(initial.layout.active_stage, "views/stage-one");
  assert.deepEqual(initial.layout.stage_views.map(({ key }) => key), ["views/stage-one", "views/stage-two"]);

  saveLayout(root, { stage: { active: "views/stage-two" } });
  const switched = loadPluginUiSurface(root);
  assert.equal(switched.layout.active_stage, "views/stage-two");

  saveLayout(root, { stage: { active: null } });
  const fallenBack = loadPluginUiSurface(root);
  assert.equal(fallenBack.layout.active_stage, "views/stage-one");
});

test("falls back to default layout settings when the persisted file is malformed", async () => {
  const root = workspace();
  await installFixturePlugin(root, "solo", [{ id: "header-only", slot: "review.header" }]);
  mkdirSync(path.dirname(layoutSettingsPath(root)), { recursive: true });
  writeFileSync(layoutSettingsPath(root), "not valid json");

  const surface = loadPluginUiSurface(root);
  assert.equal(surface.layout.stage_switcher_position, "bottom-right");
  assert.deepEqual(surface.layout.header_items.map(({ key }) => key), ["solo/header-only"]);
});
