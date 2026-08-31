import { createCustomCommandBridgeAdapter, customCommandProvider, parseCommandTemplate } from "../index.js";

export const RUNNER_REGISTRY_CAPABILITY_ID = "runner-registry";
export const RUNNER_REGISTRY_CAPABILITY_API_VERSION = 1;

function assertProvider(providerId, provider) {
  if (typeof providerId !== "string" || !/^[a-z][a-z0-9.-]{0,62}$/.test(providerId)) throw new Error("runner provider ID is invalid");
  if (!provider || typeof provider.list !== "function" || typeof provider.resolve !== "function") throw new Error("runner provider must implement list and resolve");
}

export function createRunnerRegistryCapability(workspaceRoot, provider = customCommandProvider) {
  const providers = new Map();
  providers.set("custom-command", {
    list() {
      return provider.list(workspaceRoot)
        .map(({ runner_id, name, verified }) => ({ runner_id, name, verified }));
    },
    resolve(runnerId, context) {
      const resolved = provider.resolve(workspaceRoot, runnerId);
      const parsed = parseCommandTemplate(resolved.template, context.prompt);
      return { command: parsed.command, args: parsed.args, cwd: workspaceRoot, env: { ...process.env } };
    },
  });

  return Object.freeze({
    apiVersion: 1,
    register(providerId, runnerProvider) {
      assertProvider(providerId, runnerProvider);
      if (providers.has(providerId)) throw new Error(`runner provider is already registered: ${providerId}`);
      providers.set(providerId, runnerProvider);
      let active = true;
      return () => { if (active) { active = false; providers.delete(providerId); } };
    },
    async list(context = { workspaceRoot }) {
      if (context.workspaceRoot !== workspaceRoot) throw new Error("runner workspace does not match the active plugin workspace");
      const descriptors = [];
      const ids = new Set();
      for (const [providerId, runnerProvider] of providers) {
        for (const descriptor of await runnerProvider.list(context)) {
          if (!descriptor || typeof descriptor.runner_id !== "string" || typeof descriptor.name !== "string" || ids.has(descriptor.runner_id)) throw new Error("runner provider returned an invalid or duplicate runner ID");
          ids.add(descriptor.runner_id);
          descriptors.push({ runner_id: descriptor.runner_id, name: descriptor.name, provider_id: providerId, verified: descriptor.verified !== false });
        }
      }
      return descriptors;
    },
    async resolve(runnerId, context) {
      if (context.workspaceRoot !== workspaceRoot) throw new Error("runner workspace does not match the active plugin workspace");
      for (const [providerId, runnerProvider] of providers) {
        const descriptors = await runnerProvider.list(context);
        if (descriptors.some((descriptor) => descriptor.runner_id === runnerId)) return runnerProvider.resolve(runnerId, context);
        void providerId;
      }
      throw new Error(`verified runner is unavailable: ${runnerId}`);
    },
  });
}

const provider = Object.freeze({
  apiVersion: 1,
  create(context) {
    const bridge = createCustomCommandBridgeAdapter(context.workspace.root, customCommandProvider);
    const registry = createRunnerRegistryCapability(context.workspace.root);
    return {
      start() {},
      query: bridge.query,
      command: bridge.command,
      capabilities() {
        return [{ id: RUNNER_REGISTRY_CAPABILITY_ID, apiVersion: 1, implementation: registry }];
      },
      stop() {},
    };
  },
});

export default provider;
