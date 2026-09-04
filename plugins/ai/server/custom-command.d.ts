export interface CustomCommandProviderV1 {
  readonly apiVersion: 1;
  list(workspaceRoot: string): Array<{ runner_id: string; name: string; verified: boolean; probe_ms?: number | null }>;
  listPending?(workspaceRoot: string): Array<{ runner_id: string; name: string }>;
  add(workspaceRoot: string, name: string, template: string): Promise<{ runner_id: string; duration_ms: number }>;
  remove(workspaceRoot: string, runnerId: string): void;
  test(workspaceRoot: string, runnerId: string): Promise<{ duration_ms: number }>;
  resolve(workspaceRoot: string, runnerId: string): { name: string; template: string };
}
export declare function parseCommandTemplate(value: string, prompt: string): { command: string; args: string[] };
export declare const customCommandProvider: CustomCommandProviderV1;
export declare function createCustomCommandBridgeAdapter(workspaceRoot: string, providerSource?: CustomCommandProviderV1 | (() => Promise<CustomCommandProviderV1>)): unknown;
export declare function handler(context: { workspaceRoot: string; pluginDirectory: string; args: readonly string[] }): Promise<void>;
