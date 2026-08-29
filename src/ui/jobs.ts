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
  custom_name: string | null;
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
  id: string;
  name: string;
  command: string;
  verified: boolean;
  probe_ms?: number;
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
  copilot: "GitHub Copilot",
  pi: "Pi",
  custom: "Custom",
};

function element<T extends Element>(selector: string, type: { new (): T }): T {
  const value = document.querySelector(selector);
  if (!(value instanceof type)) throw new Error(`required UI element missing: ${selector}`);
  return value;
}

const form = element("#ai-batch-form", HTMLFormElement);
const settingsOpenButton = element("#ai-settings-open", HTMLButtonElement);
const settingsDialog = element("#ai-settings-dialog", HTMLDialogElement);
const settingsCloseButton = element("[data-ai-settings-close]", HTMLButtonElement);
const cliSelect = element("#ai-cli", HTMLSelectElement);
const customOptions = element("#ai-custom-options", HTMLOptGroupElement);
const customNameInput = element("#custom-command-name", HTMLInputElement);
const customCommandInput = element("#custom-command-value", HTMLInputElement);
const customAddButton = element("#custom-command-add", HTMLButtonElement);
const customStatusElement = element("#custom-command-status", HTMLParagraphElement);
const customCommandList = element("#custom-command-list", HTMLDivElement);
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
let destroyed = false;

const AUTO_RUN_STORAGE_KEY = "visual-review:auto-run";
const CLI_STORAGE_KEY = "visual-review:cli";
const PARALLEL_STORAGE_KEY = "visual-review:max-parallel";
const CUSTOM_COMMANDS_STORAGE_KEY = "visual-review:custom-commands";
let customCommands = loadCustomCommands();
renderCustomCommands();
const storedCli = window.localStorage.getItem(CLI_STORAGE_KEY);
const storedParallel = window.localStorage.getItem(PARALLEL_STORAGE_KEY);
const selectedUnverifiedCustom = storedCli?.startsWith("custom:") === true
  && customCommands.some(({ id, verified }) => !verified && storedCli === `custom:${id}`);
if (storedCli !== null && (isCli(storedCli) || customCommands.some(({ id, verified }) => verified && storedCli === `custom:${id}`))) cliSelect.value = storedCli;
if (storedParallel !== null && Number(storedParallel) >= 1 && Number(storedParallel) <= 10) parallelSelect.value = storedParallel;
autoRunCheckbox.checked = window.localStorage.getItem(AUTO_RUN_STORAGE_KEY) === "true" && !selectedUnverifiedCustom;
if (selectedUnverifiedCustom) {
  window.localStorage.setItem(AUTO_RUN_STORAGE_KEY, "false");
  setCustomStatus("既存のカスタムコマンドは再テストが必要です。安全のため自動実行を無効にしました。", true);
}
form.hidden = autoRunCheckbox.checked;

function isCli(value: string): value is ReviewCli {
  return value === "opencode" || value === "claude" || value === "codex" || value === "copilot" || value === "pi";
}

function loadCustomCommands(): CustomCommand[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(CUSTOM_COMMANDS_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is Omit<CustomCommand, "verified"> & { verified?: boolean } => typeof item === "object" && item !== null
      && typeof (item as CustomCommand).id === "string" && typeof (item as CustomCommand).name === "string" && typeof (item as CustomCommand).command === "string")
      .map((item) => ({
        id: item.id,
        name: item.name,
        command: item.command,
        verified: item.verified === true,
        ...(typeof item.probe_ms === "number" && Number.isFinite(item.probe_ms) ? { probe_ms: item.probe_ms } : {}),
      }));
  } catch { return []; }
}

function saveCustomCommands(): void {
  window.localStorage.setItem(CUSTOM_COMMANDS_STORAGE_KEY, JSON.stringify(customCommands));
}

function validateCustomCommandTemplate(command: string): void {
  if ((command.match(/\{prompt\}/g) ?? []).length !== 1) throw new Error("コマンドには{prompt}を1回だけ記述してください。");
}

function setCustomStatus(message: string, error = false): void {
  customStatusElement.textContent = message;
  customStatusElement.classList.toggle("is-error", error);
}

async function verifyCustomCommand(item: CustomCommand, button: HTMLButtonElement): Promise<void> {
  try {
    validateCustomCommandTemplate(item.command);
  } catch (error) {
    setCustomStatus(error instanceof Error ? error.message : String(error), true);
    return;
  }
  button.disabled = true;
  setCustomStatus(`${item.name}の応答とtool利用をテストしています（最大45秒）…`);
  try {
    const probe = await requestJson("/api/jobs/custom-command/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: item.command }),
    });
    const durationMs = typeof probe === "object" && probe !== null && typeof (probe as { duration_ms?: unknown }).duration_ms === "number"
      ? (probe as { duration_ms: number }).duration_ms : 0;
    item.verified = true;
    item.probe_ms = durationMs;
    if (!customCommands.some(({ id }) => id === item.id)) customCommands.push(item);
    saveCustomCommands();
    renderCustomCommands();
    cliSelect.value = `custom:${item.id}`;
    window.localStorage.setItem(CLI_STORAGE_KEY, cliSelect.value);
    setCustomStatus(durationMs >= 15_000
      ? `${item.name}を登録しました。test応答に${Math.ceil(durationMs / 1000)}秒かかったため、実際の修正も遅くなる可能性があります。`
      : `${item.name}の応答とtool利用を確認し、登録しました。`);
  } catch (error) {
    item.verified = false;
    if (customCommands.some(({ id }) => id === item.id)) {
      saveCustomCommands();
      renderCustomCommands();
    }
    setCustomStatus(`登録できません：${error instanceof Error ? error.message : String(error)}`, true);
  } finally {
    button.disabled = false;
  }
}

function renderCustomCommands(): void {
  customOptions.replaceChildren(...customCommands.filter(({ verified }) => verified).map((item) => {
    const option = document.createElement("option");
    option.value = `custom:${item.id}`;
    option.textContent = item.name;
    return option;
  }));
  customCommandList.replaceChildren(...customCommands.map((item) => {
    const row = document.createElement("div");
    row.className = "custom-command-row";
    const text = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = item.name;
    const command = document.createElement("code");
    command.textContent = item.command;
    text.append(name, command);
    const status = document.createElement("span");
    status.className = "custom-command-status";
    status.textContent = item.verified
      ? `テスト済み${item.probe_ms ? `（${Math.ceil(item.probe_ms / 1000)}秒）` : ""}`
      : "未テスト";
    text.append(status);
    const test = document.createElement("button");
    test.type = "button";
    test.className = "custom-command-test";
    test.textContent = item.verified ? "再テスト" : "テスト";
    test.addEventListener("click", () => void verifyCustomCommand(item, test));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "custom-command-remove";
    remove.textContent = "削除";
    remove.addEventListener("click", () => {
      customCommands = customCommands.filter(({ id }) => id !== item.id);
      if (cliSelect.value === `custom:${item.id}`) {
        cliSelect.value = "opencode";
        window.localStorage.setItem(CLI_STORAGE_KEY, cliSelect.value);
      }
      saveCustomCommands();
      renderCustomCommands();
    });
    row.append(text, test, remove);
    return row;
  }));
}

function selectedConfiguration(): { cli: ReviewCli; custom_name?: string; custom_command?: string } {
  if (isCli(cliSelect.value)) return { cli: cliSelect.value };
  const id = cliSelect.value.startsWith("custom:") ? cliSelect.value.slice(7) : "";
  const custom = customCommands.find((item) => item.id === id);
  if (!custom?.verified) throw new Error("カスタムコマンドは登録前にテストしてください。");
  return { cli: "custom", custom_name: custom.name, custom_command: custom.command };
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
  if (submitting || (!automatic && hasActiveJobs)) return;
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
  const cliLabel = configuration.custom_name ?? CLI_LABELS[configuration.cli];
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
settingsOpenButton.addEventListener("click", () => settingsDialog.showModal());
settingsCloseButton.addEventListener("click", () => settingsDialog.close());
cliSelect.addEventListener("change", () => window.localStorage.setItem(CLI_STORAGE_KEY, cliSelect.value));
customAddButton.addEventListener("click", () => {
  const name = customNameInput.value.trim();
  const command = customCommandInput.value.trim();
  if (!name || !command) { setCustomStatus("表示名とコマンドを入力してください。", true); return; }
  if (/[\0\r\n]/.test(command)) { setCustomStatus("カスタムコマンドは1行で入力してください。", true); return; }
  try { validateCustomCommandTemplate(command); } catch (error) {
    setCustomStatus(error instanceof Error ? error.message : String(error), true);
    return;
  }
  const item = { id: window.crypto.randomUUID(), name, command, verified: false };
  void verifyCustomCommand(item, customAddButton).then(() => {
    if (!item.verified) return;
    customNameInput.value = "";
    customCommandInput.value = "";
  });
});
parallelSelect.addEventListener("change", () => window.localStorage.setItem(PARALLEL_STORAGE_KEY, parallelSelect.value));
autoRunCheckbox.addEventListener("change", () => {
  window.localStorage.setItem(AUTO_RUN_STORAGE_KEY, String(autoRunCheckbox.checked));
  form.hidden = autoRunCheckbox.checked;
  setStatus(autoRunCheckbox.checked ? "自動実行を有効にしました。次に保存した注釈からAI修正を開始します。" : "自動実行を無効にしました。");
});
window.addEventListener("visual-review:annotation-created", scheduleAutoRun);
window.addEventListener("visual-review:annotation-reopened", scheduleAutoRun);
window.addEventListener("focus", () => void Promise.all([refreshSession(), refreshJobs()]));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void Promise.all([refreshSession(), refreshJobs()]);
});
window.addEventListener("pagehide", destroy, { once: true });

void Promise.all([refreshSession(true), refreshJobs()]);
scheduleSessionPoll();
