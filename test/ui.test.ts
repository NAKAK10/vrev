import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const packageRoot = process.cwd();
const sourceHtml = readFileSync(path.join(packageRoot, "src/ui/index.html"), "utf8");
const reviewerSource = readFileSync(path.join(packageRoot, "src/ui/reviewer.js"), "utf8");
const jobsSource = readFileSync(path.join(packageRoot, "src/ui/jobs.ts"), "utf8");

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
  assert.match(sourceHtml, /id="custom-command-add"/);
  assert.match(sourceHtml, /name="annotation-status" value="in_progress" checked/);
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
  assert.match(reviewerSource, /visual-review:annotation-reopened[^]*reason: "human-reply"/);
  assert.match(reviewerSource, /visual-review:annotation-reopened[^]*reason: "manual-reopen"/);
  assert.match(jobsSource, /enqueueOpenAnnotations\(true\)/);
  assert.match(jobsSource, /visual-review:auto-run/);
  assert.match(jobsSource, /settingsDialog\.showModal\(\)/);
  assert.match(jobsSource, /form\.hidden = autoRunCheckbox\.checked/);
  assert.match(jobsSource, /visual-review:custom-commands/);
  assert.match(jobsSource, /custom_name: custom\.name, custom_command: custom\.command/);
  assert.match(jobsSource, /\/api\/jobs\/custom-command\/test/);
  assert.match(jobsSource, /duration_ms/);
  assert.match(jobsSource, /実際の修正も遅くなる可能性があります/);
  assert.match(jobsSource, /command\.match\(\/\\\{prompt\\\}\/g/);
  assert.match(jobsSource, /verified: item\.verified === true/);
  assert.match(jobsSource, /selectedUnverifiedCustom/);
  assert.match(jobsSource, /安全のため自動実行を無効にしました/);
  assert.match(sourceHtml, /id="custom-command-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(jobsSource, /setCustomStatus\(`登録できません/);
  assert.match(sourceHtml, /テストして登録/);
  assert.match(sourceHtml, /\{prompt\}.*必ず1回/);
  assert.doesNotMatch(sourceHtml, /id=["']ai-session-id["']/);
  assert.doesNotMatch(sourceHtml, /id=["']ai-session-note["']/);
  assert.doesNotMatch(sourceHtml, /id=["']ai-attach-url["']/);
  assert.doesNotMatch(sourceHtml, /id=["']ai-job-status["']/);
  assert.doesNotMatch(jobsSource, /sessionInput|session_id:|attachInput|opencode_attach:/);
  assert.doesNotMatch(sourceHtml, /セッションは選択したCLIが自動作成します/);
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
  assert.match(reviewerSource, /DEFAULT_STATUS_FILTERS = \["open", "in_progress", "addressed"\]/);
  assert.match(reviewerSource, /DEFAULT_KIND_FILTERS = \["dom", "region"\]/);
  assert.match(reviewerSource, /filterDialog\.showModal\(\)/);
  assert.match(reviewerSource, /new Set\(elements\.statusFilterInputs/);
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
  assert.match(css, /\.draft-region\s*\{[^}]*border-color:\s*transparent;[^}]*background:\s*rgb\(217 52 43 \/ 24%\);/s);
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

test("stale-source hints are low-priority and limited to open annotations", () => {
  assert.match(reviewerSource, /\(annotation\.status \?\? "open"\) !== "open"\) return ""/);
  assert.match(reviewerSource, /\(annotation\.status \?\? "open"\) === "open"[^]*annotation\.source_hash !== fileState\.sha256/);
  assert.match(reviewerSource, /参考：未対応の注釈\$\{stale\.length\}件/);
  assert.doesNotMatch(reviewerSource, /注意：.*異なるバージョン/);
});

test("history is newest-first and lazy-renders 24 events at a time", () => {
  assert.match(sourceHtml, /id="history-load-more"/);
  assert.match(reviewerSource, /HISTORY_PAGE_SIZE = 24/);
  assert.match(reviewerSource, /eventTime\(right\) - eventTime\(left\)/);
  assert.match(reviewerSource, /sorted\.slice\(0, state\.historyRenderLimit\)/);
  assert.match(reviewerSource, /historyRenderLimit \+= HISTORY_PAGE_SIZE/);
  assert.match(reviewerSource, /new IntersectionObserver/);
  assert.match(reviewerSource, /historyList\.hidden[^]*historyList\.replaceChildren\(\)/);
});

test("sidebar polling skips unchanged reviews and reconciles annotation cards by key", () => {
  assert.match(reviewerSource, /nextReview\.revision === state\.review\?\.revision/);
  assert.match(reviewerSource, /function annotationCardRenderKey\(annotation, number\)/);
  assert.match(reviewerSource, /card\.dataset\.renderKey !== renderKey/);
  assert.match(reviewerSource, /card\.replaceWith\(replacement\)/);
  assert.match(reviewerSource, /annotationList\.insertBefore\(card, cursor\)/);
  assert.doesNotMatch(reviewerSource, /annotationList\.replaceChildren\(\)/);
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
  for (const legacyAsset of ["index.html", "reviewer.css", "reviewer.js"]) {
    assert.match(copyScript, new RegExp(`"${legacyAsset.replace(".", "\\.")}"`));
  }
  assert.doesNotMatch(copyScript, /"jobs\.js"/);
});
