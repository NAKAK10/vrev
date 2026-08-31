import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const packageRoot = process.cwd();
const sourceHtml = readFileSync(path.join(packageRoot, "src/ui/index.html"), "utf8");
const reviewerSource = readFileSync(path.join(packageRoot, "src/ui/reviewer.js"), "utf8");
const jobsSource = readFileSync(path.join(packageRoot, "src/ui/jobs.ts"), "utf8");
const pluginSettingsHtml = readFileSync(path.join(packageRoot, "src/plugin-settings-ui/index.html"), "utf8");
const pluginSettingsSource = readFileSync(path.join(packageRoot, "src/plugin-settings-ui/settings.js"), "utf8");
const pluginSettingsCss = readFileSync(path.join(packageRoot, "src/plugin-settings-ui/settings.css"), "utf8");
const rendererSource = readFileSync(path.join(packageRoot, "src/ui/renderer.js"), "utf8");
const rendererCss = readFileSync(path.join(packageRoot, "src/ui/renderer.css"), "utf8");
const workflowSidebarSource = readFileSync(path.join(packageRoot, "plugins/annotation-workflow/ui/sidebar.ui.json"), "utf8");

test("AI batch controls and compiled script are present", () => {
  for (const id of [
    "ai-batch-form",
    "ai-settings-open",
    "ai-settings-dialog",
    "ai-cli",
    "ai-max-parallel",
    "ai-auto-run",
    "ai-open-count",
    "ai-batch-submit",
  ]) {
    assert.match(sourceHtml, new RegExp(`id=["']${id}["']`), id);
  }
  assert.match(sourceHtml, /<option value="10">10<\/option>/);
  assert.match(sourceHtml, /<option value="copilot">GitHub Copilot<\/option>/);
  assert.match(sourceHtml, /<option value="pi">Pi<\/option>/);
  assert.match(sourceHtml, /id="global-settings-link"[^>]*hidden/);
  assert.match(sourceHtml, /class="sidebar-section ai-jobs-section"[^>]*hidden/);
  assert.match(sourceHtml, /class="review-layout workflow-disabled"/);
  assert.match(sourceHtml, /class="review-sidebar"[^>]*hidden/);
  assert.match(sourceHtml, /name="annotation-status" value="in_progress" checked/);
  assert.match(sourceHtml, /name="annotation-status" value="failed" checked/);
  assert.match(sourceHtml, /name="annotation-kind" value="dom" checked/);
  assert.match(sourceHtml, /name="annotation-kind" value="region" checked/);
  assert.match(sourceHtml, /<script type="module" src="jobs\.js"><\/script>/);
  assert.ok(existsSync(path.join(packageRoot, "dist/src/ui/jobs.js")));
});

test("jobs UI keeps annotation cards synchronized without rendering internal job cards", () => {
  assert.match(jobsSource, /requestJson\("\/api\/session"/);
  assert.match(jobsSource, /requestJson\("\/api\/jobs"/);
  assert.match(jobsSource, /requestJson\("\/api\/jobs\/batch"/);
  assert.doesNotMatch(sourceHtml, /ai-job-panel|job-card/);
  assert.doesNotMatch(jobsSource, /job-card|job-annotation-id|job-summary/);
  assert.doesNotMatch(jobsSource, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(jobsSource, /\.textContent\s*=/);
  assert.match(jobsSource, /statusElement = document\.createElement\("p"\)/);
  assert.match(jobsSource, /statusElement\.setAttribute\("aria-live", "polite"\)/);
  assert.match(jobsSource, /window\.addEventListener\("focus".*refreshJobs/);
  assert.match(jobsSource, /setTimeout\(\(\) => void refreshJobs\(\), 5000\)/);
  assert.match(jobsSource, /成功.*失敗.*キャンセル.*スキップ/);
  assert.match(jobsSource, /visual-review:session-refreshed/);
  assert.match(reviewerSource, /visual-review:session-refreshed/);
  assert.match(reviewerSource, /applyReview\(event\.detail\)/);
  assert.match(jobsSource, /target\?\.ai_jobs_enabled/);
  assert.match(jobsSource, /target\?\.allow_scripts !== true/);
  assert.match(jobsSource, /visual-review:annotation-created/);
  assert.match(jobsSource, /visual-review:annotation-reopened/);
  assert.match(jobsSource, /requestJson\("\/api\/plugins\/annotation-flow"/);
  assert.match(jobsSource, /annotationFlowPolicy\.debounceMs/);
  assert.match(reviewerSource, /visual-review:annotation-reopened[^]*reason: "human-reply"/);
  assert.match(reviewerSource, /visual-review:annotation-reopened[^]*reason: "manual-reopen"/);
  assert.match(jobsSource, /enqueueOpenAnnotations\(true\)/);
  assert.match(jobsSource, /visual-review:auto-run/);
  assert.match(jobsSource, /window\.location\.href = "\/settings\/plugins#annotation-workflow"/);
  assert.match(jobsSource, /form\.hidden = autoRunCheckbox\.checked/);
  assert.match(jobsSource, /requestJson\("\/api\/jobs\/custom-commands"\)/);
  assert.match(jobsSource, /return \{ cli: "custom", runner_id: custom\.runner_id \}/);
  assert.doesNotMatch(jobsSource, /\bcustom_name\b|\bcustom_command\b|visual-review:custom-commands/);
  assert.match(jobsSource, /response\.enabled === false[^]*aiJobsSection\.hidden = true;[^]*reviewSidebar\.hidden = true;[^]*workflow-disabled/);
  assert.match(jobsSource, /annotationWorkflowEnabled = true;[^]*aiJobsSection\.hidden = false;[^]*reviewSidebar\.hidden = false;[^]*classList\.remove\("workflow-disabled"\)/);
  assert.match(jobsSource, /builtInValues\.has\("claude"\) \? "claude"/);
  assert.match(jobsSource, /renderCustomCommands\(allowCustomCommands\)/);
  assert.match(sourceHtml, /プラグイン固有の設定は、左上の設定画面/);
  assert.doesNotMatch(sourceHtml, /id=["']ai-session-id["']/);
  assert.doesNotMatch(sourceHtml, /id=["']ai-session-note["']/);
  assert.doesNotMatch(sourceHtml, /id=["']ai-attach-url["']/);
  assert.doesNotMatch(sourceHtml, /id=["']ai-job-status["']/);
  assert.doesNotMatch(jobsSource, /sessionInput|session_id:|attachInput|opencode_attach:/);
  assert.doesNotMatch(sourceHtml, /セッションは選択したCLIが自動作成します/);
});

test("legacy plugin settings UI stays generic while declarative contributions own plugin details", () => {
  assert.match(pluginSettingsHtml, /id="plugin-row-template"/);
  assert.match(pluginSettingsHtml, /class="plugin-row"[^>]*role="listitem"/);
  assert.match(pluginSettingsHtml, /class="details-button"[^>]*aria-haspopup="dialog"/);
  assert.match(pluginSettingsHtml, /id="plugin-details-dialog"/);
  assert.match(pluginSettingsHtml, /id="readme-content" class="markdown-body"/);
  assert.match(pluginSettingsHtml, /class="dialog-section custom-command-manager"/);
  assert.match(pluginSettingsHtml, /class="dialog-section workflow-settings"/);
  assert.match(pluginSettingsHtml, /id="toast-region"[^>]*aria-live="polite"/);
  assert.match(pluginSettingsSource, /async function autosaveToggle/);
  assert.match(pluginSettingsSource, /body: JSON\.stringify\(\{ revision, enabled, configuration: committedConfiguration\(plugin\) \}\)/);
  assert.match(pluginSettingsSource, /dialog\.showModal\(\)/);
  assert.match(pluginSettingsSource, /function renderMarkdown\(markdown\)/);
  assert.match(pluginSettingsSource, /document\.createDocumentFragment\(\)/);
  assert.match(pluginSettingsSource, /\["http:", "https:"\]\.includes\(parsed\.protocol\)/);
  assert.doesNotMatch(pluginSettingsSource, /annotation-workflow|custom-command|github-issue/);
  assert.doesNotMatch(pluginSettingsSource, /\/api\/jobs\/custom-commands|\/api\/plugins\/annotation-flow/);
  assert.doesNotMatch(pluginSettingsSource, /visual-review:custom-commands|saveCommands/);
  assert.match(pluginSettingsCss, /\.plugin-row\{[^}]*grid-template-columns:minmax\(0,1fr\) auto auto/);
  assert.match(pluginSettingsCss, /\.plugin-dialog\{[^}]*width:min\(820px/);
  assert.match(pluginSettingsCss, /\.markdown-body\{[^}]*line-height:1\.7/);
  assert.match(pluginSettingsCss, /input\[type=checkbox\]\[role=switch\][^{]*\{[^}]*width:40px;[^}]*height:22px;[^}]*appearance:none/s);
  assert.match(pluginSettingsCss, /\.field-grid select\{[^}]*height:42px;[^}]*border:1px solid #c6d4d0;[^}]*border-radius:10px/s);
  assert.doesNotMatch(pluginSettingsSource, /innerHTML|insertAdjacentHTML|outerHTML|DOMParser|document\.write/);
});

test("captures framework source hints for live applications", () => {
  assert.match(reviewerSource, /\? "nuxt" : "vue"/);
  assert.match(reviewerSource, /\? "next" : "react"/);
  for (const framework of ["angular", "svelte", "wordpress"]) {
    assert.match(reviewerSource, new RegExp(`framework: ["']${framework}["']`), framework);
  }
  assert.match(reviewerSource, /__vueParentComponent/);
  assert.match(reviewerSource, /__reactFiber\$/);
  assert.match(reviewerSource, /source_hint/);
  assert.match(reviewerSource, /in_progress: "AI対応中"/);
  assert.match(reviewerSource, /DEFAULT_STATUS_FILTERS = \["open", "in_progress", "failed", "addressed", "resolved"\]/);
  assert.match(sourceHtml, /name="annotation-status" value="resolved" checked/);
  assert.match(reviewerSource, /countItem\(`解決済み/);
  assert.match(reviewerSource, /resolveButton\.textContent = "再オープン"/);
  assert.match(reviewerSource, /state\.archive\.annotations/);
  assert.match(reviewerSource, /FILTER_STORAGE_VERSION = 4/);
  assert.match(reviewerSource, /statuses\.size === 0[^]*new Set\(DEFAULT_STATUS_FILTERS\)/);
  assert.match(reviewerSource, /stored\.version !== FILTER_STORAGE_VERSION[^]*statuses\.add\("failed"\)/);
  assert.match(reviewerSource, /failed: "失敗"/);
  assert.match(reviewerSource, /countItem\(`失敗 \$\{statusCounts\.failed\}`\)/);
  assert.match(reviewerSource, /status === "failed"[^]*statusButton\.textContent = "再試行"/);
  assert.match(sourceHtml, /id="force-resolve-dialog"/);
  assert.match(sourceHtml, /AI対応済みではない状態.*強制的に解決|強制的に解決する/);
  assert.match(reviewerSource, /status === "addressed" \? "解決にする" : "強制的に解決"/);
  assert.match(reviewerSource, /if \(status === "addressed"\) void updateStatus[^]*else openForceResolveDialog/);
  assert.match(reviewerSource, /DEFAULT_KIND_FILTERS = \["dom", "region"\]/);
  assert.match(reviewerSource, /filterDialog\.showModal\(\)/);
  assert.match(reviewerSource, /new Set\(elements\.statusFilterInputs/);
});

test("rough feedback becomes an editable AI draft before GitHub Issue creation", () => {
  assert.match(sourceHtml, /id="github-issue-submit"[^>]*type="button"[^>]*>GitHub Issueにする</);
  assert.match(sourceHtml, /id="github-issue-dialog"/);
  assert.match(sourceHtml, /id="github-issue-title"[^>]*aria-keyshortcuts="Meta\+Enter Control\+Enter"/);
  assert.match(sourceHtml, /id="github-issue-body"[^>]*aria-keyshortcuts="Meta\+Enter Control\+Enter"/);
  assert.doesNotMatch(reviewerSource, /visual-review:ai-config-request/);
  assert.doesNotMatch(jobsSource, /visual-review:ai-config-request/);
  assert.match(reviewerSource, /async function requestGitHubIssueFromPending\(\)/);
  assert.match(reviewerSource, /state\.pendingAnnotation = null;\s*elements\.dialog\.close\(\);[^]*await request\("\/api\/issues\/request"/);
  assert.match(reviewerSource, /visual-review:annotation-created/);
  assert.match(reviewerSource, /elements\.githubIssueTitle\.value = item\.draft\.title/);
  assert.match(reviewerSource, /request\("\/api\/issues"/);
  assert.match(reviewerSource, /annotation_id: state\.currentIssueDraft\.annotationId/);
  assert.match(reviewerSource, /if \(state\.issueCreateInFlight \|\| !state\.currentIssueDraft\) return/);
  assert.match(reviewerSource, /state\.issueDraftQueue\.some\(\(\{ annotationId: queuedId \}\) => queuedId === id\)/);
  assert.match(reviewerSource, /elements\.githubIssueCancelButtons\.forEach\(\(button\) => \{ button\.disabled = true; \}\)/);
  const createIssueBody = /async function createGitHubIssueFromDraft\(\) \{([\s\S]*?)\n\}\n\nasync function saveAnnotation/.exec(reviewerSource)?.[1] ?? "";
  assert.match(createIssueBody, /applyReview\(result\.review\)/);
  assert.doesNotMatch(createIssueBody, /filters\.statuses|syncFilterControls|persistFilters|loadSession/);
  assert.match(reviewerSource, /bindModifiedEnter\(elements\.githubIssueTitle, \(\) => elements\.githubIssueForm\.requestSubmit\(\)\)/);
  assert.match(reviewerSource, /bindModifiedEnter\(elements\.githubIssueBody, \(\) => elements\.githubIssueForm\.requestSubmit\(\)\)/);
  assert.match(reviewerSource, /annotation\.issue_state === "ready"[^]*issue-draft-open/);
  assert.match(reviewerSource, /Issueラフを再実行/);
  assert.match(reviewerSource, /issueStatusLabel/);
  assert.match(reviewerSource, /status === "in_progress"[^]*Issue作成中/);
  assert.match(reviewerSource, /status === "resolved"[^]*Issue作成済み/);
  assert.match(reviewerSource, /annotation\.issue_url[^]*issue-reference-link/);
  assert.match(reviewerSource, /if \(annotation\.issue_state \|\| !pathsMatch/);
});

test("compact header and annotation rows maximize the review area", () => {
  const css = readFileSync(path.join(packageRoot, "src/ui/reviewer.css"), "utf8");
  assert.match(css, /\.app-header\s*\{[^}]*min-height:\s*64px;[^}]*padding:\s*8px 20px;/s);
  assert.match(css, /\.review-layout\.workflow-disabled\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/s);
  assert.match(css, /section\.sidebar-section\.annotation-section\s*\{[^}]*padding:\s*0;/s);
  assert.match(css, /\.annotation-list\s*\{[^}]*gap:\s*0;/s);
  assert.match(css, /\.annotation-card\s*\{[^}]*border:\s*0;[^}]*border-radius:\s*0;[^}]*box-shadow:\s*none;/s);
  assert.match(css, /\.annotation-card \+ \.annotation-card\s*\{[^}]*border-top:\s*1px solid var\(--line\);/s);
});

test("custom command settings stay within the dialog with long commands", () => {
  const css = readFileSync(path.join(packageRoot, "src/ui/reviewer.css"), "utf8");
  assert.match(css, /\.ai-settings-dialog\s*\{[^}]*overflow-x:\s*hidden;/s);
  assert.match(css, /\.custom-command-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto auto;/s);
  assert.match(css, /\.custom-command-row > div[^}]*min-width:\s*0;/s);
  assert.match(css, /\.custom-command-row code[^}]*max-width:\s*100%;/s);
});

test("annotation marks use translucent fills instead of red outlines", () => {
  const css = readFileSync(path.join(packageRoot, "src/ui/reviewer.css"), "utf8");
  assert.match(css, /\.review-mark\s*\{[^}]*border:\s*0;[^}]*background:\s*rgb\(217 52 43 \/ 22%\);/s);
  assert.match(css, /\.review-mark\.is-highlighted\s*\{[^}]*background:\s*rgb\(217 52 43 \/ 34%\);/s);
  assert.match(css, /\.review-mark\.is-resolved[^}]*background:\s*rgb\(92 99 97 \/ 30%\);/s);
  assert.match(reviewerSource, /if \(isResolved && annotationId\(annotation\) !== state\.highlightedId\) return/);
  assert.match(reviewerSource, /if \(status === "resolved" && state\.highlightedId === id\) state\.highlightedId = null/);
  assert.match(reviewerSource, /if \(!isResolved && annotation\.kind === "dom"\) renderStalePin/);
  assert.match(css, /\.toast-region\s*\{[^}]*top:\s*18px;[^}]*right:\s*18px;/s);
  assert.match(css, /\.draft-region\s*\{[^}]*border-color:\s*transparent;[^}]*background:\s*rgb\(217 52 43 \/ 24%\);/s);
});

test("review target renders before nonessential sidebar resources finish", () => {
  assert.match(rendererSource, /const main = surface\.contributions\.find\(\(\{ slot \}\) => slot === "review\.main"\)/);
  assert.match(rendererSource, /if \(contribution === main\) await Promise\.all\(loads\)/);
  assert.match(rendererSource, /rerender\(\);\s*if \(resourceLoads\.length\) void Promise\.all\(resourceLoads\)\.then\(\(\) => rerender\(\)\)/);
});

test("running AI shows only its start, latest status, and stop control", () => {
  assert.match(workflowSidebarSource, /"ai-run-status"/);
  assert.match(workflowSidebarSource, /"\/active\/started_at"/);
  assert.match(workflowSidebarSource, /"\/active\/latest_info"/);
  assert.match(workflowSidebarSource, /"command": "jobs\.cancel"/);
  assert.match(workflowSidebarSource, /"AI修正を停止"/);
});

test("failed annotations keep both retry and human force-resolve escape routes", () => {
  assert.match(workflowSidebarSource, /\["resolved", "failed"\][^]*"再オープン"/);
  assert.match(workflowSidebarSource, /\["open", "in_progress", "failed"\][^]*"強制的に解決"/);
});

test("declarative toasts show their remaining time and can be dismissed", () => {
  assert.match(rendererSource, /className = "toast-close"|element\("button", "toast-close"\)/);
  assert.match(rendererSource, /aria-label", "通知を閉じる"/);
  assert.match(rendererSource, /element\("span", "toast-progress"\)/);
  assert.match(rendererSource, /setProperty\("--toast-duration"/);
  assert.match(rendererSource, /setTimeout\(\(\) => dismissToast\(token\), duration\)/);
  assert.match(rendererCss, /\.toast-progress\s*\{[^}]*animation:\s*toast-countdown var\(--toast-duration\) linear forwards;/s);
  assert.match(rendererCss, /\.toast-close\s*\{[^}]*cursor:\s*pointer;/s);
});

test("active mode controls remain readable while hovered", () => {
  const css = readFileSync(path.join(packageRoot, "src/ui/reviewer.css"), "utf8");
  assert.match(css, /\.mode-button\.is-active:hover:not\(:disabled\)[^{]*\{[^}]*color:\s*white;[^}]*background:\s*var\(--ink\);/s);
});

test("HTML viewport can switch between desktop, tablet, and mobile", () => {
  for (const viewport of ["desktop", "tablet", "mobile"]) {
    assert.match(sourceHtml, new RegExp(`data-viewport=["']${viewport}["']`));
  }
  assert.match(reviewerSource, /function setViewport\(viewport\)/);
  assert.match(reviewerSource, /elements\.stage\.dataset\.viewport = viewport/);
  assert.match(reviewerSource, /viewport_mode: state\.viewport/);
  assert.match(reviewerSource, /resizeObserver\.observe\(elements\.frame\)/);
});

test("source hashes stay internal instead of showing version-change warnings", () => {
  assert.match(reviewerSource, /function renderHashWarning\(\) \{[^}]*hashWarning\.hidden = true;[^}]*textContent = "";/s);
  assert.doesNotMatch(reviewerSource, /注釈作成後に対象が更新|異なるバージョン/);
  assert.doesNotMatch(reviewerSource, /classList\.toggle\("is-stale", isAnnotationStale/);
});

test("history is fetched newest-first in explicit pages of 24", () => {
  assert.match(sourceHtml, /id="history-load-more"/);
  assert.match(reviewerSource, /HISTORY_PAGE_SIZE = 24/);
  assert.match(reviewerSource, /\/api\/archive\?offset=\$\{offset\}&limit=\$\{HISTORY_PAGE_SIZE\}/);
  assert.match(reviewerSource, /events: reset \? payload\.events : \[\.\.\.state\.archive\.events, \.\.\.payload\.events\]/);
  assert.match(reviewerSource, /elements\.historyLoadMore\.addEventListener\("click", loadMoreHistory\)/);
  assert.doesNotMatch(reviewerSource, /new IntersectionObserver/);
  assert.match(reviewerSource, /historyList\.hidden[^]*historyList\.replaceChildren\(\)/);
});

test("static HTML refreshes automatically when an AI fix becomes addressed", () => {
  assert.match(reviewerSource, /function newlyAddressedPages\(previousReview, nextReview\)/);
  assert.match(reviewerSource, /annotation\.status === "addressed" && previous\.get\(annotationId\(annotation\)\) !== "addressed"/);
  assert.match(reviewerSource, /targetKind\(\) !== "html" \|\| state\.session\?\.target\?\.live_url/);
  assert.match(reviewerSource, /state\.pendingTargetRefresh = \{ pagePath, x: win\.scrollX, y: win\.scrollY \}/);
  assert.match(reviewerSource, /win\.location\.reload\(\)/);
  assert.match(reviewerSource, /elements\.frame\.contentWindow\.scrollTo\(pending\.x, pending\.y\)/);
  assert.match(reviewerSource, /AI修正を反映するため、対象ページを自動更新しました/);
});

test("sidebar polling skips unchanged reviews and reconciles annotation cards by key", () => {
  assert.match(reviewerSource, /nextReview\.revision === state\.review\?\.revision/);
  assert.match(reviewerSource, /function annotationCardRenderKey\(annotation, number\)/);
  assert.match(reviewerSource, /card\.dataset\.renderKey !== renderKey/);
  assert.match(reviewerSource, /card\.replaceWith\(replacement\)/);
  assert.match(reviewerSource, /annotationList\.insertBefore\(card, cursor\)/);
  assert.doesNotMatch(reviewerSource, /annotationList\.replaceChildren\(\)/);
});

test("text actions submit with Command+Enter and Control+Enter", () => {
  const css = readFileSync(path.join(packageRoot, "src/ui/reviewer.css"), "utf8");
  assert.match(reviewerSource, /function bindModifiedEnter\(input, action\)/);
  assert.match(reviewerSource, /event\.key !== "Enter" \|\| \(!event\.metaKey && !event\.ctrlKey\) \|\| event\.isComposing/);
  assert.match(reviewerSource, /bindModifiedEnter\(input, \(\) => form\.requestSubmit\(\)\)/);
  assert.match(reviewerSource, /bindModifiedEnter\(elements\.commentInput, \(\) => elements\.commentForm\.requestSubmit\(\)\)/);
  assert.match(reviewerSource, /bindModifiedEnter\(input, \(\) => customCommandAdd\?\.click\(\)\)/);
  assert.match(sourceHtml, /aria-keyshortcuts="Meta\+Enter Control\+Enter"/);
  assert.match(css, /\.reply-input\s*\{[^}]*height:\s*40px;[^}]*box-sizing:\s*border-box;/s);
  assert.match(css, /\.reply-button\s*\{[^}]*height:\s*40px;[^}]*box-sizing:\s*border-box;/s);
});

test("reply text survives polling and sidebar rerenders", () => {
  assert.match(reviewerSource, /const replyDrafts = new Map\(\)/);
  assert.match(reviewerSource, /input\.value = replyDrafts\.get\(id\) \?\? ""/);
  assert.match(reviewerSource, /replyDrafts\.set\(id, input\.value\)/);
  assert.match(reviewerSource, /document\.activeElement\?\.classList\.contains\("reply-input"\)/);
  assert.match(reviewerSource, /replyDrafts\.delete\(id\);\s*applyReview\(review\)/s);
});

test("annotation focus restores hidden interactive context before highlighting", () => {
  assert.match(reviewerSource, /function dismissUnrelatedTransientContexts\(node\)/);
  assert.match(reviewerSource, /function revealAnchorContext\(node\)/);
  assert.match(reviewerSource, /\[aria-controls\], \[data-open-layer\]/);
  assert.match(reviewerSource, /context\.showModal\(\)/);
  assert.match(reviewerSource, /context\.hidden = false/);
  assert.match(reviewerSource, /dismissUnrelatedTransientContexts\(node\)/);
  assert.match(reviewerSource, /revealAnchorContext\(node\)/);
  assert.match(reviewerSource, /注釈を作成したモーダル・メニューを再表示しました/);
});

test("build copies legacy assets after TypeScript without deleting compiled jobs", () => {
  const packageJson = readFileSync(path.join(packageRoot, "package.json"), "utf8");
  const copyScript = readFileSync(path.join(packageRoot, "scripts/copy-ui.mjs"), "utf8");
  assert.match(packageJson, /copy-ui\.mjs --clean && tsc -p tsconfig\.json && node scripts\/copy-ui\.mjs && node scripts\/make-cli-executable\.mjs/);
  assert.doesNotMatch(copyScript, /rmSync\(destination/);
  for (const uiAsset of ["index.html", "renderer.html", "renderer.css", "renderer.js", "reviewer.css", "reviewer.js"]) {
    assert.match(copyScript, new RegExp(`"${uiAsset.replace(".", "\\.")}"`));
  }
  assert.doesNotMatch(copyScript, /"jobs\.js"/);
});
