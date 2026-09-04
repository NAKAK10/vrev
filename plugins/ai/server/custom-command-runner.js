import { createCustomCommandBridgeAdapter, customCommandProvider, parseCommandTemplate } from "./custom-command.js";

export const RUNNER_REGISTRY_CAPABILITY_ID = "host.runner-registry";
export const RUNNER_REGISTRY_CAPABILITY_API_VERSION = 1;
export const CUSTOM_COMMAND_RUNNER_PROVIDER_ID = "custom-command";

export function createCustomCommandRunnerProvider(workspaceRoot, provider = customCommandProvider) {
  const load = async () => typeof provider === "function" ? provider() : provider;
  return Object.freeze({
    async list(context) {
      if (context.workspaceRoot !== workspaceRoot) throw new Error("runner workspace does not match the active plugin workspace");
      try {
        return (await load()).list(workspaceRoot).map(({ runner_id, name, verified }) => ({ runner_id, name, verified, integration_kind: "external-command" }));
      } catch {
        return [];
      }
    },
    async resolve(runnerId, context) {
      if (context.workspaceRoot !== workspaceRoot) throw new Error("runner workspace does not match the active plugin workspace");
      const resolved = (await load()).resolve(workspaceRoot, runnerId);
      const parsed = parseCommandTemplate(resolved.template, context.prompt);
      return { command: parsed.command, args: parsed.args, cwd: workspaceRoot, env: { ...process.env } };
    },
  });
}

const provider = Object.freeze({
  apiVersion: 1,
  create(context) {
    const bridge = createCustomCommandBridgeAdapter(context.workspace.root, customCommandProvider);
    const registry = context.capability(RUNNER_REGISTRY_CAPABILITY_ID, RUNNER_REGISTRY_CAPABILITY_API_VERSION);
    let unregister;
    return {
      start() {
        unregister = registry.register(CUSTOM_COMMAND_RUNNER_PROVIDER_ID, createCustomCommandRunnerProvider(context.workspace.root));
      },
      query: bridge.query,
      command: bridge.command,
      stop() {
        unregister?.();
        unregister = undefined;
      },
    };
  },
});

export default provider;
