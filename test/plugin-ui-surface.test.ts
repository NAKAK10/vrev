import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureDefaultPlugins } from "../src/cli.js";
import { installPlugin, layoutSettingsPath, loadPluginUiSurface, updateLayoutSettings, type LayoutSettingsUpdateInput } from "../src/index.js";

function workspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "visual-review-ui-surface-"));
  mkdirSync(path.join(root, ".git"));
  return root;
}

const MINIMAL_DOCUMENT = JSON.stringify({ schema_version: 1, root: { type: "app-shell", children: [] } });

/** A document whose root stack hosts the given extension point via a `slot` node. */
function slotHostDocument(extensionPointId: string): unknown {
  return { schema_version: 1, root: { type: "stack", children: [{ type: "slot", props: { name: { literal: extensionPointId } } }] } };
}

interface FixtureContribution {
  id: string;
  /** A Core slot, or the id of an extension point declared by an enabled plugin. */
  slot: string;
  order?: number;
  title?: string;
  browserModule?: boolean;
  /** Written as the contribution document instead of the minimal app-shell. */
  document?: unknown;
}

interface FixtureExtensionPoint {
  id: string;
  title?: string;
  maxContributions?: number;
}

async function installFixturePlugin(root: string, id: string, contributions: FixtureContribution[], extensionPoints: FixtureExtensionPoint[] = []): Promise<void> {
  const source = path.join(root, "sources", id);
  mkdirSync(path.join(source, "ui"), { recursive: true });
  writeFileSync(path.join(source, "README.md"), "# Fixture\n");
  for (const contribution of contributions) {
    writeFileSync(path.join(source, `ui/${contribution.id}.json`), contribution.document === undefined ? MINIMAL_DOCUMENT : JSON.stringify(contribution.document));
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
      ...(extensionPoints.length === 0 ? {} : { extension_points: extensionPoints.map((point) => ({
        id: point.id,
        title: point.title ?? point.id,
        context_schema: { type: "object", properties: {}, additionalProperties: false },
        ...(point.maxContributions === undefined ? {} : { max_contributions: point.maxContributions }),
      })) }),
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
  assert.deepEqual(surface.layout.stage_views.map(({ key }) => key), ["review/review-stage", "page-map/page-map-stage"]);
  assert.equal(surface.layout.active_stage, "review/review-stage");
  assert.equal(surface.layout.target_stage_key, "review/review-stage");
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

test("bundled Issue UI contributes directly to header and sidebar without workflow extension points", async () => {
  const root = workspace();
  await ensureDefaultPlugins(root);
  const surface = loadPluginUiSurface(root);

  const points = new Map(surface.extension_points.map((point) => [point.id, point]));
  assert.equal(points.get("review.overlays")?.plugin_id, "review");
  const commentDialog = points.get("review.comment-dialog.actions");
  assert.ok(commentDialog);
  assert.equal(commentDialog.plugin_id, "review");
  assert.deepEqual(commentDialog.form_fields, ["comment"]);
  assert.deepEqual(Object.keys(commentDialog.events), ["completed"]);
  assert.equal(commentDialog.max_contributions, 4);
  assert.equal(points.has("annotation-workflow.annotation.actions"), false);

  const issueSlots = new Map(surface.contributions.filter(({ plugin_id }) => plugin_id === "github-issue").map(({ id, slot }) => [id, slot]));
  assert.equal(issueSlots.get("issue-header"), "review.header");
  assert.equal(issueSlots.get("issue-sidebar"), "review.sidebar");
  assert.deepEqual(surface.diagnostics.filter(({ code }) => code === "UNAVAILABLE"), []);
});

test("a contribution targeting an unknown extension point is dropped with an UNAVAILABLE diagnostic", async () => {
  const root = workspace();
  await installFixturePlugin(root, "orphan", [{ id: "orphan-action", slot: "nowhere.actions" }]);

  const surface = loadPluginUiSurface(root);
  assert.equal(surface.contributions.some(({ id }) => id === "orphan-action"), false);
  assert.deepEqual(surface.diagnostics, [{
    plugin_id: "orphan",
    contribution_id: "orphan-action",
    code: "UNAVAILABLE",
    message: "extension point nowhere.actions is not provided by any enabled plugin",
  }]);
});

test("contributions beyond max_contributions are dropped in manifest order", async () => {
  const root = workspace();
  await installFixturePlugin(root, "host", [
    { id: "host-panel", slot: "review.header", document: slotHostDocument("host.actions") },
  ], [{ id: "host.actions", maxContributions: 1 }]);
  await installFixturePlugin(root, "first", [{ id: "guest-action", slot: "host.actions" }]);
  await installFixturePlugin(root, "second", [{ id: "guest-action", slot: "host.actions" }]);

  const surface = loadPluginUiSurface(root);
  assert.deepEqual(surface.contributions.filter(({ slot }) => slot === "host.actions").map(({ plugin_id }) => plugin_id), ["first"]);
  assert.deepEqual(surface.diagnostics, [{
    plugin_id: "second",
    contribution_id: "guest-action",
    code: "UNAVAILABLE",
    message: "extension point host.actions exceeds max_contributions",
  }]);
});

test("a document slot node the plugin does not declare is an INVALID_DOCUMENT", async () => {
  const root = workspace();
  await installFixturePlugin(root, "host", [
    { id: "host-panel", slot: "review.header", document: slotHostDocument("host.actions") },
  ], [{ id: "host.actions" }]);
  await installFixturePlugin(root, "impostor", [
    { id: "impostor-panel", slot: "review.header", document: slotHostDocument("host.actions") },
  ]);

  const surface = loadPluginUiSurface(root);
  assert.deepEqual(surface.contributions.map(({ id }) => id), ["host-panel"]);
  assert.deepEqual(surface.diagnostics, [{
    plugin_id: "impostor",
    contribution_id: "impostor-panel",
    code: "INVALID_DOCUMENT",
    message: "slot host.actions is not declared in ui.extension_points",
  }]);
});

test("a plugin can host an extension point that another plugin contributes to", async () => {
  const root = workspace();
  await installFixturePlugin(root, "host", [
    { id: "host-panel", slot: "review.header", document: slotHostDocument("host.actions") },
  ], [{ id: "host.actions" }]);
  await installFixturePlugin(root, "guest", [{ id: "guest-action", slot: "host.actions" }]);

  const surface = loadPluginUiSurface(root);
  assert.deepEqual(surface.diagnostics, []);
  assert.deepEqual(surface.extension_points, [{
    id: "host.actions",
    plugin_id: "host",
    title: "host.actions",
    context_schema: { type: "object", properties: {}, additionalProperties: false },
    form_fields: [],
    events: {},
  }]);
  const guestAction = surface.contributions.find(({ plugin_id, id }) => plugin_id === "guest" && id === "guest-action");
  assert.equal(guestAction?.slot, "host.actions");
});
