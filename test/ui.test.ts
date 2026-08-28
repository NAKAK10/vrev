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
    "ai-cli",
    "ai-max-parallel",
    "ai-auto-run",
    "ai-open-count",
    "ai-batch-submit",
    "ai-job-panel",
  ]) {
    assert.match(sourceHtml, new RegExp(`id=["']${id}["']`), id);
  }
  assert.match(sourceHtml, /<option value="10">10<\/option>/);
  assert.match(sourceHtml, /<script type="module" src="jobs\.js"><\/script>/);
  assert.ok(existsSync(path.join(packageRoot, "dist/src/ui/jobs.js")));
});

test("jobs UI uses the job APIs without unsafe HTML rendering", () => {
  assert.match(jobsSource, /requestJson\("\/api\/session"/);
  assert.match(jobsSource, /requestJson\("\/api\/jobs"/);
  assert.match(jobsSource, /requestJson\("\/api\/jobs\/batch"/);
  assert.match(jobsSource, /\/api\/jobs\/\$\{encodeURIComponent\(id\)\}\/cancel/);
  assert.doesNotMatch(jobsSource, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(jobsSource, /\.textContent\s*=/);
  assert.match(jobsSource, /statusElement = document\.createElement\("p"\)/);
  assert.match(jobsSource, /statusElement\.setAttribute\("aria-live", "polite"\)/);
  assert.match(jobsSource, /window\.addEventListener\("focus".*refreshJobs/);
  assert.match(jobsSource, /setTimeout\(\(\) => void refreshJobs\(\), 5000\)/);
  assert.match(jobsSource, /成功.*失敗.*キャンセル.*スキップ/);
  assert.match(jobsSource, /running.*batch coordinator全体/s);
  assert.match(jobsSource, /target\?\.ai_jobs_enabled/);
  assert.match(jobsSource, /target\?\.allow_scripts !== true/);
  assert.match(jobsSource, /visual-review:annotation-created/);
  assert.match(jobsSource, /enqueueOpenAnnotations\(true\)/);
  assert.match(jobsSource, /visual-review:auto-run/);
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
