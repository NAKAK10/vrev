type ReviewCli = "opencode" | "claude" | "codex";
type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";

interface SessionPayload {
  target?: { allow_scripts?: boolean; ai_jobs_enabled?: boolean };
  review?: {
    annotations?: Array<{ status?: string }>;
  };
}

interface ReviewJob {
  id: string;
  batch_id: string;
  annotation_id: string;
  cli: ReviewCli;
  state: JobState;
  summary: string;
  exit_code: number | null;
  started: string | null;
  finished: string | null;
}

interface JobListPayload {
  jobs: ReviewJob[];
}

interface EnqueuePayload {
  batch_id: string;
  jobs: ReviewJob[];
}

const ACTIVE_STATES: ReadonlySet<JobState> = new Set(["queued", "running"]);
const CLI_LABELS: Record<ReviewCli, string> = {
  opencode: "OpenCode",
  claude: "Claude",
  codex: "Codex",
};

function element<T extends Element>(selector: string, type: { new (): T }): T {
  const value = document.querySelector(selector);
  if (!(value instanceof type)) throw new Error(`required UI element missing: ${selector}`);
  return value;
}

const form = element("#ai-batch-form", HTMLFormElement);
const cliSelect = element("#ai-cli", HTMLSelectElement);
const parallelSelect = element("#ai-max-parallel", HTMLSelectElement);
const autoRunCheckbox = element("#ai-auto-run", HTMLInputElement);
const submitButton = element("#ai-batch-submit", HTMLButtonElement);
const openCountElement = element("#ai-open-count", HTMLSpanElement);
const jobPanel = element("#ai-job-panel", HTMLDivElement);
let statusElement: HTMLParagraphElement | null = null;

let openCount = 0;
let submitting = false;
let hasActiveJobs = false;
let aiJobsEnabled = true;
let activeBatchIds = new Set<string>();
let sessionTimer: number | undefined;
let jobsTimer: number | undefined;
let autoRunTimer: number | undefined;
let destroyed = false;

const AUTO_RUN_STORAGE_KEY = "visual-review:auto-run";
autoRunCheckbox.checked = window.localStorage.getItem(AUTO_RUN_STORAGE_KEY) === "true";

function isCli(value: string): value is ReviewCli {
  return value === "opencode" || value === "claude" || value === "codex";
}

function selectedCli(): ReviewCli {
  if (!isCli(cliSelect.value)) throw new Error("CLIの選択が不正です。");
  return cliSelect.value;
}

function setStatus(message: string, error = false): void {
  if (!message) {
    statusElement?.remove();
    statusElement = null;
    return;
  }
  if (statusElement === null) {
    statusElement = document.createElement("p");
    statusElement.id = "ai-job-status";
    statusElement.className = "ai-job-status";
    statusElement.setAttribute("role", "status");
    statusElement.setAttribute("aria-live", "polite");
    jobPanel.before(statusElement);
  }
  statusElement.textContent = message;
  statusElement.classList.toggle("is-error", error);
}

function updateSubmitState(): void {
  submitButton.disabled = !aiJobsEnabled || submitting || hasActiveJobs || openCount === 0;
}

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    if (typeof payload === "object" && payload !== null) {
      const record = payload as Record<string, unknown>;
      const candidate = record.error ?? record.message;
      if (typeof candidate === "string") detail = candidate;
    }
    throw new Error(detail);
  }
  return payload;
}

function sessionOpenCount(payload: unknown): number {
  if (typeof payload !== "object" || payload === null) throw new Error("session response is invalid");
  const annotations = (payload as SessionPayload).review?.annotations;
  if (!Array.isArray(annotations)) return 0;
  return annotations.filter((annotation) => annotation.status === "open").length;
}

function sessionAllowsAiJobs(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const target = (payload as SessionPayload).target;
  if (typeof target?.ai_jobs_enabled === "boolean") return target.ai_jobs_enabled;
  return target?.allow_scripts !== true;
}

function parseJobs(payload: unknown): ReviewJob[] {
  if (typeof payload !== "object" || payload === null || !Array.isArray((payload as Partial<JobListPayload>).jobs)) {
    throw new Error("jobs response is invalid");
  }
  return (payload as JobListPayload).jobs;
}

function formatTime(value: string | null): string {
  if (value === null) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("ja-JP");
}

function textNode(tag: keyof HTMLElementTagNameMap, className: string, value: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = value;
  return node;
}

function renderJobs(jobs: ReviewJob[]): void {
  const cards = [...jobs].reverse().map((job) => {
    const card = document.createElement("article");
    card.className = "job-card";

    const heading = document.createElement("div");
    heading.className = "job-card-heading";
    heading.append(
      textNode("span", "job-annotation-id", `#${job.annotation_id.slice(0, 8)}`),
      textNode("span", "job-state", job.state),
    );
    const state = heading.lastElementChild;
    if (state instanceof HTMLElement) state.dataset.state = job.state;

    const summary = textNode("p", "job-summary", job.summary || "—");
    const meta = document.createElement("div");
    meta.className = "job-card-meta";
    meta.append(
      textNode("span", "job-cli", CLI_LABELS[job.cli] ?? job.cli),
      textNode("span", "job-exit-code", `exit: ${job.exit_code ?? "—"}`),
    );
    if (ACTIVE_STATES.has(job.state)) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "job-cancel";
      cancel.textContent = "キャンセル";
      cancel.addEventListener("click", () => void cancelJob(job.id, cancel));
      meta.append(cancel);
    }

    const times = document.createElement("div");
    times.className = "job-card-times";
    times.append(
      textNode("span", "job-started", `開始: ${formatTime(job.started)}`),
      textNode("span", "job-finished", `終了: ${formatTime(job.finished)}`),
    );
    card.append(heading, summary, meta, times);
    return card;
  });
  jobPanel.replaceChildren(...cards);
}

async function refreshSession(reportError = false): Promise<void> {
  try {
    const payload = await requestJson("/api/session");
    openCount = sessionOpenCount(payload);
    aiJobsEnabled = sessionAllowsAiJobs(payload);
    openCountElement.textContent = String(openCount);
    if (!aiJobsEnabled) setStatus("対象スクリプト有効時のAI修正には、server起動時の明示許可が必要です。", true);
    updateSubmitState();
  } catch (error) {
    if (reportError) setStatus(`未対応件数を取得できません：${error instanceof Error ? error.message : String(error)}`, true);
  }
}

function scheduleSessionPoll(): void {
  if (sessionTimer !== undefined) window.clearTimeout(sessionTimer);
  if (destroyed) return;
  sessionTimer = window.setTimeout(() => {
    void refreshSession().finally(scheduleSessionPoll);
  }, 5000);
}

function scheduleJobsPoll(): void {
  if (jobsTimer !== undefined) window.clearTimeout(jobsTimer);
  jobsTimer = undefined;
  if (destroyed) return;
  jobsTimer = window.setTimeout(() => void refreshJobs(), 5000);
}


function terminalSummary(jobs: ReviewJob[], batchIds: Set<string>): string {
  const completed = jobs.filter((job) => batchIds.has(job.batch_id));
  const count = (state: JobState): number => completed.filter((job) => job.state === state).length;
  return `バッチ終了：成功${count("succeeded")} / 失敗${count("failed")} / キャンセル${count("cancelled")} / スキップ${count("skipped")}`;
}

async function refreshJobs(): Promise<void> {
  if (!aiJobsEnabled) { scheduleJobsPoll(); return; }
  const previouslyActive = new Set(activeBatchIds);
  try {
    const jobs = parseJobs(await requestJson("/api/jobs"));
    renderJobs(jobs);
    hasActiveJobs = jobs.some((job) => ACTIVE_STATES.has(job.state));
    activeBatchIds = new Set(jobs.filter((job) => ACTIVE_STATES.has(job.state)).map((job) => job.batch_id));
    updateSubmitState();
    const completedBatches = new Set([...previouslyActive].filter((id) => !activeBatchIds.has(id)));
    if (completedBatches.size > 0) {
      const summary = terminalSummary(jobs, completedBatches);
      setStatus(summary, jobs.filter((job) => completedBatches.has(job.batch_id)).every((job) => job.state !== "succeeded"));
      await refreshSession(true);
    }
  } catch (error) {
    setStatus(`ジョブ状態を取得できません：${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    scheduleJobsPoll();
  }
}

async function cancelJob(id: string, button: HTMLButtonElement): Promise<void> {
  const state = button.closest(".job-card")?.querySelector<HTMLElement>(".job-state")?.dataset.state;
  if (state === "running" && !window.confirm("実行中ジョブのキャンセルは同じbatch coordinator全体を停止し、batch内の実行中ジョブをすべてキャンセルします。続行しますか？")) return;
  button.disabled = true;
  try {
    await requestJson(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
    setStatus(state === "running" ? "batch coordinator全体のキャンセルを要求しました。" : "このqueuedジョブをキャンセルしました。");
    await refreshJobs();
  } catch (error) {
    button.disabled = false;
    setStatus(`キャンセルできません：${error instanceof Error ? error.message : String(error)}`, true);
  }
}

async function enqueueOpenAnnotations(automatic: boolean): Promise<void> {
  if (submitting || (!automatic && hasActiveJobs)) return;
  await refreshSession(true);
  if (openCount === 0) {
    if (!automatic) setStatus("依頼できる未対応注釈はありません。", true);
    return;
  }

  const cli = selectedCli();
  const maxParallel = Number(parallelSelect.value);
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 10) {
    setStatus("最大並列数は1〜10で選択してください。", true);
    return;
  }
  if (!automatic && !window.confirm(`${openCount}件の未対応注釈を${CLI_LABELS[cli]}（最大並列${maxParallel}）へ依頼しますか？`)) return;

  submitting = true;
  updateSubmitState();
  setStatus(automatic ? "注釈を保存したため、AI修正を自動登録しています…" : "AI修正ジョブを登録しています…");
  try {
    const payload = await requestJson("/api/jobs/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cli, max_parallel: maxParallel }),
    });
    if (typeof payload !== "object" || payload === null || !Array.isArray((payload as Partial<EnqueuePayload>).jobs)) {
      throw new Error("batch response is invalid");
    }
    const jobs = (payload as EnqueuePayload).jobs;
    renderJobs(jobs);
    hasActiveJobs = hasActiveJobs || jobs.some((job) => ACTIVE_STATES.has(job.state));
    for (const job of jobs) if (ACTIVE_STATES.has(job.state)) activeBatchIds.add(job.batch_id);
    setStatus(jobs.length === 0 ? "新しく登録できるジョブはありませんでした。" : `${jobs.length}件のジョブを${automatic ? "自動" : ""}登録しました。`);
    if (!hasActiveJobs) await refreshSession(true);
  } catch (error) {
    setStatus(`AI修正を依頼できません：${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    submitting = false;
    updateSubmitState();
    scheduleJobsPoll();
  }
}

async function submitBatch(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  await enqueueOpenAnnotations(false);
}

function scheduleAutoRun(): void {
  if (!autoRunCheckbox.checked || destroyed) return;
  if (autoRunTimer !== undefined) window.clearTimeout(autoRunTimer);
  autoRunTimer = window.setTimeout(() => {
    autoRunTimer = undefined;
    if (submitting) scheduleAutoRun();
    else void enqueueOpenAnnotations(true);
  }, 300);
}

function destroy(): void {
  destroyed = true;
  if (sessionTimer !== undefined) window.clearTimeout(sessionTimer);
  if (jobsTimer !== undefined) window.clearTimeout(jobsTimer);
  if (autoRunTimer !== undefined) window.clearTimeout(autoRunTimer);
}

form.addEventListener("submit", (event) => void submitBatch(event));
autoRunCheckbox.addEventListener("change", () => {
  window.localStorage.setItem(AUTO_RUN_STORAGE_KEY, String(autoRunCheckbox.checked));
  setStatus(autoRunCheckbox.checked ? "自動実行を有効にしました。次に保存した注釈からAI修正を開始します。" : "自動実行を無効にしました。");
});
window.addEventListener("visual-review:annotation-created", scheduleAutoRun);
window.addEventListener("focus", () => void Promise.all([refreshSession(), refreshJobs()]));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void Promise.all([refreshSession(), refreshJobs()]);
});
window.addEventListener("pagehide", destroy, { once: true });

void Promise.all([refreshSession(true), refreshJobs()]);
scheduleSessionPoll();
