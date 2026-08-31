type ReviewCli = "opencode" | "claude" | "codex" | "copilot" | "pi" | "custom";
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

interface CustomCommand {
  runner_id: string;
  name: string;
  verified: boolean;
  probe_ms: number | null;
}

interface EnqueuePayload {
  batch_id: string;
  jobs: ReviewJob[];
}

interface AnnotationFlowPolicy {
  events: Array<"annotation-created" | "annotation-reopened">;
  debounceMs: number;
  settings: {
    runner: { label: string; options: Array<{ value: Exclude<ReviewCli, "custom">; label: string }> };
    maxParallel: { label: string; min: number; max: number; defaultValue: number };
    autoRun: { label: string };
  };
}

const ACTIVE_STATES: ReadonlySet<JobState> = new Set(["queued", "running"]);
const CLI_LABELS: Record<ReviewCli, string> = {
  opencode: "OpenCode",
  claude: "Claude",
  codex: "Codex",
  copilot: "GitHub Copilot",
  pi: "Pi",
  custom: "Custom",
};

function element<T extends Element>(selector: string, type: { new (): T }): T {
  const value = document.querySelector(selector);
  if (!(value instanceof type)) throw new Error(`required UI element missing: ${selector}`);
  return value;
}

const reviewLayout = element(".review-layout", HTMLElement);
const reviewSidebar = element(".review-sidebar", HTMLElement);
const aiJobsSection = element(".ai-jobs-section", HTMLElement);
const form = element("#ai-batch-form", HTMLFormElement);
const settingsOpenButton = element("#ai-settings-open", HTMLButtonElement);
const settingsDialog = element("#ai-settings-dialog", HTMLDialogElement);
const settingsCloseButton = element("[data-ai-settings-close]", HTMLButtonElement);
const cliSelect = element("#ai-cli", HTMLSelectElement);
const customOptions = element("#ai-custom-options", HTMLOptGroupElement);
const parallelSelect = element("#ai-max-parallel", HTMLSelectElement);
const autoRunCheckbox = element("#ai-auto-run", HTMLInputElement);
const submitButton = element("#ai-batch-submit", HTMLButtonElement);
const openCountElement = element("#ai-open-count", HTMLSpanElement);
let statusElement: HTMLParagraphElement | null = null;

let openCount = 0;
let submitting = false;
let hasActiveJobs = false;
let aiJobsEnabled = true;
let activeBatchIds = new Set<string>();
let sessionTimer: number | undefined;
let jobsTimer: number | undefined;
let autoRunTimer: number | undefined;
let annotationFlowPolicy: AnnotationFlowPolicy | null = null;
let annotationFlowLoading = true;
let annotationWorkflowEnabled = false;
let customCommandEnabled = false;
const pendingAnnotationFlowEvents = new Set<"annotation-created" | "annotation-reopened">();
let destroyed = false;

const AUTO_RUN_STORAGE_KEY = "visual-review:auto-run";
const CLI_STORAGE_KEY = "visual-review:cli";
const PARALLEL_STORAGE_KEY = "visual-review:max-parallel";
let customCommands: CustomCommand[] = [];
const storedParallel = window.localStorage.getItem(PARALLEL_STORAGE_KEY);
if (storedParallel !== null && Number(storedParallel) >= 1 && Number(storedParallel) <= 10) parallelSelect.value = storedParallel;
autoRunCheckbox.checked = window.localStorage.getItem(AUTO_RUN_STORAGE_KEY) === "true";
form.hidden = autoRunCheckbox.checked;

function isCli(value: string): value is Exclude<ReviewCli, "custom"> {
  return value === "opencode" || value === "claude" || value === "codex" || value === "copilot" || value === "pi";
}

function renderCustomCommands(enabled = customCommandEnabled): void {
  customOptions.replaceChildren(...customCommands.filter(({ verified }) => enabled && verified).map((item) => {
    const option = document.createElement("option");
    option.value = `custom:${item.runner_id}`;
    option.textContent = item.name;
    return option;
  }));
}

function selectedConfiguration(): { cli: ReviewCli; runner_id?: string } {
  if (isCli(cliSelect.value)) return { cli: cliSelect.value };
  const runnerId = cliSelect.value.startsWith("custom:") ? cliSelect.value.slice(7) : "";
  const custom = customCommands.find((item) => item.runner_id === runnerId);
  if (!custom?.verified) throw new Error("外部AIコマンドは登録前にテストしてください。");
  return { cli: "custom", runner_id: custom.runner_id };
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
    form.before(statusElement);
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

async function refreshSession(reportError = false): Promise<void> {
  try {
    const payload = await requestJson("/api/session");
    openCount = sessionOpenCount(payload);
    aiJobsEnabled = sessionAllowsAiJobs(payload);
    window.dispatchEvent(new CustomEvent("visual-review:session-refreshed", { detail: payload }));
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

async function enqueueOpenAnnotations(automatic: boolean): Promise<void> {
  if (!annotationWorkflowEnabled || submitting || (!automatic && hasActiveJobs)) return;
  await refreshSession(true);
  if (openCount === 0) {
    if (!automatic) setStatus("依頼できる未対応注釈はありません。", true);
    return;
  }

  const configuration = selectedConfiguration();
  const maxParallel = Number(parallelSelect.value);
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 10) {
    setStatus("最大並列数は1〜10で選択してください。", true);
    return;
  }
  const cliLabel = configuration.runner_id
    ? customCommands.find(({ runner_id }) => runner_id === configuration.runner_id)?.name ?? CLI_LABELS.custom
    : CLI_LABELS[configuration.cli];
  if (!automatic && !window.confirm(`${openCount}件の未対応注釈を${cliLabel}（最大並列${maxParallel}）へ依頼しますか？`)) return;

  submitting = true;
  updateSubmitState();
  setStatus(automatic ? "注釈を保存したため、AI修正を自動登録しています…" : "AI修正ジョブを登録しています…");
  try {
    const payload = await requestJson("/api/jobs/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...configuration, max_parallel: maxParallel }),
    });
    if (typeof payload !== "object" || payload === null || !Array.isArray((payload as Partial<EnqueuePayload>).jobs)) {
      throw new Error("batch response is invalid");
    }
    const jobs = (payload as EnqueuePayload).jobs;
    hasActiveJobs = hasActiveJobs || jobs.some((job) => ACTIVE_STATES.has(job.state));
    for (const job of jobs) if (ACTIVE_STATES.has(job.state)) activeBatchIds.add(job.batch_id);
    setStatus(jobs.length === 0 ? "新しく登録できるジョブはありませんでした。" : `${jobs.length}件のジョブを${automatic ? "自動" : ""}登録しました。`);
    await refreshSession(true);
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

function validAnnotationFlowPolicy(value: unknown): value is AnnotationFlowPolicy {
  if (typeof value !== "object" || value === null) return false;
  const policy = value as Partial<AnnotationFlowPolicy>;
  const allowed = new Set(["annotation-created", "annotation-reopened"]);
  const settings = policy.settings;
  return Array.isArray(policy.events) && policy.events.length > 0 && policy.events.every((event) => allowed.has(event))
    && Number.isInteger(policy.debounceMs) && Number(policy.debounceMs) >= 0 && Number(policy.debounceMs) <= 5_000
    && typeof settings?.runner?.label === "string" && Array.isArray(settings.runner.options) && settings.runner.options.length > 0
    && settings.runner.options.every(({ value, label }) => isCli(value) && typeof label === "string" && Boolean(label.trim()))
    && typeof settings.maxParallel?.label === "string" && Number.isInteger(settings.maxParallel.min) && Number.isInteger(settings.maxParallel.max)
    && Number.isInteger(settings.maxParallel.defaultValue) && settings.maxParallel.min >= 1 && settings.maxParallel.max <= 10
    && settings.maxParallel.defaultValue >= settings.maxParallel.min && settings.maxParallel.defaultValue <= settings.maxParallel.max
    && typeof settings.autoRun?.label === "string" && Boolean(settings.autoRun.label.trim());
}

function applyAnnotationFlowSettings(policy: AnnotationFlowPolicy, allowCustomCommands: boolean): void {
  const runnerLabel = document.querySelector('label[for="ai-cli"] > span');
  const parallelLabel = document.querySelector('label[for="ai-max-parallel"] > span');
  const autoRunLabel = document.querySelector('label[for="ai-auto-run"] > span');
  if (!(runnerLabel instanceof HTMLSpanElement) || !(parallelLabel instanceof HTMLSpanElement) || !(autoRunLabel instanceof HTMLSpanElement)) {
    throw new Error("annotation workflow settings slots are missing");
  }
  runnerLabel.textContent = policy.settings.runner.label;
  parallelLabel.textContent = policy.settings.maxParallel.label;
  autoRunLabel.textContent = policy.settings.autoRun.label;
  for (const option of [...cliSelect.querySelectorAll(":scope > option")]) option.remove();
  for (const item of policy.settings.runner.options) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    cliSelect.insertBefore(option, customOptions);
  }
  customCommandEnabled = allowCustomCommands;
  renderCustomCommands(allowCustomCommands);
  parallelSelect.replaceChildren(...Array.from(
    { length: policy.settings.maxParallel.max - policy.settings.maxParallel.min + 1 },
    (_, offset) => {
      const value = String(policy.settings.maxParallel.min + offset);
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      return option;
    },
  ));
  const configuredCli = window.localStorage.getItem(CLI_STORAGE_KEY);
  const builtInValues = new Set(policy.settings.runner.options.map(({ value }) => value));
  const customAvailable = allowCustomCommands && customCommands.some(({ runner_id, verified }) => verified && configuredCli === `custom:${runner_id}`);
  const fallback = builtInValues.has("claude") ? "claude" : policy.settings.runner.options[0]!.value;
  const effectiveCli = configuredCli && ((isCli(configuredCli) && builtInValues.has(configuredCli)) || customAvailable) ? configuredCli : fallback;
  cliSelect.value = effectiveCli;
  window.localStorage.setItem(CLI_STORAGE_KEY, effectiveCli);
  const configuredParallel = Number(window.localStorage.getItem(PARALLEL_STORAGE_KEY));
  parallelSelect.value = Number.isInteger(configuredParallel) && configuredParallel >= policy.settings.maxParallel.min && configuredParallel <= policy.settings.maxParallel.max
    ? String(configuredParallel)
    : String(policy.settings.maxParallel.defaultValue);
}

async function loadAnnotationFlowPolicy(): Promise<void> {
  try {
    const payload = await requestJson("/api/plugins/annotation-flow");
    const response = typeof payload === "object" && payload !== null
      ? payload as { enabled?: unknown; reason?: unknown; policy?: unknown; custom_command_enabled?: unknown }
      : {};
    if (response.enabled === false) {
      annotationWorkflowEnabled = false;
      annotationFlowPolicy = null;
      annotationFlowLoading = false;
      customCommandEnabled = response.custom_command_enabled === true;
      pendingAnnotationFlowEvents.clear();
      if (autoRunTimer !== undefined) window.clearTimeout(autoRunTimer);
      autoRunTimer = undefined;
      autoRunCheckbox.checked = false;
      autoRunCheckbox.disabled = true;
      window.localStorage.setItem(AUTO_RUN_STORAGE_KEY, "false");
      if (settingsDialog.open) settingsDialog.close();
      setStatus("");
      aiJobsSection.hidden = true;
      reviewSidebar.hidden = true;
      reviewLayout.classList.add("workflow-disabled");
      return;
    }
    if (response.enabled !== true || !validAnnotationFlowPolicy(response.policy)) throw new Error("annotation workflow plugin is unavailable");
    customCommands = response.custom_command_enabled === true
      ? ((await requestJson("/api/jobs/custom-commands")) as { runners?: CustomCommand[] }).runners ?? []
      : [];
    applyAnnotationFlowSettings(response.policy, response.custom_command_enabled === true);
    annotationFlowPolicy = response.policy;
    annotationFlowLoading = false;
    annotationWorkflowEnabled = true;
    autoRunCheckbox.disabled = false;
    aiJobsSection.hidden = false;
    reviewSidebar.hidden = false;
    reviewLayout.classList.remove("workflow-disabled");
    for (const eventName of pendingAnnotationFlowEvents) scheduleAutoRun(eventName);
    pendingAnnotationFlowEvents.clear();
  } catch (error) {
    annotationWorkflowEnabled = false;
    annotationFlowPolicy = null;
    annotationFlowLoading = false;
    pendingAnnotationFlowEvents.clear();
    autoRunCheckbox.checked = false;
    autoRunCheckbox.disabled = true;
    aiJobsSection.hidden = true;
    reviewSidebar.hidden = true;
    reviewLayout.classList.add("workflow-disabled");
    window.localStorage.setItem(AUTO_RUN_STORAGE_KEY, "false");
    console.error(`annotation workflow plugin unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function scheduleAutoRun(eventName: "annotation-created" | "annotation-reopened"): void {
  if (!annotationWorkflowEnabled || !autoRunCheckbox.checked || destroyed) return;
  if (annotationFlowLoading) {
    pendingAnnotationFlowEvents.add(eventName);
    return;
  }
  if (!annotationFlowPolicy?.events.includes(eventName)) return;
  if (autoRunTimer !== undefined) window.clearTimeout(autoRunTimer);
  autoRunTimer = window.setTimeout(() => {
    autoRunTimer = undefined;
    if (submitting) scheduleAutoRun(eventName);
    else void enqueueOpenAnnotations(true);
  }, annotationFlowPolicy.debounceMs);
}

function destroy(): void {
  destroyed = true;
  if (sessionTimer !== undefined) window.clearTimeout(sessionTimer);
  if (jobsTimer !== undefined) window.clearTimeout(jobsTimer);
  if (autoRunTimer !== undefined) window.clearTimeout(autoRunTimer);
}

form.addEventListener("submit", (event) => void submitBatch(event));
settingsOpenButton.addEventListener("click", () => { window.location.href = "/settings/plugins#annotation-workflow"; });
settingsCloseButton.addEventListener("click", () => settingsDialog.close());
cliSelect.addEventListener("change", () => window.localStorage.setItem(CLI_STORAGE_KEY, cliSelect.value));
parallelSelect.addEventListener("change", () => window.localStorage.setItem(PARALLEL_STORAGE_KEY, parallelSelect.value));
autoRunCheckbox.addEventListener("change", () => {
  window.localStorage.setItem(AUTO_RUN_STORAGE_KEY, String(autoRunCheckbox.checked));
  form.hidden = autoRunCheckbox.checked;
  setStatus(autoRunCheckbox.checked ? "自動実行を有効にしました。次に保存した注釈からAI修正を開始します。" : "自動実行を無効にしました。");
});
window.addEventListener("visual-review:annotation-created", () => scheduleAutoRun("annotation-created"));
window.addEventListener("visual-review:annotation-reopened", () => scheduleAutoRun("annotation-reopened"));
window.addEventListener("focus", () => void Promise.all([refreshSession(), refreshJobs(), loadAnnotationFlowPolicy()]));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void Promise.all([refreshSession(), refreshJobs(), loadAnnotationFlowPolicy()]);
});
window.addEventListener("pagehide", destroy, { once: true });

void Promise.all([refreshSession(true), refreshJobs(), loadAnnotationFlowPolicy()]);
scheduleSessionPoll();
