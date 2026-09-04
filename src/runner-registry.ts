import path from "node:path";

export const RUNNER_REGISTRY_CAPABILITY_ID = "host.runner-registry";
export const RUNNER_REGISTRY_CAPABILITY_API_VERSION = 1;

export interface RunnerDescriptorV1 {
  readonly runner_id: string;
  readonly name: string;
  readonly provider_id: string;
  readonly verified: boolean;
  readonly profiles?: readonly string[];
  readonly integration_kind?: "cli" | "external-command" | "api" | "sdk" | "remote" | "integration";
}

export interface RunnerListContextV1 { readonly workspaceRoot: string }
export interface RunnerResolveContextV1 extends RunnerListContextV1 {
  readonly prompt: string;
  readonly options?: Readonly<Record<string, string | number | boolean | null>>;
}
export interface RunnerExecutionSpecV1 {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}
export interface RunnerProviderV1 {
  list(context: RunnerListContextV1): readonly Omit<RunnerDescriptorV1, "provider_id">[] | Promise<readonly Omit<RunnerDescriptorV1, "provider_id">[]>;
  resolve(runnerId: string, context: RunnerResolveContextV1): RunnerExecutionSpecV1 | Promise<RunnerExecutionSpecV1>;
}
export interface RunnerResolverV1 {
  list(context?: RunnerListContextV1): readonly RunnerDescriptorV1[] | Promise<readonly RunnerDescriptorV1[]>;
  resolve(runnerId: string, context: RunnerResolveContextV1): RunnerExecutionSpecV1 | Promise<RunnerExecutionSpecV1>;
}
export interface RunnerRegistryV1 extends RunnerResolverV1 {
  readonly apiVersion: 1;
  register(providerId: string, provider: RunnerProviderV1): () => void;
  unregister(providerId: string): void;
}

const PROVIDER_ID = /^[a-z][a-z0-9]*(?:[.-][a-z][a-z0-9]*){0,7}$/;
const RUNNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Host-owned, workspace-scoped registry. Providers never expose executable templates to consumers. */
export class WorkspaceRunnerRegistryV1 implements RunnerRegistryV1 {
  readonly apiVersion = 1 as const;
  private readonly providers = new Map<string, RunnerProviderV1>();
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    if (typeof workspaceRoot !== "string" || !workspaceRoot.trim() || !path.isAbsolute(workspaceRoot)) throw new Error("runner registry workspaceRoot must be an absolute path");
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  register(providerId: string, provider: RunnerProviderV1): () => void {
    assertProviderId(providerId);
    if (!provider || typeof provider.list !== "function" || typeof provider.resolve !== "function") throw new Error("runner provider must implement list and resolve");
    if (this.providers.has(providerId)) throw new Error(`runner provider is already registered: ${providerId}`);
    this.providers.set(providerId, provider);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.providers.get(providerId) === provider) this.providers.delete(providerId);
    };
  }

  unregister(providerId: string): void {
    assertProviderId(providerId);
    this.providers.delete(providerId);
  }

  async list(context: RunnerListContextV1 = { workspaceRoot: this.workspaceRoot }): Promise<readonly RunnerDescriptorV1[]> {
    this.assertWorkspace(context.workspaceRoot);
    const result: RunnerDescriptorV1[] = [];
    const ids = new Set<string>();
    for (const [providerId, provider] of this.providers) {
      const descriptors = await provider.list(Object.freeze({ workspaceRoot: this.workspaceRoot }));
      if (!Array.isArray(descriptors)) throw new Error(`runner provider ${providerId} returned an invalid list`);
      for (const descriptor of descriptors) {
        assertDescriptor(descriptor, providerId);
        if (ids.has(descriptor.runner_id)) throw new Error(`runner ID is registered by multiple providers: ${descriptor.runner_id}`);
        ids.add(descriptor.runner_id);
        result.push(Object.freeze({ runner_id: descriptor.runner_id, name: descriptor.name, provider_id: providerId, verified: descriptor.verified, ...(descriptor.profiles ? { profiles: Object.freeze([...descriptor.profiles]) } : {}), ...(descriptor.integration_kind ? { integration_kind: descriptor.integration_kind } : {}) }));
      }
    }
    return Object.freeze(result);
  }

  async resolve(runnerId: string, context: RunnerResolveContextV1): Promise<RunnerExecutionSpecV1> {
    assertRunnerId(runnerId);
    this.assertWorkspace(context?.workspaceRoot);
    if (typeof context.prompt !== "string" || !context.prompt) throw new Error("runner prompt must be a nonblank string");
    const descriptors = await this.list({ workspaceRoot: this.workspaceRoot });
    const descriptor = descriptors.find((item) => item.runner_id === runnerId);
    if (!descriptor || !descriptor.verified) throw new Error(`verified runner is unavailable: ${runnerId}`);
    const requestedProfile = context.options?.profile;
    if (typeof requestedProfile === "string" && !descriptor.profiles?.includes(requestedProfile)) throw new Error(`runner does not support the requested profile: ${runnerId}`);
    const provider = this.providers.get(descriptor.provider_id);
    if (!provider) throw new Error(`runner provider is unavailable: ${descriptor.provider_id}`);
    const spec = await provider.resolve(runnerId, Object.freeze({ workspaceRoot: this.workspaceRoot, prompt: context.prompt, ...(context.options ? { options: Object.freeze({ ...context.options }) } : {}) }));
    return validateExecutionSpec(spec, this.workspaceRoot);
  }

  private assertWorkspace(workspaceRoot: unknown): void {
    if (typeof workspaceRoot !== "string" || path.resolve(workspaceRoot) !== this.workspaceRoot) throw new Error("runner workspace does not match the registry workspace");
  }
}

export function createRunnerRegistry(workspaceRoot: string): WorkspaceRunnerRegistryV1 {
  return new WorkspaceRunnerRegistryV1(workspaceRoot);
}

function assertProviderId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !PROVIDER_ID.test(value)) throw new Error("runner provider ID is invalid");
}
function assertRunnerId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !RUNNER_ID.test(value)) throw new Error("runner ID is invalid");
}
function assertDescriptor(value: unknown, providerId: string): asserts value is Omit<RunnerDescriptorV1, "provider_id"> {
  if (!value || typeof value !== "object") throw new Error(`runner provider ${providerId} returned an invalid descriptor`);
  const item = value as Partial<RunnerDescriptorV1>;
  assertRunnerId(item.runner_id);
  if (typeof item.name !== "string" || !item.name.trim() || item.name.length > 120 || /[\0\r\n]/.test(item.name)) throw new Error(`runner provider ${providerId} returned an invalid runner name`);
  if (typeof item.verified !== "boolean") throw new Error(`runner provider ${providerId} returned an invalid verification state`);
  if (item.profiles !== undefined && (!Array.isArray(item.profiles) || item.profiles.length > 16 || item.profiles.some((profile) => typeof profile !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(profile)))) {
    throw new Error(`runner provider ${providerId} returned invalid execution profiles`);
  }
  if (item.integration_kind !== undefined && !["cli", "external-command", "api", "sdk", "remote", "integration"].includes(item.integration_kind)) {
    throw new Error(`runner provider ${providerId} returned an invalid integration kind`);
  }
}
function validateExecutionSpec(value: unknown, workspaceRoot: string): RunnerExecutionSpecV1 {
  if (!value || typeof value !== "object") throw new Error("runner provider returned an invalid execution spec");
  const spec = value as Partial<RunnerExecutionSpecV1>;
  if (typeof spec.command !== "string" || !spec.command.trim() || spec.command.length > 4096 || /[\0\r\n]/.test(spec.command)) throw new Error("runner command is invalid");
  if (!Array.isArray(spec.args) || spec.args.length > 4096 || spec.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new Error("runner arguments are invalid");
  const cwd = spec.cwd === undefined ? workspaceRoot : path.resolve(spec.cwd);
  if (cwd !== workspaceRoot && !cwd.startsWith(`${workspaceRoot}${path.sep}`)) throw new Error("runner cwd must stay within the registry workspace");
  if (spec.env !== undefined && (typeof spec.env !== "object" || spec.env === null || Object.entries(spec.env).some(([key, item]) => !key || /[=\0]/.test(key) || (item !== undefined && (typeof item !== "string" || item.includes("\0")))))) throw new Error("runner environment is invalid");
  return Object.freeze({ command: spec.command, args: Object.freeze([...spec.args]), cwd, ...(spec.env === undefined ? {} : { env: Object.freeze({ ...spec.env }) }) });
}
