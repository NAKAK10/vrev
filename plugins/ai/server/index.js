import { createCustomCommandBridgeAdapter, customCommandProvider } from "./custom-command.js";
import { createCustomCommandRunnerProvider } from "./custom-command-runner.js";
import { createLocalRunnerProvider } from "./local-runner.js";
import { readAiSettings, selectAiMethod, writeAiSettings } from "./settings.js";

export * from "./custom-command.js";
export * from "./custom-command-runner.js";
export * from "./local-runner.js";
export * from "./settings.js";

export const AI_CAPABILITY_ID = "ai";
export const AI_CAPABILITY_API_VERSION = 1;
export const AI_INTEGRATION_REGISTRY_CAPABILITY_ID = "ai.integration-registry";
export const AI_INTEGRATION_REGISTRY_CAPABILITY_API_VERSION = 1;
export const RUNNER_REGISTRY_CAPABILITY_ID = "host.runner-registry";
export const PROCESS_SUPERVISOR_CAPABILITY_ID = "host.process-supervisor";

const METHOD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const METHOD_KINDS = new Set(["cli", "external-command", "api", "sdk", "remote", "integration"]);
const MODES = new Set(["workspace-write", "text-only"]);
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;

function assertWorkspaceRoot(value) {
  if (typeof value !== "string" || !value) throw new Error("AI workspace root is required");
}
function methodKind(descriptor) {
  if (typeof descriptor.integration_kind === "string" && METHOD_KINDS.has(descriptor.integration_kind)) return descriptor.integration_kind;
  if (descriptor.provider_id === "runner-local") return "cli";
  if (descriptor.provider_id === "custom-command") return "external-command";
  return "integration";
}
function modesFor(descriptor) {
  const modes = ["workspace-write"];
  if (Array.isArray(descriptor.profiles) && descriptor.profiles.includes("text-only")) modes.push("text-only");
  return Object.freeze(modes);
}
function assertMode(value) {
  if (!MODES.has(value)) throw new Error("AI mode is invalid");
}
function integerInRange(value, fallback, minimum, maximum, label) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) throw new Error(`${label} is invalid`);
  return resolved;
}
function normalizeOptions(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 32) throw new Error("AI invocation options are invalid");
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || (item !== null && !["string", "number", "boolean"].includes(typeof item))) throw new Error("AI invocation options are invalid");
  }
  return Object.freeze({ ...value });
}
function normalizeIntegrationMethod(providerId, descriptor) {
  if (!descriptor || typeof descriptor !== "object" || typeof descriptor.method_id !== "string" || !METHOD_ID.test(descriptor.method_id)) throw new Error(`AI integration ${providerId} returned an invalid method ID`);
  const methodId = `${providerId}:${descriptor.method_id}`;
  if (!METHOD_ID.test(methodId)) throw new Error(`AI integration ${providerId} returned an overlong method ID`);
  if (typeof descriptor.name !== "string" || !descriptor.name.trim() || descriptor.name.length > 120) throw new Error(`AI integration ${providerId} returned an invalid method name`);
  if (!METHOD_KINDS.has(descriptor.method_kind)) throw new Error(`AI integration ${providerId} returned an invalid method kind`);
  if (!Array.isArray(descriptor.modes) || descriptor.modes.length < 1 || descriptor.modes.length > 2 || new Set(descriptor.modes).size !== descriptor.modes.length || descriptor.modes.some((mode) => !MODES.has(mode))) throw new Error(`AI integration ${providerId} returned invalid modes`);
  return Object.freeze({ method_id: methodId, name: descriptor.name, method_kind: descriptor.method_kind, modes: Object.freeze([...descriptor.modes]) });
}
function validateIntegrationProvider(provider) {
  if (!provider || typeof provider.list !== "function" || typeof provider.invoke !== "function") throw new Error("AI integration provider is invalid");
}

/** Registry for process-backed and native API/SDK/remote AI integrations. */
export function createAiIntegrationRegistry() {
  const providers = new Map();
  return Object.freeze({
    apiVersion: 1,
    register(providerId, provider) {
      if (typeof providerId !== "string" || !PROVIDER_ID.test(providerId)) throw new Error("AI integration provider ID is invalid");
      validateIntegrationProvider(provider);
      if (providers.has(providerId)) throw new Error(`AI integration provider already registered: ${providerId}`);
      providers.set(providerId, provider);
      let registered = true;
      return () => { if (registered && providers.get(providerId) === provider) providers.delete(providerId); registered = false; };
    },
    async list(context) {
      assertWorkspaceRoot(context?.workspaceRoot);
      const methods = [];
      for (const [providerId, provider] of providers) {
        const listed = await provider.list(Object.freeze({ workspaceRoot: context.workspaceRoot }));
        if (!Array.isArray(listed)) throw new Error(`AI integration ${providerId} returned an invalid method list`);
        for (const descriptor of listed) methods.push(normalizeIntegrationMethod(providerId, descriptor));
      }
      return Object.freeze(methods);
    },
    has(methodId) {
      if (typeof methodId !== "string") return false;
      return [...providers.keys()].some((providerId) => methodId.startsWith(`${providerId}:`));
    },
    async invoke(methodId, request) {
      if (typeof methodId !== "string" || !METHOD_ID.test(methodId)) throw new Error("AI method ID is invalid");
      const providerId = [...providers.keys()].find((candidate) => methodId.startsWith(`${candidate}:`));
      const provider = providerId ? providers.get(providerId) : undefined;
      if (!providerId || !provider) throw new Error("Selected AI integration is unavailable");
      const invocation = await provider.invoke(methodId.slice(providerId.length + 1), request);
      if (!invocation || typeof invocation.cancel !== "function" || !(invocation.result instanceof Promise)) throw new Error(`AI integration ${providerId} returned an invalid invocation`);
      return invocation;
    },
  });
}

function processResultFromAi(result) {
  if (!result || typeof result !== "object" || typeof result.output !== "string") return { exitCode: null, reason: "spawn-error", stdout: "" };
  if (result.status === "completed" && result.exit_code === 0) return { exitCode: 0, reason: "exit", stdout: result.output };
  const reason = result.status === "cancelled" ? "cancelled" : result.status === "timeout" ? "timeout" : result.status === "output-limit" ? "output-limit" : "spawn-error";
  return { exitCode: Number.isInteger(result.exit_code) ? result.exit_code : null, reason, stdout: result.output };
}

/**
 * Central AI facade. Features use opaque methods and bounded text results. Legacy CLI command
 * specs stay behind the host runner registry; native integrations use the integration registry.
 */
export function createAiCapability({ workspaceRoot, runnerRegistry, processSupervisor, integrationRegistry = createAiIntegrationRegistry() }) {
  assertWorkspaceRoot(workspaceRoot);
  if (!runnerRegistry || typeof runnerRegistry.list !== "function" || typeof runnerRegistry.resolve !== "function") throw new Error("AI runner registry is required");
  if (!processSupervisor || typeof processSupervisor.run !== "function") throw new Error("AI process supervisor is required");
  if (!integrationRegistry || typeof integrationRegistry.list !== "function" || typeof integrationRegistry.invoke !== "function" || typeof integrationRegistry.has !== "function") throw new Error("AI integration registry is required");
  const active = new Set();
  let stopped = false;

  const list = async (input = {}) => {
    if (stopped) return Object.freeze([]);
    const mode = input.mode;
    if (mode !== undefined) assertMode(mode);
    const [descriptors, integrated] = await Promise.all([
      runnerRegistry.list({ workspaceRoot }),
      integrationRegistry.list({ workspaceRoot }),
    ]);
    const methods = descriptors
      .filter((descriptor) => descriptor?.verified === true && typeof descriptor.runner_id === "string" && METHOD_ID.test(descriptor.runner_id) && typeof descriptor.name === "string" && descriptor.name.trim())
      .map((descriptor) => Object.freeze({
        method_id: descriptor.runner_id,
        name: descriptor.name,
        method_kind: methodKind(descriptor),
        modes: modesFor(descriptor),
      }));
    methods.push(...integrated);
    const seen = new Set();
    for (const method of methods) {
      if (seen.has(method.method_id)) throw new Error(`duplicate AI method ID: ${method.method_id}`);
      seen.add(method.method_id);
    }
    return Object.freeze(methods.filter((descriptor) => mode === undefined || descriptor.modes.includes(mode)));
  };

  const invoke = (request) => {
    if (stopped) throw new Error("AI capability is stopped");
    if (!request || typeof request !== "object") throw new Error("AI invocation is invalid");
    if (request.method_id !== undefined && (typeof request.method_id !== "string" || !METHOD_ID.test(request.method_id))) throw new Error("AI method ID is invalid");
    assertMode(request.mode);
    if (typeof request.prompt !== "string" || !request.prompt.trim() || Buffer.byteLength(request.prompt, "utf8") > 256 * 1024) throw new Error("AI prompt must be nonblank and at most 256 KiB");
    const timeoutMs = integerInRange(request.timeout_ms, DEFAULT_TIMEOUT_MS, 1, DEFAULT_TIMEOUT_MS, "AI timeout");
    const outputLimit = integerInRange(request.output_limit_bytes, DEFAULT_OUTPUT_LIMIT, 1, DEFAULT_OUTPUT_LIMIT, "AI output limit");
    const options = normalizeOptions(request.options);
    const invocation = { running: undefined, abortController: new AbortController(), cancelled: false, timedOut: false, interrupt: undefined };
    const interrupted = new Promise((resolve) => { invocation.interrupt = resolve; });
    const timeoutResult = () => ({ status: "timeout", output: "", exit_code: null, message: `AI invocation timed out after ${timeoutMs} ms`, retryable: true });
    const cancelledResult = () => ({ status: "cancelled", output: "", exit_code: null, message: "AI invocation was cancelled", retryable: true });
    const cancel = () => {
      if (invocation.cancelled || invocation.timedOut) return;
      invocation.cancelled = true;
      invocation.abortController.abort();
      invocation.running?.cancel();
      invocation.interrupt(cancelledResult());
    };
    invocation.cancel = cancel;
    active.add(invocation);
    const timer = setTimeout(() => {
      if (invocation.cancelled || invocation.timedOut) return;
      invocation.timedOut = true;
      invocation.abortController.abort();
      invocation.running?.cancel();
      invocation.interrupt(timeoutResult());
    }, timeoutMs);
    timer.unref?.();

    const execution = (async () => {
      try {
        const methods = await list({ mode: request.mode });
        if (invocation.timedOut) return timeoutResult();
        if (invocation.cancelled || stopped) return cancelledResult();
        // The workspace-configured default may not support this call's mode (e.g. a workspace-write-only
        // custom command asked to run text-only). Rather than fail the whole invocation, fall back to any
        // other method that does support it; an explicit request.method_id is still validated as before.
        const methodId = request.method_id ?? selectAiMethod(workspaceRoot, methods)?.method_id ?? methods[0]?.method_id;
        if (!methodId || !methods.some(({ method_id }) => method_id === methodId)) throw new Error("AIパッケージで選択されたAIはこの処理に利用できません");
        if (integrationRegistry.has(methodId)) {
          const delegated = await integrationRegistry.invoke(methodId, Object.freeze({ workspaceRoot, mode: request.mode, prompt: request.prompt, timeout_ms: timeoutMs, output_limit_bytes: outputLimit, options, signal: invocation.abortController.signal }));
          invocation.running = { cancel: () => delegated.cancel(), result: delegated.result.then(processResultFromAi) };
        } else {
          const resolveOptions = request.mode === "text-only" ? { ...options, profile: "text-only" } : options;
          const spec = await runnerRegistry.resolve(methodId, { workspaceRoot, prompt: request.prompt, options: resolveOptions });
          if (invocation.timedOut) return timeoutResult();
          if (invocation.cancelled || stopped) return cancelledResult();
          invocation.running = processSupervisor.run({ command: spec.command, args: [...spec.args], cwd: spec.cwd ?? workspaceRoot, env: spec.env ?? { ...process.env }, timeoutMs, stdoutLimit: outputLimit });
        }
        if (invocation.timedOut) { invocation.running.cancel(); return timeoutResult(); }
        if (invocation.cancelled || stopped) { invocation.running.cancel(); return cancelledResult(); }
        const processResult = await invocation.running.result;
        const output = typeof processResult.stdout === "string" ? processResult.stdout : "";
        if (Buffer.byteLength(output, "utf8") > outputLimit) return { status: "output-limit", output: "", exit_code: processResult.exitCode, message: "AI output exceeded the configured limit", retryable: false };
        if (processResult.reason === "timeout") return timeoutResult();
        if (processResult.reason === "cancelled") return cancelledResult();
        if (processResult.reason === "exit" && processResult.exitCode === 0) return { status: "completed", output, exit_code: 0 };
        return { status: processResult.reason === "output-limit" ? "output-limit" : "failed", output, exit_code: processResult.exitCode, message: `AI invocation failed: ${processResult.reason}`, retryable: processResult.reason === "spawn-error" };
      } catch (error) {
        if (invocation.timedOut) return timeoutResult();
        if (invocation.cancelled || stopped) return cancelledResult();
        return { status: "failed", output: "", exit_code: null, message: error instanceof Error ? error.message : "AI invocation failed", retryable: false };
      }
    })();
    const result = Promise.race([execution, interrupted]).finally(() => { clearTimeout(timer); active.delete(invocation); });
    return Object.freeze({ result, cancel });
  };

  return Object.freeze({
    apiVersion: 1,
    list,
    invoke,
    stop() {
      if (stopped) return;
      stopped = true;
      for (const invocation of active) invocation.cancel();
      active.clear();
    },
  });
}

export function createAiBridgeAdapter(workspaceRoot, listMethods, commandProvider = customCommandProvider) {
  const commands = createCustomCommandBridgeAdapter(workspaceRoot, commandProvider);
  const missing = (request) => ({ ok: false, error: { code: "NOT_FOUND", message: "operation is not declared by the AI package", retryable: false, request_id: request.request_id } });
  return Object.freeze({
    async query(name, request) {
      if (name === "ai.settings") {
        const methods = await listMethods({ mode: "workspace-write" });
        const selected = selectAiMethod(workspaceRoot, methods);
        return { ok: true, data: {
          method_id: selected?.method_id ?? "",
          available: methods.length > 0,
          options: methods.map(({ method_id, name: label, method_kind }) => ({ value: method_id, label: `${label}（${method_kind === "cli" ? "CLI" : method_kind === "external-command" ? "外部コマンド" : "連携"}）` })),
        } };
      }
      if (name === "runners.list") return commands.query(name, request);
      return missing(request);
    },
    async command(name, request) {
      if (name === "ai.settings.update") {
        const methods = await listMethods({ mode: "workspace-write" });
        const data = writeAiSettings(workspaceRoot, request.input.method_id, methods);
        return { ok: true, data, effects: [{ type: "resource.invalidate", resources: ["ai-settings"] }] };
      }
      if (name.startsWith("runner.")) return commands.command(name, request);
      return missing(request);
    },
  });
}

const provider = Object.freeze({
  apiVersion: 1,
  create(context) {
    const runnerRegistry = context.capability(RUNNER_REGISTRY_CAPABILITY_ID, 1);
    const processSupervisor = context.capability(PROCESS_SUPERVISOR_CAPABILITY_ID, 1);
    const integrationRegistry = createAiIntegrationRegistry();
    const unregisterProviders = [];
    const runtime = createAiCapability({ workspaceRoot: context.workspace.root, runnerRegistry, processSupervisor, integrationRegistry });
    const capability = Object.freeze({ apiVersion: 1, list: runtime.list, invoke: runtime.invoke });
    const bridge = createAiBridgeAdapter(context.workspace.root, runtime.list);
    return {
      start() {
        unregisterProviders.push(runnerRegistry.register("runner-local", createLocalRunnerProvider()));
        unregisterProviders.push(runnerRegistry.register("custom-command", createCustomCommandRunnerProvider(context.workspace.root)));
      },
      query: bridge.query,
      command: bridge.command,
      capabilities() {
        return [
          { id: AI_CAPABILITY_ID, apiVersion: 1, implementation: capability },
          { id: AI_INTEGRATION_REGISTRY_CAPABILITY_ID, apiVersion: 1, implementation: integrationRegistry },
        ];
      },
      stop() {
        while (unregisterProviders.length) unregisterProviders.pop()?.();
        runtime.stop();
      },
    };
  },
});

export default provider;
