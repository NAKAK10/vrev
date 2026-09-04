export const RUNNER_REGISTRY_CAPABILITY_ID = "host.runner-registry";
export const RUNNER_REGISTRY_CAPABILITY_API_VERSION = 1;
export const LOCAL_RUNNER_PROVIDER_ID = "runner-local";

/**
 * Provides local CLI adapters without exposing command lines to workflow packages.
 * The host validates the returned execution spec and always spawns with shell:false.
 */
export function createLocalRunnerProvider() {
  const runners = Object.freeze([
    { runner_id: "opencode", name: "OpenCode", verified: true, integration_kind: "cli" },
    { runner_id: "claude", name: "Claude", verified: true, profiles: ["text-only"], integration_kind: "cli" },
    { runner_id: "codex", name: "Codex", verified: true, integration_kind: "cli" },
    { runner_id: "copilot", name: "GitHub Copilot", verified: true, integration_kind: "cli" },
    { runner_id: "pi", name: "Pi", verified: true, integration_kind: "cli" },
  ]);
  return Object.freeze({
    list() {
      return runners;
    },
    resolve(runnerId, context) {
      const session = typeof context.options?.session_id === "string" ? context.options.session_id : null;
      const attach = typeof context.options?.opencode_attach === "string" ? context.options.opencode_attach : null;
      const textOnly = context.options?.profile === "text-only";
      if (runnerId === "opencode") return { command: "opencode", args: ["run", ...(session ? ["--session", session] : []), ...(attach ? ["--attach", attach] : []), context.prompt], cwd: context.workspaceRoot, env: { ...process.env } };
      if (runnerId === "claude") return { command: "claude", args: ["-p", "--output-format", "json", ...(textOnly ? ["--safe-mode", "--strict-mcp-config", "--permission-mode", "plan", "--tools="] : ["--permission-mode", "acceptEdits"]), ...(session ? ["--resume", session] : []), context.prompt], cwd: context.workspaceRoot, env: { ...process.env } };
      if (runnerId === "codex") return { command: "codex", args: ["--sandbox", "workspace-write", "--ask-for-approval", "never", "exec", ...(session ? ["resume", session] : []), context.prompt], cwd: context.workspaceRoot, env: { ...process.env } };
      if (runnerId === "copilot") return { command: "copilot", args: ["--prompt", context.prompt, "--allow-all-tools"], cwd: context.workspaceRoot, env: { ...process.env } };
      if (runnerId === "pi") return { command: "pi", args: ["--print", "--no-session", "--approve", "--", context.prompt], cwd: context.workspaceRoot, env: { ...process.env } };
      throw new Error(`local runner is unavailable: ${runnerId}`);
    },
  });
}

const provider = Object.freeze({
  apiVersion: 1,
  create(context) {
    const registry = context.capability(RUNNER_REGISTRY_CAPABILITY_ID, RUNNER_REGISTRY_CAPABILITY_API_VERSION);
    let unregister;
    const unsupported = (_name, request) => Promise.resolve({
      ok: false,
      error: { code: "PLUGIN_PROTOCOL_ERROR", message: "runner-local has no bridge operations", retryable: false, request_id: request.request_id },
    });
    return {
      start() {
        unregister = registry.register(LOCAL_RUNNER_PROVIDER_ID, createLocalRunnerProvider());
      },
      query: unsupported,
      command: unsupported,
      stop() {
        unregister?.();
        unregister = undefined;
      },
    };
  },
});

export default provider;
