import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { installedPluginDirectory, listPlugins } from "./plugin-registry.js";
import { effectivePluginSettings } from "./plugin-settings.js";
import { parsePluginUiDocument, type PluginUiDocumentV1 } from "./plugin-ui-document.js";
import type { PluginUiSlotV1 } from "./plugin-manifest.js";

export interface PluginUiSurfaceContributionV1 {
  plugin_id: string;
  plugin_version: string;
  id: string;
  slot: PluginUiSlotV1;
  order: number;
  document: PluginUiDocumentV1;
  browser_module_url?: string;
}

export interface PluginUiSurfaceDiagnosticV1 {
  plugin_id: string;
  contribution_id: string;
  code: "INVALID_DOCUMENT" | "UNAVAILABLE";
  message: string;
}

export interface PluginUiSurfaceV1 {
  schema_version: 1;
  renderer_api_version: 1;
  bridge_api_version: 1;
  contributions: PluginUiSurfaceContributionV1[];
  diagnostics: PluginUiSurfaceDiagnosticV1[];
  layout: { sidebar: "present" | "absent"; stage: "split" | "expanded" };
}

/** Loads static UI documents only. This function never imports a plugin module. */
export function loadPluginUiSurface(workspace = process.cwd()): PluginUiSurfaceV1 {
  const contributions: PluginUiSurfaceContributionV1[] = [];
  const diagnostics: PluginUiSurfaceDiagnosticV1[] = [];
  for (const plugin of listPlugins(workspace)) {
    if (plugin.manifest.schema_version !== 4 || !plugin.manifest.ui || !effectivePluginSettings(plugin.manifest, workspace).enabled) continue;
    const pluginRoot = installedPluginDirectory(plugin.id, workspace);
    for (const contribution of plugin.manifest.ui.contributions) {
      try {
        const candidate = safeContributionFile(pluginRoot, contribution.document);
        const bytes = readFileSync(candidate);
        let value: unknown;
        try { value = JSON.parse(bytes.toString("utf8")) as unknown; }
        catch { throw new Error("plugin UI document is not valid JSON"); }
        if (contribution.browser_module) safeContributionFile(pluginRoot, contribution.browser_module);
        contributions.push({
          plugin_id: plugin.id,
          plugin_version: plugin.version,
          id: contribution.id,
          slot: contribution.slot,
          order: contribution.order,
          document: parsePluginUiDocument(value, bytes.byteLength),
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
  contributions.sort((left, right) => left.order - right.order || left.plugin_id.localeCompare(right.plugin_id) || left.id.localeCompare(right.id));
  const mains = contributions.filter(({ slot }) => slot === "review.main");
  if (mains.length > 1) {
    for (const conflict of mains.slice(1)) {
      diagnostics.push({ plugin_id: conflict.plugin_id, contribution_id: conflict.id, code: "UNAVAILABLE", message: "review.main is already provided" });
      contributions.splice(contributions.indexOf(conflict), 1);
    }
  }
  const sidebar = contributions.some(({ slot }) => slot === "review.sidebar");
  return {
    schema_version: 1,
    renderer_api_version: 1,
    bridge_api_version: 1,
    contributions,
    diagnostics,
    layout: { sidebar: sidebar ? "present" : "absent", stage: sidebar ? "split" : "expanded" },
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
