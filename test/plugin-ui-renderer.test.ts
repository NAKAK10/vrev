import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureDefaultPlugins } from "../src/cli.js";
import { installPlugin, loadPluginUiSurface, parsePluginUiDocument, pluginSettingsRevision, readPluginSettings, updatePluginSettings } from "../src/index.js";

function workspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "visual-review-renderer-"));
  mkdirSync(path.join(root, ".git"));
  return root;
}

test("normalizes enabled JSON contributions without evaluating plugin server modules", async () => {
  const root = workspace();
  const source = path.join(root, "fixture");
  mkdirSync(path.join(source, "ui"), { recursive: true });
  mkdirSync(path.join(source, "server"), { recursive: true });
  writeFileSync(path.join(source, "README.md"), "# Fixture\n");
  writeFileSync(path.join(source, "server/contract.json"), JSON.stringify({ schema_version: 1, queries: [], commands: [] }));
  writeFileSync(path.join(source, "server/index.js"), "import {writeFileSync} from 'node:fs'; writeFileSync(new URL('./evaluated', import.meta.url),'yes'); export default {};\n");
  writeFileSync(path.join(source, "ui/main.json"), JSON.stringify({ schema_version: 1, root: { type: "app-shell", children: [] } }));
  writeFileSync(path.join(source, "ui/runtime.js"), "export function mount(){ return () => {}; }\n");
  writeFileSync(path.join(source, "visual-review.plugin.json"), JSON.stringify({
    schema_version: 4, id: "fixture", version: "1.0.0",
    display: { title: "Fixture", summary: "Static UI fixture", readme: "./README.md" }, configuration: [],
    server: { api_version: 1, bridge_api_version: 1, module: "./server/index.js", contract: "./server/contract.json" },
    ui: { renderer_api_version: 1, bridge_api_version: 1, contributions: [{ id: "main", slot: "review.main", document: "./ui/main.json", browser_module: "./ui/runtime.js", order: 0 }] },
  }));
  const installed = await installPlugin(source, root);
  const surface = loadPluginUiSurface(root);
  assert.equal(surface.contributions.length, 1);
  assert.equal(surface.contributions[0]?.plugin_id, "fixture");
  assert.equal(surface.layout.stage, "expanded");
  assert.equal(surface.contributions[0]?.browser_module_url, "/api/plugin-host/v1/plugins/fixture/ui-modules/main");
  assert.equal(existsSync(path.join(installed.directory, "server/evaluated")), false);
});

test("disabled workflow contribution is absent and expands the target stage", async () => {
  const root = workspace();
  await ensureDefaultPlugins(root);
  const initial = loadPluginUiSurface(root);
  assert.equal(initial.contributions.some(({ slot }) => slot === "review.sidebar"), true);
  const workflow = (await import("../src/plugin-registry.js")).listPlugins(root).find(({ id }) => id === "annotation-workflow")!;
  updatePluginSettings("annotation-workflow", workflow.manifest, {
    revision: pluginSettingsRevision(readPluginSettings(root)), enabled: false, configuration: {},
  }, root);
  const disabled = loadPluginUiSurface(root);
  assert.equal(disabled.contributions.some(({ slot }) => slot === "review.sidebar"), false);
  assert.deepEqual(disabled.layout, { sidebar: "absent", stage: "expanded" });
});

test("renderer documents reject executable and unknown component properties", () => {
  assert.throws(() => parsePluginUiDocument({ schema_version: 1, root: { type: "text", props: { style: { literal: "position:fixed" } } } }), /forbidden/);
  assert.throws(() => parsePluginUiDocument({ schema_version: 1, root: { type: "button", props: { arbitrary: { literal: true } } } }), /unsupported field/);
  assert.throws(() => parsePluginUiDocument({ schema_version: 1, root: { type: "text", props: { line_clamp: { literal: 3 } } } }), /unsupported field/);
  assert.throws(() => parsePluginUiDocument({ schema_version: 1, root: { type: "button", on: { click: Array.from({ length: 17 }, () => ({ type: "local.toggle", path: "/open" })) } } }), /at most 16/);
});

test("browser runtime keeps declarative DOM Core-owned and mounts only declared plugin modules", () => {
  const source = readFileSync(path.join(process.cwd(), "src/ui/renderer.js"), "utf8");
  assert.match(source, /document\.createElement/);
  assert.match(source, /textContent/);
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|DOMParser|document\.write|\beval\s*\(|new Function/);
  assert.doesNotMatch(source, /document\.createElement\(["']script|src\s*=\s*[^;]*plugin/);
  assert.match(source, /import\(contribution\.browser_module_url\)/);
  assert.match(source, /typeof runtime\.mount !== "function"/);
  assert.match(source, /pluginRuntimeCleanups/);
  assert.match(source, /event\.isComposing/);
  assert.match(source, /aria-live/);
  assert.match(source, /focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(source, /allow-same-origin allow-forms allow-scripts/);
});

test("renderer acceptance paths scope repeated annotation actions and implement target regions, focus, dialogs, and pending controls", () => {
  const source = readFileSync(path.join(process.cwd(), "src/ui/renderer.js"), "utf8");
  assert.match(source, /definition\.repeat\.key/);
  assert.match(source, /instanceKey: \[scope\.instanceKey, repeatKey\]/);
  assert.match(source, /scope\.instanceKey \|\| "root".*instruction\.command/);
  assert.match(source, /pending\?\.disable/);
  assert.match(source, /result\.error\?\.code === "CONFLICT"/);
  assert.match(source, /await refreshResourceNamed\(revisionResource, scope\)/);
  assert.match(source, /result = await requestCommand\(\)/);
  assert.match(source, /for \(let attempt = 0; attempt < 2; attempt \+= 1\)/);
  assert.match(source, /body: JSON\.stringify\(envelope\)/);
  assert.match(source, /installHtmlSelection/);
  assert.match(source, /doc\.__vrSelectionCleanup\?\.\(\)/);
  assert.match(source, /doc\.removeEventListener\("pointerdown", pointerdown, true\)/);
  assert.match(source, /doc\.removeEventListener\("click", click, true\)/);
  assert.match(source, /mode !== "region"/);
  assert.match(source, /targetUrlForPage/);
  assert.match(source, /performance\.getEntriesByType\("navigation"\).*responseStatus/);
  assert.match(source, /対象ページが HTTP \$\{status\} を返しました/);
  assert.match(source, /unhandledrejection/);
  assert.match(source, /__dismissedTargetDiagnostics/);
  assert.match(source, /対象ページのエラー通知を閉じる/);
  assert.match(source, /role", options\.variant === "warning" \? "status" : "alert"/);
  assert.match(source, /target\.focus\.failed/);
  assert.match(source, /aria-labelledby/);
  assert.match(source, /aria-describedby/);
  assert.match(source, /dialogOpeners/);
  assert.match(source, /formDrafts/);
  assert.match(source, /previous\?\.events.*result\.data\?\.events/s);
  assert.match(source, /resourceRequestGenerations\.get\(key\) !== generation/);
  assert.match(source, /resources\.invalidated|synchronizeResources/);
  assert.match(source, /setInterval\(\(\) => \{ void fallbackSync\(\); \}, 2000\)/);
  assert.match(source, /別の画面での変更を同期しました/);
  assert.match(source, /function patchReviewTree\(nextTree\)/);
  assert.match(source, /sidebarScroll = currentSidebar \? \{ top: currentSidebar\.scrollTop, left: currentSidebar\.scrollLeft \}/);
  assert.match(source, /connectedSidebar\.scrollTop = sidebarScroll\.top/);
  assert.match(source, /const openDialog = document\.querySelector\("dialog\[open\]"\)/);
  assert.match(source, /deferredReviewRender.*addEventListener\("close".*rerender\(\)/s);
  assert.match(source, /if \(changed\) rerender\(\)/);
  assert.match(source, /targetIdentity\(currentStage\) !== targetIdentity\(nextStage\)/);
  assert.match(source, /if \(patchReviewTree\(nextTree\)\)/);
  assert.match(source, /node\.type = String\(values\.type\)/);
  assert.match(source, /container\.dataset\.viewport === "custom"/);
  assert.match(source, /frame\.style\.width = `\$\{container\.__viewportWidth\}px`/);
  assert.match(source, /currentStage\.__viewportWidth = nextStage\.__viewportWidth/);
  assert.doesNotMatch(source, /prepareExpandableText|expandedTextKeys|workflowExpandable|reviewViewportScale|installCustomViewportFit/);
  assert.match(source, /main\?\.browser_module_url.*mountPluginRuntime\(main, connectedMain\)/s);
  assert.match(source, /if \(rendered\.isConnected\) void mountPluginRuntime/);
});

test("Core styles plugin documents through semantic renderer tokens", () => {
  const source = readFileSync(path.join(process.cwd(), "src/ui/renderer.js"), "utf8");
  const css = readFileSync(path.join(process.cwd(), "src/ui/renderer.css"), "utf8");
  const html = readFileSync(path.join(process.cwd(), "src/ui/renderer.html"), "utf8");
  assert.match(html, /href="\/renderer\.css"/);
  assert.match(source, /const THEME_TOKENS = new Map/);
  assert.match(source, /rendered\.dataset\.pluginId = contribution\.plugin_id/);
  assert.match(source, /vr-field vr-field-\$\{type\}/);
  assert.match(css, /--vr-color-canvas:/);
  assert.match(css, /\.vr-plugin-row\s*\{/);
  assert.match(css, /\.vr-plugin-detail-content/);
  assert.doesNotMatch(css, /annotation-card"\]\.is-clickable:hover/);
  assert.match(css, /annotation-target"\]:hover[^}]*color: var\(--vr-color-text\)[^}]*background: transparent/s);
  for (const status of ["open", "in_progress", "failed", "addressed", "resolved"]) assert.match(css, new RegExp(`\\.vr-annotation-mark\\[data-status="${status}"\\]`));
  assert.match(css, /\.vr-target-diagnostic[^}]*z-index: 6/s);
  assert.match(css, /\.vr-target-diagnostic\.is-warning/);
  assert.match(css, /\.vr-target-diagnostic-close[^}]*pointer-events: auto/s);
  assert.match(css, /\.vr-target-stage\[data-viewport="custom"\] iframe[^}]*max-width: none/s);
  assert.match(css, /custom-viewport-size/);
  assert.doesNotMatch(css, /workflow-expandable|workflow-expanded|vr-line-clamp/);
  assert.match(css, /\.vr-node-hover-mark[^}]*border: 2px solid #2563eb/s);
  assert.match(css, /\.vr-annotation-mark\.is-preview[^}]*#7c3aed/s);
  assert.match(source, /dialog\[open\] \.vr-dialog-body/);
  assert.match(source, /dialogBody\.prepend\(region\)/);
  assert.match(source, /requestAnimationFrame\(paintToast\)/);
  assert.match(source, /variant === "info" \? 7000 : 12000/);
  assert.match(source, /let activeToast = null/);
  assert.match(source, /queueMicrotask\(paintToast\)/);
  assert.doesNotMatch(source, /style\.cssText|insertRule|adoptedStyleSheets/);
});

test("bundled review documents bind localized annotation content, filters, overlays, and scoped Issue dialogs", () => {
  const review = JSON.parse(readFileSync(path.join(process.cwd(), "plugins/review/ui/review.ui.json"), "utf8")) as unknown;
  const rendererSource = readFileSync(path.join(process.cwd(), "src/ui/renderer.js"), "utf8");
  const reviewRuntime = readFileSync(path.join(process.cwd(), "plugins/review/ui/review.js"), "utf8");
  const sidebarText = readFileSync(path.join(process.cwd(), "plugins/annotation-workflow/ui/sidebar.ui.json"), "utf8");
  const workflowRuntime = readFileSync(path.join(process.cwd(), "plugins/annotation-workflow/ui/sidebar.js"), "utf8");
  const workflowManifest = JSON.parse(readFileSync(path.join(process.cwd(), "plugins/annotation-workflow/visual-review.plugin.json"), "utf8")) as { ui: { contributions: Array<{ id: string; browser_module?: string }> } };
  const issueText = readFileSync(path.join(process.cwd(), "plugins/github-issue/ui/issue.ui.json"), "utf8");
  assert.doesNotThrow(() => parsePluginUiDocument(review));
  const reviewDocument = review as { local_state: Array<{ key: string; default: unknown; persist?: boolean }>; root: unknown };
  assert.equal(reviewDocument.local_state.find(({ key }) => key === "viewport_width")?.default, 1280);
  assert.equal(reviewDocument.local_state.find(({ key }) => key === "viewport_height")?.default, 720);
  assert.equal(reviewDocument.local_state.find(({ key }) => key === "viewport_width")?.persist, true);
  assert.match(JSON.stringify(reviewDocument.root), /"value":"custom","label":"カスタム"/);
  assert.match(JSON.stringify(reviewDocument.root), /"viewport_width"/);
  assert.match(JSON.stringify(reviewDocument.root), /"viewport_height"/);
  assert.match(JSON.stringify(reviewDocument.root), /"label":\{"literal":"再読み込み"\}[^]*"click":\[\{"type":"target.reload"\}\]/);
  assert.doesNotMatch(JSON.stringify(reviewDocument.root), /"label":\{"literal":"再読み込み"\}[^]*"click":\[\{"type":"resource.refresh"/);
  assert.match(sidebarText, /"aria_label": \{ "item": "\/comment" \}/);
  assert.match(sidebarText, /"label": \{ "item": "\/comment" \}/);
  assert.match(sidebarText, /"source": \{ "item": "\/thread" \}/);
  assert.match(sidebarText, /"kind_label"|\/kind_label/);
  assert.match(sidebarText, /"type": "checkbox-group"/);
  assert.match(sidebarText, /"id": "annotation-comment"/);
  assert.match(sidebarText, /"id": "thread-body"/);
  assert.equal(workflowManifest.ui.contributions.find(({ id }) => id === "review-sidebar")?.browser_module, "./ui/sidebar.js");
  assert.match(workflowRuntime, /-webkit-line-clamp/);
  assert.match(workflowRuntime, /event\.stopImmediatePropagation\(\)/);
  assert.match(workflowRuntime, /event\.key !== "Enter".*event\.key !== " "/);
  assert.match(workflowRuntime, /root\.addEventListener\("click", click, true\)/);
  assert.match(sidebarText, /"id": "batch-run".*"resource": "workflow-settings", "path": "\/auto_run".*"literal": false/);
  assert.match(sidebarText, /"id": "annotation-ai-run".*"item": "\/status".*"literal": "open".*"path": "\/auto_run".*"literal": true.*"label": \{ "literal": "AI修正" \}.*"command": "jobs\.enqueue".*"annotation_id": \{ "item": "\/id" \}/);
  assert.match(sidebarText, /"limit": \{ "literal": 24 \}/);
  assert.match(sidebarText, /"type": "target\.focus", "target": \{ "item": "\/page_path" \}/);
  assert.match(sidebarText, /"variant": \{ "literal": "annotation-target" \}/);
  assert.match(sidebarText, /"annotation_id": \{ "item": "\/id" \}/);
  assert.match(sidebarText, /"id": "force-resolve-dialog"/);
  assert.match(issueText, /"id": "issue-dialog"/);
  assert.match(issueText, /"label": \{ "literal": "キャンセル" \}/);
  assert.match(rendererSource, /vr-selection-mode-button/);
  assert.match(reviewRuntime, /function installCustomViewportFit\(root, stage, frame, layer\)/);
  assert.match(reviewRuntime, /Math\.min\(1, availableWidth \/ width, availableHeight \/ height\)/);
  assert.match(reviewRuntime, /frame\.style\.setProperty\("transform", `scale\(\$\{scale\}\)`\)/);
  assert.match(reviewRuntime, /stage\.dataset\.reviewViewportScale/);
  assert.match(reviewRuntime, /scaleAnnotationMarks\(layer, stage, frame, frameScale\)/);
  assert.match(rendererSource, /stage\.__target\?\.live_url \? new URL\(proxiedPath, stage\.__target\.live_url\)\.toString\(\)/);
  assert.match(rendererSource, /reviewSelection\.annotation_id = binding\(instruction\.annotation_id, scope\)/);
  assert.match(rendererSource, /resourceStores\.get\("annotation-workflow:annotations"\)\?\.data\?\.items/);
  assert.match(rendererSource, /anchor\?\.bounds \|\| anchor\?\.rect/);
  assert.match(rendererSource, /else if \(annotation\.anchor\?\.rect\)/);
  assert.match(rendererSource, /if \(status\) mark\.dataset\.status = status/);
  assert.match(rendererSource, /definition\.type === "panel" && eventName === "click"/);
  assert.match(rendererSource, /resourceStores\.get\("annotation-workflow:workflow-settings"\)\?\.data/);
  assert.match(rendererSource, /commands\/jobs\.enqueue/);
  assert.match(rendererSource, /instruction\.command === "annotation\.create"\) await autoRunNewAnnotation\(scope\)/);
  assert.match(rendererSource, /node\.classList\.add\("is-clickable"\); node\.tabIndex = 0/);
  assert.match(rendererSource, /aria-keyshortcuts/);
  assert.match(reviewRuntime, /\{ v: "browse", n: "node", r: "region" \}/);
  assert.match(reviewRuntime, /doc\.addEventListener\("keydown", keydown, true\)/);
  assert.match(reviewRuntime, /function enableVisibleInertNavigation\(doc, win\)/);
  assert.match(reviewRuntime, /node\.removeAttribute\("inert"\)/);
  assert.match(reviewRuntime, /node\.setAttribute\("inert", ""\)/);
  assert.match(reviewRuntime, /if \(!doc\.documentElement\)/);
  assert.match(reviewRuntime, /window\.setTimeout\(install, 16\)/);
});

test("bundled plugin UI documents stay JSON while declared browser modules are explicit local assets", async () => {
  const root = workspace();
  await ensureDefaultPlugins(root);
  const pluginsRoot = path.join(root, ".vreview/plugins");
  for (const id of ["review", "annotation-workflow", "github-issue", "custom-command"]) {
    const manifest = JSON.parse(readFileSync(path.join(pluginsRoot, id, "visual-review.plugin.json"), "utf8")) as { ui?: { contributions: Array<{ document: string; browser_module?: string }> } };
    for (const contribution of manifest.ui?.contributions ?? []) {
      assert.match(contribution.document, /^\.\/ui\/.*\.json$/);
      assert.equal(existsSync(path.join(pluginsRoot, id, contribution.document.slice(2))), true);
      if (contribution.browser_module) {
        const browserModule = contribution.browser_module;
        assert.match(browserModule, /^\.\/ui\/.*\.m?js$/);
        assert.equal(existsSync(path.join(pluginsRoot, id, browserModule.slice(2))), true);
      }
    }
  }
});
