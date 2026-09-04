import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureDefaultPlugins } from "../src/cli.js";
import { installPlugin, loadPluginUiSurface, parsePluginUiDocument, pluginSettingsRevision, readPluginSettings, updatePluginSettings } from "../src/index.js";

function workspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vrev-renderer-"));
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
  writeFileSync(path.join(source, "vrev.plugin.json"), JSON.stringify({
    schema_version: 4, id: "fixture", version: "1.0.0",
    display: { title: "Fixture", summary: "Static UI fixture", readme: "./README.md" }, configuration: [],
    server: { api_version: 1, bridge_api_version: 1, module: "./server/index.js", contract: "./server/contract.json" },
    ui: { renderer_api_version: 1, bridge_api_version: 1, contributions: [{ id: "main", slot: "review.sidebar", document: "./ui/main.json", browser_module: "./ui/runtime.js", order: 0 }] },
  }));
  const installed = await installPlugin(source, root);
  const surface = loadPluginUiSurface(root);
  assert.equal(surface.contributions.length, 1);
  assert.equal(surface.contributions[0]?.plugin_id, "fixture");
  assert.equal(surface.layout.stage, "split");
  assert.equal(surface.contributions[0]?.browser_module_url, "/api/plugin-host/v1/plugins/fixture/ui-modules/main");
  assert.equal(existsSync(path.join(installed.directory, "server/evaluated")), false);
});

test("review.main is deprecated and dropped with an UNAVAILABLE diagnostic even as the only contribution", async () => {
  const root = workspace();
  const source = path.join(root, "fixture");
  mkdirSync(path.join(source, "ui"), { recursive: true });
  writeFileSync(path.join(source, "README.md"), "# Fixture\n");
  writeFileSync(path.join(source, "ui/main.json"), JSON.stringify({ schema_version: 1, root: { type: "app-shell", children: [] } }));
  writeFileSync(path.join(source, "vrev.plugin.json"), JSON.stringify({
    schema_version: 4, id: "fixture", version: "1.0.0",
    display: { title: "Fixture", summary: "Static UI fixture", readme: "./README.md" }, configuration: [],
    ui: { renderer_api_version: 1, bridge_api_version: 1, contributions: [{ id: "main", slot: "review.main", document: "./ui/main.json", order: 0 }] },
  }));
  await installPlugin(source, root);
  const surface = loadPluginUiSurface(root);
  assert.equal(surface.contributions.length, 0);
  assert.equal(surface.diagnostics.some((diagnostic) => diagnostic.code === "UNAVAILABLE" && /review\.stage/.test(diagnostic.message)), true);
});

test("disabled workflow leaves the independent Issue sidebar available", async () => {
  const root = workspace();
  await ensureDefaultPlugins(root);
  const initial = loadPluginUiSurface(root);
  assert.equal(initial.contributions.some(({ slot }) => slot === "review.sidebar"), true);
  const workflow = (await import("../src/plugin-registry.js")).listPlugins(root).find(({ id }) => id === "annotation-workflow")!;
  updatePluginSettings("annotation-workflow", workflow.manifest, {
    revision: pluginSettingsRevision(readPluginSettings(root)), enabled: false, configuration: {},
  }, root);
  const disabled = loadPluginUiSurface(root);
  assert.equal(disabled.contributions.some(({ plugin_id, slot }) => plugin_id === "annotation-workflow" && slot === "review.sidebar"), false);
  assert.equal(disabled.contributions.some(({ plugin_id, slot }) => plugin_id === "github-issue" && slot === "review.sidebar"), true);
  assert.equal(disabled.layout.sidebar, "present");
  assert.equal(disabled.layout.stage, "split");
  assert.equal(typeof disabled.layout.revision, "string");
  assert.equal(disabled.layout.stage_switcher_position, "bottom-right");
  assert.deepEqual(disabled.layout.sidebar_items.map(({ key }) => key), ["github-issue/issue-sidebar"]);
  assert.equal(disabled.layout.header_items.some((item) => item.key === "review/review-header"), true);
  assert.equal(disabled.layout.active_stage, "review/review-stage");
  assert.deepEqual(disabled.layout.stage_views.map((item) => item.key), ["review/review-stage", "page-map/page-map-stage"]);
});

test("renderer documents reject executable and unknown component properties", () => {
  assert.throws(() => parsePluginUiDocument({ schema_version: 1, root: { type: "text", props: { style: { literal: "position:fixed" } } } }), /forbidden/);
  assert.throws(() => parsePluginUiDocument({ schema_version: 1, root: { type: "button", props: { arbitrary: { literal: true } } } }), /unsupported field/);
  assert.throws(() => parsePluginUiDocument({ schema_version: 1, root: { type: "text", props: { line_clamp: { literal: 3 } } } }), /unsupported field/);
  assert.throws(() => parsePluginUiDocument({ schema_version: 1, root: { type: "button", on: { click: Array.from({ length: 17 }, () => ({ type: "local.toggle", path: "/open" })) } } }), /at most 16/);
  assert.doesNotThrow(() => parsePluginUiDocument({ schema_version: 1, root: { type: "button", on: { click: [{ type: "selection.activate", mode: "node", on_commit: [{ type: "dialog.open", dialog: "editor" }] }] } } }));
  assert.throws(() => parsePluginUiDocument({ schema_version: 1, root: { type: "button", on: { click: [{ type: "selection.activate", mode: "browse", on_commit: [] }] } } }), /mode must be node or region/);
  assert.throws(() => parsePluginUiDocument({ schema_version: 1, root: { type: "button", on: { click: [{ type: "selection.activate", mode: "region" }] } } }), /on_commit is required/);
});

test("command start effects support validated dialog dismissal and declarative cross-plugin background work", () => {
  assert.doesNotThrow(() => parsePluginUiDocument({
    schema_version: 1,
    root: {
      type: "form",
      on: { submit: [{
        type: "command.execute", plugin: "worker", command: "work.start", when: { eq: [{ resource: "settings", plugin: "worker", path: "/enabled" }, { literal: true }] }, input: {},
        on_start: [{ type: "dialog.close", dialog: "editor" }],
      }] },
    },
  }));
  assert.throws(() => parsePluginUiDocument({ schema_version: 1, root: { type: "button", on: { click: [{ type: "command.execute", command: "work", input: {}, on_start: [{ type: "unknown" }] }] } } }), /unsupported/);

  const source = readFileSync(path.join(process.cwd(), "src/ui/renderer.js"), "utf8");
  assert.match(source, /if \(!node\.checkValidity\(\)\) \{ node\.reportValidity\(\); return; \}/);
  assert.match(source, /await execute\(instruction\.on_start \|\| \[\], scope\)/);
  assert.match(source, /const commandPlugin = instruction\.plugin \|\| scope\.plugin/);
  assert.match(source, /resource\.optimistic-append/);
  assert.match(source, /resource\.optimistic-patch/);
  assert.match(source, /Object\.assign\(owner, Object\.fromEntries/);
  assert.match(source, /Promise\.all\(invalidated\.map/);
  assert.doesNotMatch(source, /autoRunNewAnnotation|scope\.plugin === "review" && instruction\.command === "annotation\.create"/);

  const stage = JSON.parse(readFileSync(path.join(process.cwd(), "plugins/review/ui/stage.ui.json"), "utf8"));
  const sidebar = JSON.parse(readFileSync(path.join(process.cwd(), "plugins/annotation-workflow/ui/sidebar.ui.json"), "utf8"));
  const text = JSON.stringify(stage);
  assert.match(text, /"on_start":\[\{"type":"dialog\.close","dialog":"comment-dialog"\}\]/);
  assert.match(text, /"plugin":"annotation-workflow","command":"jobs\.enqueue"/);
  assert.match(JSON.stringify(sidebar), /"type":"resource\.optimistic-append"/);
  assert.match(JSON.stringify(sidebar), /"type":"resource\.optimistic-patch"/);
});

test("safe-markdown renders fenced code with a bounded language label and accessible scroll region", () => {
  const source = readFileSync(path.join(process.cwd(), "src/ui/renderer.js"), "utf8");
  const css = readFileSync(path.join(process.cwd(), "src/ui/renderer.css"), "utf8");
  const functionStart = source.indexOf("function safeMarkdown(markdown)");
  const functionEnd = source.indexOf("function documentSize", functionStart);
  assert.notEqual(functionStart, -1);
  assert.notEqual(functionEnd, -1);

  class TestNode {
    className = "";
    textContent = "";
    tabIndex = -1;
    children: TestNode[] = [];
    attributes = new Map<string, string>();
    constructor(readonly tagName: string) {}
    append(...nodes: TestNode[]) { this.children.push(...nodes); }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  }
  const createElement = (name: string, className?: string) => {
    const node = new TestNode(name);
    if (className) node.className = className;
    return node;
  };
  const render = new Function("element", `${source.slice(functionStart, functionEnd)}; return safeMarkdown;`)(createElement) as (markdown: string) => TestNode;
  const child = (node: TestNode, index: number) => {
    const value = node.children[index];
    assert.ok(value);
    return value;
  };
  const rendered = render("# Setup\n```sh\nprintf '<safe>'\n```\nafter");
  const codeBlock = child(rendered, 1);
  assert.equal(codeBlock.tagName, "figure");
  assert.equal(codeBlock.className, "vr-markdown-code-block");
  assert.equal(child(codeBlock, 0).tagName, "figcaption");
  assert.equal(child(codeBlock, 0).textContent, "sh");
  const pre = child(codeBlock, 1);
  assert.equal(pre.tagName, "pre");
  assert.equal(pre.tabIndex, 0);
  assert.equal(pre.attributes.get("role"), "region");
  assert.equal(pre.attributes.get("aria-label"), "sh のコード");
  assert.equal(child(pre, 0).textContent, "printf '<safe>'");
  assert.equal(child(rendered, 2).textContent, "after");

  const unlabelled = child(render(`\`\`\`${"x".repeat(33)}\ncode\n\`\`\``), 0);
  assert.equal(unlabelled.children.length, 1, "unbounded fence info must not become a visible label");
  assert.equal(child(unlabelled, 0).attributes.get("role"), "region");
  assert.equal(child(unlabelled, 0).attributes.get("aria-label"), "コードブロック");

  const tildeBlock = child(render("~~~js\nconst value = '<safe>';\n~~~~"), 0);
  assert.equal(child(tildeBlock, 0).textContent, "js");
  assert.equal(child(child(tildeBlock, 1), 0).textContent, "const value = '<safe>';", "code remains text rather than HTML");

  for (const indentation of [1, 2, 3]) {
    const spaces = " ".repeat(indentation);
    const indented = child(render(`${spaces}~~~\n${spaces}same\n half\nplain\n${spaces}~~~`), 0);
    assert.equal(child(child(indented, 0), 0).textContent, "same\nhalf\nplain", `up to ${indentation} leading spaces are removed`);
  }

  const mismatched = render("````txt\none\n```\ntwo\n~~~~\nthree\n`````\nafter");
  assert.equal(child(child(child(mismatched, 0), 1), 0).textContent, "one\n```\ntwo\n~~~~\nthree");
  assert.equal(child(mismatched, 1).textContent, "after", "a longer fence of the same kind closes the block");

  const unclosed = child(render("~~~\nunclosed\n```"), 0);
  assert.equal(child(child(unclosed, 0), 0).textContent, "unclosed\n```", "a different fence kind does not close the block");
  assert.match(css, /\.vr-markdown-code-block[^}]*overflow: hidden[^}]*border:[^}]*border-radius:/s);
  assert.match(css, /\.vr-markdown-code[^}]*overflow: auto[^}]*tab-size:/s);
  assert.match(css, /\.vr-markdown-code:focus-visible/);
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

test("checkbox-group supports an inverted binding where checked means excluded from the bound set", () => {
  const source = readFileSync(path.join(process.cwd(), "src/ui/renderer.js"), "utf8");
  assert.match(source, /values\.inverted === true/);
  assert.match(source, /input\.checked = values\.inverted === true \? !selected\.has\(value\) : selected\.has\(value\)/);

  const documentSource = readFileSync(path.join(process.cwd(), "src/plugin-ui-document.ts"), "utf8");
  const checkboxGroupLine = documentSource.split("\n").find((line) => line.includes('"checkbox-group":'));
  assert.ok(checkboxGroupLine, "checkbox-group prop allowlist not found");
  assert.match(checkboxGroupLine!, /"inverted"/);

  assert.doesNotThrow(() =>
    parsePluginUiDocument({
      schema_version: 1,
      root: {
        type: "checkbox-group",
        props: { value: { local: "/hidden" }, options: { literal: [] }, inverted: { literal: true } },
      },
    }),
  );

  const css = readFileSync(path.join(process.cwd(), "src/ui/renderer.css"), "utf8");
  assert.match(css, /\.vr-checkbox-option input[^}]*clip-path: inset\(50%\)/s);
  assert.match(css, /\.vr-checkbox-option:has\(input:checked\)[^{]*\{[^}]*border-color:[^}]*background:/s);
  assert.match(css, /\.vr-checkbox-option:has\(input:focus-visible\)/);
});

test("renderer acceptance paths scope repeated annotation actions and implement target regions, focus, dialogs, and pending controls", () => {
  const source = readFileSync(path.join(process.cwd(), "src/ui/renderer.js"), "utf8");
  assert.match(source, /definition\.repeat\.key/);
  assert.match(source, /instanceKey: \[scope\.instanceKey, repeatKey\]/);
  assert.match(source, /scope\.instanceKey \|\| "root".*instruction\.command/);
  assert.match(source, /pending\?\.disable/);
  assert.match(source, /result\.error\?\.code === "CONFLICT"/);
  assert.match(source, /await refreshResourceNamed\(revisionResource, scope\)/);
  assert.match(source, /new Map\(matchingOwners\.map\(\(contribution\) => \[`\$\{contribution\.plugin_id\}:\$\{id\}`/);
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
  assert.match(source, /function patchStageHostRoot\(currentRoot, nextTree\)/);
  assert.match(source, /scrollState = \{ top: container\.scrollTop, left: container\.scrollLeft \}/);
  assert.match(source, /container\.scrollTop = scrollState\.top/);
  assert.match(source, /const openDialog = document\.querySelector\("dialog\[open\]"\)/);
  assert.match(source, /deferredReviewRender.*addEventListener\("close".*rerender\(\)/s);
  assert.match(source, /if \(changed\) rerender\(\)/);
  assert.match(source, /targetIdentity\(currentStage\) !== targetIdentity\(nextStage\)/);
  assert.match(source, /canPatch = currentContent\?\.dataset\?\.slot === "review\.stage" && patchStageHostRoot\(currentContent, nextTree\)/);
  assert.match(source, /node\.type = String\(values\.type\)/);
  assert.match(source, /container\.dataset\.viewport === "custom"/);
  assert.match(source, /frame\.style\.width = `\$\{container\.__viewportWidth\}px`/);
  assert.match(source, /currentStage\.__viewportWidth = nextStage\.__viewportWidth/);
  assert.doesNotMatch(source, /prepareExpandableText|expandedTextKeys|workflowExpandable|reviewViewportScale|installCustomViewportFit/);
  assert.match(source, /activeStage\.browser_module_url.*mountPluginRuntime\(activeStage, currentContent\)/s);
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
  assert.match(css, /\.vr-toolbar\[data-variant="issue-selection-mode"\][^}]*border-radius/s);
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

test("AI runner registration keeps breathing room above and below its test control", () => {
  const settings = JSON.parse(readFileSync(path.join(process.cwd(), "plugins/ai/ui/settings.ui.json"), "utf8")) as unknown;
  const css = readFileSync(path.join(process.cwd(), "src/ui/renderer.css"), "utf8");
  assert.doesNotThrow(() => parsePluginUiDocument(settings));
  assert.match(JSON.stringify(settings), /"type":"form","props":\{"name":\{"literal":"runner"\},"submit_on_enter":\{"literal":true\},"variant":\{"literal":"ai-runner-registration"\}/);
  assert.match(css, /\.vr-plugin-detail-content \.vr-form\[data-variant="ai-runner-registration"\] \{[^}]*margin-top: var\(--vr-space-4\);[^}]*margin-bottom: var\(--vr-space-4\);[^}]*\}/s);
});

test("bundled review and independent Issue documents bind selection, lists, and target focus", () => {
  const header = JSON.parse(readFileSync(path.join(process.cwd(), "plugins/review/ui/header.ui.json"), "utf8")) as unknown;
  const stage = JSON.parse(readFileSync(path.join(process.cwd(), "plugins/review/ui/stage.ui.json"), "utf8")) as unknown;
  const rendererSource = readFileSync(path.join(process.cwd(), "src/ui/renderer.js"), "utf8");
  const reviewRuntime = readFileSync(path.join(process.cwd(), "plugins/review/ui/review.js"), "utf8");
  const sidebarText = readFileSync(path.join(process.cwd(), "plugins/annotation-workflow/ui/sidebar.ui.json"), "utf8").replace(/\s+/g, " ");
  const workflowRuntime = readFileSync(path.join(process.cwd(), "plugins/annotation-workflow/ui/sidebar.js"), "utf8");
  const workflowManifest = JSON.parse(readFileSync(path.join(process.cwd(), "plugins/annotation-workflow/vrev.plugin.json"), "utf8")) as { ui: { contributions: Array<{ id: string; browser_module?: string }> } };
  const issueHeader = JSON.parse(readFileSync(path.join(process.cwd(), "plugins/github-issue/ui/header.ui.json"), "utf8")) as unknown;
  const issueSidebar = JSON.parse(readFileSync(path.join(process.cwd(), "plugins/github-issue/ui/sidebar.ui.json"), "utf8")) as unknown;
  const issueText = JSON.stringify({ issueHeader, issueSidebar });
  const aiSettingsText = readFileSync(path.join(process.cwd(), "plugins/ai/ui/settings.ui.json"), "utf8");
  assert.doesNotThrow(() => parsePluginUiDocument(header));
  assert.doesNotThrow(() => parsePluginUiDocument(stage));
  assert.doesNotThrow(() => parsePluginUiDocument(issueHeader));
  assert.doesNotThrow(() => parsePluginUiDocument(issueSidebar));
  const headerDocument = header as { local_state: Array<{ key: string; default: unknown; persist?: boolean }>; root: unknown };
  const stageDocument = stage as { root: unknown };
  assert.equal(headerDocument.local_state.find(({ key }) => key === "viewport_width")?.default, 1280);
  assert.equal(headerDocument.local_state.find(({ key }) => key === "viewport_height")?.default, 720);
  assert.equal(headerDocument.local_state.find(({ key }) => key === "viewport_width")?.persist, true);
  assert.match(JSON.stringify(headerDocument.root), /"value":"custom","label":"カスタム"/);
  assert.match(JSON.stringify(headerDocument.root), /"label":\{"literal":"再読み込み"\}[^]*"click":\[\{"type":"target.reload"\}\]/);
  assert.doesNotMatch(JSON.stringify(headerDocument.root), /"label":\{"literal":"再読み込み"\}[^]*"click":\[\{"type":"resource.refresh"/);
  assert.match(JSON.stringify(stageDocument.root), /"type":"target-stage"/);
  assert.match(JSON.stringify(stageDocument.root), /"local":"\/viewport"/);
  assert.match(JSON.stringify(stageDocument.root), /"viewport_width"/);
  assert.match(JSON.stringify(stageDocument.root), /"viewport_height"/);
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
  assert.match(issueText, /"id":"issue-request-dialog"/);
  assert.match(issueText, /"id":"issue-create-dialog"/);
  assert.match(issueText, /"command":"issue.draft"/);
  assert.match(issueText, /"literal":"repo:"/);
  assert.match(issueText, /"literal":"account:"/);
  assert.match(issueText, /"type":"selection.activate","mode":"node","on_commit"/);
  assert.match(issueText, /"type":"selection.activate","mode":"region","on_commit"/);
  assert.match(issueText, /"variant":\{"literal":"issue-selection-mode"\}/);
  assert.match(issueText, /"query":"issues.list"/);
  assert.match(issueText, /"type":"target.focus"/);
  assert.match(issueText, /"attention_key":\{"literal":"github-issues"\}/);
  assert.match(issueText, /"id":"issue-force-resolve-dialog"/);
  assert.match(issueText, /"command":"issue.resolve"/);
  assert.match(issueText, /強制的に解決する/);
  assert.doesNotMatch(issueText, /ai_method_id|method_id|ai-method/);
  assert.doesNotMatch(sidebarText, /runner|method_id/);
  assert.match(aiSettingsText, /"type": "select"/);
  assert.match(aiSettingsText, /"path": "\/method_id"/);
  assert.match(aiSettingsText, /"method_id": \{/);
  assert.match(rendererSource, /vr-selection-mode-button/);
  assert.match(rendererSource, /selection\.trigger\?\.setAttribute\?\.\("aria-pressed", "true"\)/);
  assert.match(reviewRuntime, /function installCustomViewportFit\(root, stage, frame, layer\)/);
  assert.match(reviewRuntime, /Math\.min\(1, availableWidth \/ width, availableHeight \/ height\)/);
  assert.match(reviewRuntime, /frame\.style\.setProperty\("transform", `scale\(\$\{scale\}\)`\)/);
  assert.match(reviewRuntime, /stage\.dataset\.reviewViewportScale/);
  assert.match(reviewRuntime, /scaleAnnotationMarks\(layer, stage, frame, frameScale\)/);
  assert.match(rendererSource, /stage\.__target\?\.live_url \? new URL\(proxiedPath, stage\.__target\.live_url\)\.toString\(\)/);
  assert.match(rendererSource, /reviewSelection\.annotation_id = binding\(instruction\.annotation_id, scope\)/);
  assert.match(rendererSource, /Array\.isArray\(layer\.__marks\)/);
  assert.doesNotMatch(rendererSource, /resourceStores\.get\("annotation-workflow:annotations"\)|issue_state/);
  assert.match(rendererSource, /anchor\?\.bounds \|\| anchor\?\.rect/);
  assert.match(rendererSource, /else if \(annotation\.anchor\?\.rect\)/);
  assert.match(rendererSource, /function reloadTarget\(\)/);
  assert.match(rendererSource, /frame\.__pendingReloadScroll = pending/);
  assert.match(rendererSource, /const logicalUrl = continuesNavigation \? superseded\.logicalUrl : validatedTargetRefreshSource\(frame, stage\?\.__target\?\.url, stage\?\.__target\)/);
  assert.match(rendererSource, /image\.src = targetRefreshNavigationUrl\(stage\.__target\.url, crypto\.randomUUID\(\), stage\.__target\)/);
  assert.doesNotMatch(rendererSource, /new URL\(image\.currentSrc \|\| image\.src/);
  assert.match(rendererSource, /pending = \{ logicalUrl, observedUrl: currentUrl, generation/);
  assert.match(rendererSource, /pending\.navigationUrl = targetRefreshNavigationUrl\(logicalUrl, crypto\.randomUUID\(\), stage\?\.__target\)/);
  assert.match(rendererSource, /frame\.contentWindow\.location\.replace\(pending\.navigationUrl\)/);
  assert.doesNotMatch(rendererSource, /contentWindow\.location\.(?:reload|assign)\(|__vrev_reload__/);
  const reloadImplementation = rendererSource.slice(rendererSource.indexOf("function clearPendingReload"), rendererSource.indexOf("function showTargetDiagnostic"));
  assert.doesNotMatch(reloadImplementation, /pending\.cleanupTimer|history\.replaceState/);
  assert.match(rendererSource, /function redrawTargetAfterLoad\(frame\)/);
  const redrawSource = rendererSource.slice(rendererSource.indexOf("function redrawTargetAfterLoad"), rendererSource.indexOf("function reloadTarget"));
  assert.equal(redrawSource.match(/scrollTo\(pendingScroll\.x, pendingScroll\.y\)/g)?.length, 1);
  assert.match(redrawSource, /doc\?\.fonts\?\.ready\.then\(redraw\)/);
  assert.match(rendererSource, /function watchTargetLayout\(frame, doc, redraw\)[^]*new ResizeObserver\(redraw\)[^]*new MutationObserver\(redraw\)[^]*addEventListener\("load", redraw, true\)[^]*setTimeout\(cleanup, 5000\)/);
  assert.match(rendererSource, /async function focusTarget[^]*if \(frame\) beginTargetNavigation\(frame\);/);
  assert.match(rendererSource, /const completedRefresh = finishTargetRefresh\(frame, candidate\)/);
  assert.match(rendererSource, /pending\.generation !== frame\.__targetNavigationGeneration/);
  assert.match(rendererSource, /if \(status\) mark\.dataset\.status = status/);
  assert.match(rendererSource, /definition\.type === "panel" && eventName === "click"/);
  assert.match(JSON.stringify(stageDocument.root), /"plugin":"annotation-workflow","command":"jobs\.enqueue"/);
  assert.match(JSON.stringify(stageDocument.root), /"resource":"workflow-settings","plugin":"annotation-workflow"/);
  assert.match(rendererSource, /const commandPlugin = instruction\.plugin \|\| scope\.plugin/);
  assert.doesNotMatch(rendererSource, /autoRunNewAnnotation/);
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

test("Base marks unseen updates on the owning sidebar disclosure instead of adding a header notification center", () => {
  const source = readFileSync(path.join(process.cwd(), "src/ui/renderer.js"), "utf8");
  const css = readFileSync(path.join(process.cwd(), "src/ui/renderer.css"), "utf8");
  const workflow = readFileSync(path.join(process.cwd(), "plugins/annotation-workflow/ui/sidebar.ui.json"), "utf8");
  assert.match(source, /vrev\.disclosure-seen\/v1/);
  assert.match(source, /has-unread-attention/);
  assert.match(source, /if \(node\.open\) markDisclosureSeen\(node\)/);
  assert.match(source, /node\.__committedOpen = node\.open/);
  assert.match(source, /if \(node\.__committedOpen === node\.open\) return/);
  assert.match(source, /previousStore\?\.data === undefined \? "loading" : "refreshing"/);
  assert.match(source, /current\?\.data === undefined \? \{ state: "error", error \} : \{ \.\.\.current, state: "ready", refresh_error: error \}/);
  assert.match(source, /await Promise\.all\(activeStageLoads\)/);
  assert.doesNotMatch(source, /通知センター|review\.notifications|notificationButton/);
  assert.match(css, /\.vr-attention-indicator/);
  const workflowDocument = JSON.parse(workflow) as { root: { children: Array<{ props?: { attention_key?: { literal?: string } } }> } };
  assert.deepEqual(workflowDocument.root.children.slice(0, 3).map(({ props }) => props?.attention_key?.literal), ["ai-jobs", "annotations", "history"]);
});

test("all default sidebar sections use the same Base disclosure primitive", () => {
  const workflow = JSON.parse(readFileSync(path.join(process.cwd(), "plugins/annotation-workflow/ui/sidebar.ui.json"), "utf8")) as { root: { children: Array<{ type: string }> } };
  const issue = JSON.parse(readFileSync(path.join(process.cwd(), "plugins/github-issue/ui/sidebar.ui.json"), "utf8")) as { root: { type: string } };
  assert.deepEqual(workflow.root.children.slice(0, 3).map(({ type }) => type), ["disclosure", "disclosure", "disclosure"]);
  assert.equal(issue.root.type, "disclosure");
});

test("base shell owns the review header/stage/sidebar layout and plugin-scoped local state", () => {
  const source = readFileSync(path.join(process.cwd(), "src/ui/renderer.js"), "utf8");
  const css = readFileSync(path.join(process.cwd(), "src/ui/renderer.css"), "utf8");
  // C2: root local state is namespaced per plugin (shared across that plugin's root
  // contributions) under a new storage key, migrating values out of the old per-contribution key.
  assert.match(source, /vrev:renderer:2:\$\{pluginId\}/);
  assert.match(source, /vrev:renderer:1:\$\{pluginId\}:\$\{contribution\.id\}/);
  assert.match(source, /function pluginLocalStateDeclarations\(pluginId\)/);
  assert.match(source, /function runtimeFor\(contribution, parentInstanceKey = ""\)/);
  assert.match(source, /function declarationsFor\(scope\)/);
  // C3: the base shell owns header/stage/sidebar composition; a stage switcher appears when
  // more than one review.stage view is declared, and moving it PUTs the shared layout settings.
  assert.match(source, /dataset\.baseShell = "review"/);
  assert.match(source, /slot === "review\.header"/);
  assert.match(source, /slot === "review\.stage"/);
  assert.match(source, /slot === "review\.sidebar"/);
  assert.match(source, /function renderStageSwitcher\(container, activeKey\)/);
  assert.match(source, /fetch\("\/api\/settings\/layout", \{ method: "PUT"/);
  assert.match(source, /stage: \{ active: key \}/);
  assert.match(source, /switcher\.dataset\.position = surface\.layout\.stage_switcher_position/);
  // C1/C4: /settings hosts the base layout page distinct from /settings/plugins.
  assert.match(source, /location\.pathname === "\/settings"\) return renderGeneralSettings\(\)/);
  assert.match(source, /プラグイン設定を開く/);
  assert.match(source, /設定へ戻る/);
  assert.match(css, /\.vr-stage-switcher \{/);
  assert.match(css, /\[data-position="top-left"\]/);
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|DOMParser|document\.write|\beval\s*\(|new Function/);
});

test("external links accept only absolute credential-free HTTP URLs", () => {
  const source = readFileSync(path.join(process.cwd(), "src/ui/renderer.js"), "utf8");
  const start = source.indexOf("function safeExternalHttpUrl");
  const end = source.indexOf("function targetUrlForPage", start);
  const safeExternalHttpUrl = new Function(`${source.slice(start, end)}; return safeExternalHttpUrl;`)() as (value: unknown) => string | null;
  assert.equal(safeExternalHttpUrl("https://example.com/issues/1"), "https://example.com/issues/1");
  assert.equal(safeExternalHttpUrl("http://example.com/path"), "http://example.com/path");
  const credentialedHost = "https://" + "user" + "@example.com/";
  const credentialedSecret = "https://" + "user" + ":" + "secret" + "@example.com/";
  for (const unsafe of ["/relative", "javascript:alert(1)", credentialedHost, credentialedSecret, "not a URL", " https://example.com/"]) {
    assert.equal(safeExternalHttpUrl(unsafe), null);
  }
  assert.match(source, /if \(values\.external\) \{[^]*const href = safeExternalHttpUrl\(values\.href\);[^]*if \(href\) \{ node\.href = href; node\.target = "_blank";/);
});

test("rapid iframe reloads preserve raw URLs and stale loads cannot consume the latest pending state", () => {
  const source = readFileSync(path.join(process.cwd(), "src/ui/renderer.js"), "utf8");
  const start = source.indexOf("function clearPendingReload");
  const end = source.indexOf("function showTargetDiagnostic", start);
  let timerId = 0;
  let uuid = 0;
  const scrolls: Array<[number, number]> = [];
  const navigations: string[] = [];
  const loadedDocument = { documentElement: null, body: null, fonts: null, addEventListener() {}, removeEventListener() {} };
  const logicalUrl = "https://host.test/live/current?a=%2f+b&empty=#h%2f";
  const frame: any = {
    isConnected: true,
    src: logicalUrl,
    getAttribute: () => logicalUrl,
    contentDocument: loadedDocument,
    contentWindow: {
      location: {
        href: "about:blank",
        replace(value: string) { navigations.push(value); this.href = value; },
      },
      history: { state: null, replaceState(_state: unknown, _title: string, value: string) { frame.contentWindow.location.href = value; } },
      scrollX: 12,
      scrollY: 34,
      scrollTo: (x: number, y: number) => scrolls.push([x, y]),
    },
  };
  const stage = { __target: { url: logicalUrl }, querySelector: (selector: string) => selector === "iframe" ? frame : null };
  const helpers = new Function("document", "location", "crypto", "setTimeout", "clearTimeout", "requestAnimationFrame", "redrawMarks", `${source.slice(start, end)}; return { reloadTarget, beginTargetNavigation, redrawTargetAfterLoad };`)(
    { querySelector: () => stage },
    { href: "https://host.test/", origin: "https://host.test" },
    { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` },
    () => ++timerId,
    () => {},
    (callback: () => void) => callback(),
    () => {},
  );
  helpers.reloadTarget();
  const firstNavigation = navigations[0]!;
  helpers.reloadTarget();
  const secondNavigation = navigations[1]!;
  assert.notEqual(secondNavigation, firstNavigation);
  const endpoint = new URL(secondNavigation);
  assert.match(endpoint.pathname, /^\/_vrev\/reload\/[0-9a-f-]+$/);
  assert.equal(endpoint.searchParams.get("url"), "/live/current?a=%2f+b&empty=#h%2f");
  assert.doesNotMatch(secondNavigation, /__vrev_reload__/);

  frame.contentWindow.location.href = firstNavigation;
  helpers.redrawTargetAfterLoad(frame);
  assert.equal(frame.__pendingReloadScroll.navigationUrl, secondNavigation, "a stale load leaves the newest pending reload intact");
  assert.deepEqual(scrolls, []);
  frame.contentWindow.location.href = logicalUrl;
  helpers.redrawTargetAfterLoad(frame);
  assert.deepEqual(scrolls, [[12, 34]], "only the matching final logical URL restores scroll");
  assert.equal(frame.__pendingReloadScroll, undefined);
  assert.equal(frame.contentWindow.location.href, logicalUrl, "the target sees the exact original query bytes and hash without client cleanup");

  helpers.reloadTarget();
  helpers.beginTargetNavigation(frame); // target.focus invalidates scroll restoration.
  helpers.redrawTargetAfterLoad(frame);
  assert.deepEqual(scrolls, [[12, 34]]);
});

test("declarative reload validation allows only private live SPA fallback paths", () => {
  const source = readFileSync(path.join(process.cwd(), "src/ui/renderer.js"), "utf8");
  const start = source.indexOf("function clearPendingReload");
  const end = source.indexOf("function showTargetDiagnostic", start);
  const { targetRefreshNavigationUrl } = new Function("location", `${source.slice(start, end)}; return { targetRefreshNavigationUrl };`)(
    { href: "https://host.test/", origin: "https://host.test" },
  );
  const token = "00000000-0000-4000-8000-000000000001";
  const privateLive = { live_url: "http://127.0.0.1:5173/", url_mode: "loopback" };
  assert.equal(new URL(targetRefreshNavigationUrl("https://host.test/foo?tab=1", token, privateLive)).searchParams.get("url"), "/foo?tab=1");
  for (const reserved of ["/", "/api/session", "/settings", "/assets/app.js", "/_vrev/other"]) {
    assert.throws(() => targetRefreshNavigationUrl(`https://host.test${reserved}`, token, privateLive), /安全に更新/);
  }
  assert.throws(() => targetRefreshNavigationUrl("https://host.test/foo", token, { ...privateLive, url_mode: "public" }), /安全に更新/);
  assert.throws(() => targetRefreshNavigationUrl("https://host.test/foo", token, {}), /安全に更新/);
  assert.throws(() => targetRefreshNavigationUrl("https://outside.test/foo", token, privateLive), /安全に更新/);
});

test("declarative images can be reloaded repeatedly from their logical target URL", () => {
  const source = readFileSync(path.join(process.cwd(), "src/ui/renderer.js"), "utf8");
  const start = source.indexOf("function clearPendingReload");
  const end = source.indexOf("function showTargetDiagnostic", start);
  let uuid = 0;
  const navigations: string[] = [];
  const logicalUrl = "https://host.test/target/image.png?variant=original#preview";
  const image: any = {
    currentSrc: "https://host.test/_vrev/reload/stale?url=%2Ftarget%2Fwrong.png",
    get src() { return navigations.at(-1) || this.currentSrc; },
    set src(value: string) { navigations.push(value); },
  };
  const stage = {
    __target: { url: logicalUrl },
    querySelector: (selector: string) => selector === "img" ? image : null,
  };
  const { reloadTarget } = new Function("document", "location", "crypto", `${source.slice(start, end)}; return { reloadTarget };`)(
    { querySelector: () => stage },
    { href: "https://host.test/", origin: "https://host.test" },
    { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` },
  );

  reloadTarget();
  reloadTarget();
  reloadTarget();

  assert.equal(navigations.length, 3);
  assert.equal(new Set(navigations).size, 3, "every reload uses a fresh redirect endpoint");
  for (const navigation of navigations) {
    const endpoint = new URL(navigation);
    assert.match(endpoint.pathname, /^\/_vrev\/reload\/[0-9a-f-]+$/);
    assert.equal(endpoint.searchParams.get("url"), "/target/image.png?variant=original#preview");
    assert.doesNotMatch(endpoint.searchParams.get("url")!, /_vrev\/reload/, "redirect URLs are never nested");
  }
});

test("general settings describes and controls header and sidebar order in their rendered directions", () => {
  const source = readFileSync(path.join(process.cwd(), "src/ui/renderer.js"), "utf8");
  const css = readFileSync(path.join(process.cwd(), "src/ui/renderer.css"), "utf8");
  assert.match(source, /const isHorizontal = kind === "header"/);
  assert.match(source, /一覧の上から順に、ヘッダーの左から右へ表示されます。/);
  assert.match(source, /一覧の上から順に、サイドバーの上から下へ表示されます。/);
  assert.match(source, /previous\.textContent = isHorizontal \? "左へ" : "上へ"/);
  assert.match(source, /next\.textContent = isHorizontal \? "右へ" : "下へ"/);
  assert.match(source, /previous\.setAttribute\("aria-label", `\$\{item\.title\}を\$\{previous\.textContent\}移動`\)/);
  assert.match(source, /next\.setAttribute\("aria-label", `\$\{item\.title\}を\$\{next\.textContent\}移動`\)/);
  assert.match(source, /moveLayoutItem\(kind, items, index, -1, layoutPayload\)/);
  assert.match(source, /moveLayoutItem\(kind, items, index, 1, layoutPayload\)/);
  assert.match(source, /reorderStatus\.setAttribute\("aria-live", "polite"\)/);
  assert.match(source, /message: `\$\{item\.title\}を\$\{direction\}へ移動しました。`/);
  assert.match(source, /candidate\.dataset\.layoutKind === reorderResult\.kind && candidate\.dataset\.layoutItemKey === reorderResult\.key/);
  assert.match(source, /movedIndex === 0 \? "next" : movedIndex === orderedItems\.length - 1 \? "previous"/);
  assert.match(source, /row\?\.querySelector\(`\[data-layout-action="\$\{action\}"\]`\)\?\.focus\(\)/);
  assert.match(source, /if \(reorderResult && layoutReorderSaving\) return/);
  assert.match(source, /settingsPage\?\.setAttribute\("aria-busy", "true"\)/);
  assert.match(source, /for \(const control of controls\) control\.disabled = true/);
  assert.match(source, /renderGeneralSettings\(reorderResult \? \{ \.\.\.reorderResult, message: "" \} : null\)/);
  assert.match(css, /\.vr-settings-card > \.vr-link\.vr-button \{ text-decoration: none; \}/);
});

test("renderer resolves plugin-hosted extension points, validates context/event schemas, and dispatches slot.emit to the host", () => {
  const source = readFileSync(path.join(process.cwd(), "src/ui/renderer.js"), "utf8");
  const css = readFileSync(path.join(process.cwd(), "src/ui/renderer.css"), "utf8");
  assert.match(source, /function matchesSchema\(value, schema\)/);
  assert.match(source, /schema\.additionalProperties !== true && Object\.keys\(object\)\.some/);
  assert.match(source, /\(surface\.extension_points \|\| \[\]\)\.find\(\(item\) => item\.id === slot\)/);
  assert.match(source, /extension point context is invalid/);
  assert.match(source, /matchesSchema\(contextValue, point\.context_schema\)/);
  assert.match(source, /renderContribution\(contribution, contextValue, scope\.instanceKey, \{ definition, scope, point \}\)/);
  assert.match(source, /function renderContribution\(contribution, slotContext = \{\}, parentInstanceKey = "", slotHost = null\)/);
  assert.match(source, /slotContext:.*, slotHost \}/);
  assert.match(source, /if \(definition\.type === "slot"\) return;/);
  assert.match(source, /instruction\.type === "slot\.emit"/);
  assert.match(source, /const host = scope\.slotHost;/);
  assert.match(source, /instruction\.event in \(host\.point\.events \|\| \{\}\)/);
  assert.match(source, /slot\.emit target unavailable/);
  assert.match(source, /slot\.emit payload is invalid/);
  assert.match(source, /await execute\(host\.definition\.on\?\.\[instruction\.event\] \|\| \[\], \{ \.\.\.host\.scope, event: payload \}, strictRefresh\)/);
  assert.match(css, /\.vr-row\[data-variant="dialog-actions"\] > \.vr-slot \{ display: contents/);
  assert.match(css, /\.vr-row\[data-variant="dialog-actions"\] > \.vr-slot > \[data-slot\] \{ display: flex; flex-direction: row/);
});

test("storage-transfer section renders for storage-capable plugins with a two-step confirm and no unsafe DOM APIs", () => {
  const source = readFileSync(path.join(process.cwd(), "src/ui/renderer.js"), "utf8");
  // Gated on the plugin's declared "storage" capability.
  assert.match(source, /\(plugin\.capabilities \|\| \[\]\)\.includes\("storage"\)/);
  assert.match(source, /function renderStorageTransferSection\(plugin\)/);
  // Direction options are built dynamically from plugin.title.
  assert.match(source, /`ローカル（\.vrev） → \$\{plugin\.title\}`/);
  assert.match(source, /`\$\{plugin\.title\} → ローカル（\.vrev）`/);
  // Correct API contract.
  assert.match(source, /`\/api\/settings\/plugins\/\$\{encodeURIComponent\(plugin\.id\)\}\/storage-transfer`/);
  assert.match(source, /direction: directionSelect\.value, dry_run: dryRun/);
  // Two-step confirmation: the primary button only opens a confirm panel; a second,
  // distinct control ("実行する") performs the actual dry_run:false request.
  assert.match(source, /confirmPanel\.hidden = false/);
  assert.match(source, /confirmRun\.addEventListener\("click", \(\) => void runTransfer\(false\)\)/);
  assert.match(source, /executeButton\.addEventListener\("click", \(\) => \{/);
  assert.doesNotMatch(source, /executeButton\.addEventListener\("click", \(\) => void runTransfer\(false\)\)/);
  // Result summary text and truncated key lists.
  assert.match(source, /書き込み \$\{body\.written_total\} 件 \/ 削除 \$\{body\.deleted_total\} 件 \/ 変更なし \$\{body\.unchanged\} 件/);
  assert.match(source, /keys\.slice\(0, 20\)/);
  assert.match(source, /`ほか \$\{total - shown\.length\} 件`/);
  // Disabled when the plugin is not enabled or has missing configuration.
  assert.match(source, /const blocked = !plugin\.enabled \|\| \(plugin\.missing \|\| \[\]\)\.length > 0/);
  assert.match(source, /上書きを実行するには、このプラグインを有効にして必要な設定を保存してください。/);
  // Busy state during the request.
  assert.match(source, /busyButton\.setAttribute\("aria-busy", "true"\)/);
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|DOMParser|document\.write|\beval\s*\(|new Function/);
});

test("bundled plugin UI documents stay JSON while declared browser modules are explicit local assets", async () => {
  const root = workspace();
  await ensureDefaultPlugins(root);
  const pluginsRoot = path.join(root, ".vrev/plugins");
  for (const id of ["review", "annotation-workflow", "github-issue", "ai"]) {
    const manifest = JSON.parse(readFileSync(path.join(pluginsRoot, id, "vrev.plugin.json"), "utf8")) as { ui?: { contributions: Array<{ document: string; browser_module?: string }> } };
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
