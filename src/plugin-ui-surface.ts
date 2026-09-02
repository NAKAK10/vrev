import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { DEFAULT_LAYOUT_SETTINGS, layoutSettingsRevision, readLayoutSettings, type LayoutCornerV1, type LayoutSettingsFile } from "./layout-settings.js";
import { installedPluginDirectory, listPlugins } from "./plugin-registry.js";
import { effectivePluginSettings } from "./plugin-settings.js";
import { parsePluginUiDocument, type PluginUiDocumentV1, type PluginUiNodeV1 } from "./plugin-ui-document.js";
import { PLUGIN_UI_CORE_SLOTS, type PluginUiCoreSlotV1, type PluginUiExtensionEventSchemaV1, type PluginUiExtensionPointV1 } from "./plugin-manifest.js";

export interface PluginUiSurfaceContributionV1 {
  plugin_id: string;
  plugin_version: string;
  id: string;
  /** A Core slot, or the id of an extension point resolved from an enabled plugin's `ui.extension_points`. */
  slot: string;
  order: number;
  title: string;
  document: PluginUiDocumentV1;
  browser_module_url?: string;
}

/** An extension point hosted by an enabled plugin, resolved for the current workspace. */
export interface PluginUiSurfaceExtensionPointV1 {
  id: string;
  plugin_id: string;
  title: string;
  description?: string;
  context_schema: Readonly<Record<string, unknown>>;
  form_fields: string[];
  events: PluginUiExtensionEventSchemaV1;
  max_contributions?: number;
}

export interface PluginUiSurfaceDiagnosticV1 {
  plugin_id: string;
  contribution_id: string;
  code: "INVALID_DOCUMENT" | "UNAVAILABLE";
  message: string;
}

export interface PluginUiSurfaceLayoutItemV1 {
  key: string;
  plugin_id: string;
  contribution_id: string;
  title: string;
}

export interface PluginUiSurfaceLayoutV1 {
  revision: string;
  sidebar: "present" | "absent";
  stage: "split" | "expanded";
  header_items: PluginUiSurfaceLayoutItemV1[];
  sidebar_items: PluginUiSurfaceLayoutItemV1[];
  stage_views: PluginUiSurfaceLayoutItemV1[];
  active_stage: string | null;
  stage_switcher_position: LayoutCornerV1;
  /** The key of the `review.stage` contribution whose document contains a `target-stage` node, or
   * `null` when no enabled stage hosts one. Used by the renderer to apply a `?page=` deep link. */
  target_stage_key: string | null;
}

export interface PluginUiSurfaceV1 {
  schema_version: 1;
  renderer_api_version: 1;
  bridge_api_version: 1;
  contributions: PluginUiSurfaceContributionV1[];
  extension_points: PluginUiSurfaceExtensionPointV1[];
  diagnostics: PluginUiSurfaceDiagnosticV1[];
  layout: PluginUiSurfaceLayoutV1;
  page?: { title: string };
}

function contributionKey(contribution: Pick<PluginUiSurfaceContributionV1, "plugin_id" | "id">): string {
  return `${contribution.plugin_id}/${contribution.id}`;
}

function toLayoutItem(contribution: PluginUiSurfaceContributionV1): PluginUiSurfaceLayoutItemV1 {
  return {
    key: contributionKey(contribution),
    plugin_id: contribution.plugin_id,
    contribution_id: contribution.id,
    title: contribution.title,
  };
}

function compareByManifestOrder(left: PluginUiSurfaceContributionV1, right: PluginUiSurfaceContributionV1): number {
  return left.order - right.order || left.plugin_id.localeCompare(right.plugin_id) || left.id.localeCompare(right.id);
}

function compareByLayoutOrder(order: string[]): (left: PluginUiSurfaceContributionV1, right: PluginUiSurfaceContributionV1) => number {
  return (left, right) => {
    const leftIndex = order.indexOf(contributionKey(left));
    const rightIndex = order.indexOf(contributionKey(right));
    if (leftIndex >= 0 && rightIndex >= 0) return leftIndex - rightIndex;
    if (leftIndex >= 0) return -1;
    if (rightIndex >= 0) return 1;
    return compareByManifestOrder(left, right);
  };
}

/** Whether a document's node tree contains a `target-stage` node anywhere. */
function containsTargetStage(node: PluginUiNodeV1): boolean {
  if (node.type === "target-stage") return true;
  return (node.children ?? []).some(containsTargetStage);
}

/** Asserts that every `slot` node in a plugin document targets an extension point the plugin itself declares. */
function assertSlotNodes(node: PluginUiNodeV1, ownPointIds: ReadonlySet<string>): void {
  if (node.type === "slot") {
    const name = node.props?.name;
    const literal = typeof name === "object" && name !== null ? (name as Record<string, unknown>).literal : undefined;
    if (typeof literal !== "string") throw new Error("slot node name must be a literal string");
    if (!ownPointIds.has(literal)) throw new Error(`slot ${literal} is not declared in ui.extension_points`);
  }
  for (const child of node.children ?? []) assertSlotNodes(child, ownPointIds);
}

/** Loads static UI documents only. This function never imports a plugin module. */
export function loadPluginUiSurface(workspace = process.cwd()): PluginUiSurfaceV1 {
  const contributions: PluginUiSurfaceContributionV1[] = [];
  const diagnostics: PluginUiSurfaceDiagnosticV1[] = [];
  const extensionPoints: PluginUiSurfaceExtensionPointV1[] = [];
  const extensionPointOwners = new Map<string, string>();
  for (const plugin of listPlugins(workspace)) {
    if (plugin.manifest.schema_version !== 4 || !plugin.manifest.ui || !effectivePluginSettings(plugin.manifest, workspace).enabled) continue;
    const pluginRoot = installedPluginDirectory(plugin.id, workspace);

    // An extension point id must start with its declaring plugin's id, so two enabled plugins cannot
    // declare the same id in practice; the first one in registry order still wins defensively.
    const ownPointIds = new Set<string>();
    for (const point of plugin.manifest.ui.extension_points ?? []) {
      ownPointIds.add(point.id);
      const owner = extensionPointOwners.get(point.id);
      if (owner !== undefined) {
        diagnostics.push({
          plugin_id: plugin.id,
          contribution_id: point.id,
          code: "UNAVAILABLE",
          message: `extension point ${point.id} is already declared by plugin ${owner}`,
        });
        continue;
      }
      extensionPointOwners.set(point.id, plugin.id);
      extensionPoints.push({
        id: point.id,
        plugin_id: plugin.id,
        title: point.title,
        ...(point.description === undefined ? {} : { description: point.description }),
        context_schema: point.context_schema,
        form_fields: point.form_fields,
        events: point.events,
        ...(point.max_contributions === undefined ? {} : { max_contributions: point.max_contributions }),
      });
    }

    for (const contribution of plugin.manifest.ui.contributions) {
      try {
        const candidate = safeContributionFile(pluginRoot, contribution.document);
        const bytes = readFileSync(candidate);
        let value: unknown;
        try { value = JSON.parse(bytes.toString("utf8")) as unknown; }
        catch { throw new Error("plugin UI document is not valid JSON"); }
        if (contribution.browser_module) safeContributionFile(pluginRoot, contribution.browser_module);
        const document = parsePluginUiDocument(value, bytes.byteLength);
        assertSlotNodes(document.root, ownPointIds);
        contributions.push({
          plugin_id: plugin.id,
          plugin_version: plugin.version,
          id: contribution.id,
          slot: contribution.slot,
          order: contribution.order,
          title: contribution.title ?? plugin.manifest.display?.title ?? plugin.id,
          document,
          ...(contribution.browser_module ? { browser_module_url: `/api/plugin-host/v1/plugins/${encodeURIComponent(plugin.id)}/ui-modules/${encodeURIComponent(contribution.id)}` } : {}),
        });
      } catch (error) {
        diagnostics.push({
          plugin_id: plugin.id,
          contribution_id: contribution.id,
          code: "INVALID_DOCUMENT",
          message: error instanceof Error ? error.message : "plugin UI document is invalid",
        });
      }
    }
  }

  for (const deprecated of contributions.filter(({ slot }) => slot === "review.main")) {
    diagnostics.push({
      plugin_id: deprecated.plugin_id,
      contribution_id: deprecated.id,
      code: "UNAVAILABLE",
      message: "review.main is no longer rendered; migrate to review.stage",
    });
    contributions.splice(contributions.indexOf(deprecated), 1);
  }

  // A contribution may target an extension point of any enabled plugin, so its slot can only be
  // resolved after every plugin has been visited.
  for (const contribution of contributions.filter(({ slot }) => !PLUGIN_UI_CORE_SLOTS.has(slot as PluginUiCoreSlotV1) && !extensionPointOwners.has(slot))) {
    diagnostics.push({
      plugin_id: contribution.plugin_id,
      contribution_id: contribution.id,
      code: "UNAVAILABLE",
      message: `extension point ${contribution.slot} is not provided by any enabled plugin`,
    });
    contributions.splice(contributions.indexOf(contribution), 1);
  }

  for (const point of extensionPoints) {
    if (point.max_contributions === undefined) continue;
    const ordered = contributions.filter(({ slot }) => slot === point.id).sort(compareByManifestOrder);
    for (const exceeded of ordered.slice(point.max_contributions)) {
      diagnostics.push({
        plugin_id: exceeded.plugin_id,
        contribution_id: exceeded.id,
        code: "UNAVAILABLE",
        message: `extension point ${point.id} exceeds max_contributions`,
      });
      contributions.splice(contributions.indexOf(exceeded), 1);
    }
  }

  let settings: LayoutSettingsFile;
  try { settings = readLayoutSettings(workspace); }
  catch { settings = structuredClone(DEFAULT_LAYOUT_SETTINGS); }
  const revision = layoutSettingsRevision(settings);

  const baseline = [...contributions].sort(compareByManifestOrder);
  const headerItems = baseline.filter(({ slot }) => slot === "review.header").sort(compareByLayoutOrder(settings.header.order));
  const sidebarItems = baseline.filter(({ slot }) => slot === "review.sidebar").sort(compareByLayoutOrder(settings.sidebar.order));
  const stageItems = baseline.filter(({ slot }) => slot === "review.stage");

  const headerQueue = [...headerItems];
  const sidebarQueue = [...sidebarItems];
  const finalContributions = baseline.map((contribution) => {
    if (contribution.slot === "review.header") return headerQueue.shift()!;
    if (contribution.slot === "review.sidebar") return sidebarQueue.shift()!;
    return contribution;
  });

  const stageKeys = stageItems.map(contributionKey);
  const activeStage = settings.stage.active !== null && stageKeys.includes(settings.stage.active)
    ? settings.stage.active
    : (stageKeys[0] ?? null);

  const sidebarPresent = finalContributions.some(({ slot }) => slot === "review.sidebar");
  const targetStageContribution = [...stageItems].sort(compareByManifestOrder).find((contribution) => containsTargetStage(contribution.document.root));

  return {
    schema_version: 1,
    renderer_api_version: 1,
    bridge_api_version: 1,
    contributions: finalContributions,
    extension_points: extensionPoints,
    diagnostics,
    layout: {
      revision,
      sidebar: sidebarPresent ? "present" : "absent",
      stage: sidebarPresent ? "split" : "expanded",
      header_items: headerItems.map(toLayoutItem),
      sidebar_items: sidebarItems.map(toLayoutItem),
      stage_views: stageItems.map(toLayoutItem),
      active_stage: activeStage,
      stage_switcher_position: settings.stage.switcher_position,
      target_stage_key: targetStageContribution ? contributionKey(targetStageContribution) : null,
    },
  };
}

export function resolvePluginBrowserModule(pluginId: string, contributionId: string, workspace = process.cwd()): string {
  const plugin = listPlugins(workspace).find(({ id }) => id === pluginId);
  if (!plugin || plugin.manifest.schema_version !== 4 || !effectivePluginSettings(plugin.manifest, workspace).enabled) throw new Error("plugin UI runtime is unavailable");
  const contribution = plugin.manifest.ui?.contributions.find(({ id }) => id === contributionId);
  if (!contribution?.browser_module) throw new Error("plugin UI runtime is unavailable");
  return safeContributionFile(installedPluginDirectory(plugin.id, workspace), contribution.browser_module);
}

function safeContributionFile(pluginRoot: string, reference: string): string {
  const relative = reference.slice(2).split("/");
  const candidate = path.join(pluginRoot, ...relative);
  if (lstatSync(candidate).isSymbolicLink() || !statSync(candidate).isFile()) throw new Error("plugin UI document must be a regular file without symbolic links");
  const realRoot = realpathSync(pluginRoot);
  const realCandidate = realpathSync(candidate);
  if (realCandidate !== path.join(realRoot, ...relative)) throw new Error("plugin UI document path is unsafe");
  return realCandidate;
}
