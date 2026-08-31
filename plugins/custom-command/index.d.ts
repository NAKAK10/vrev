export interface CustomCommandProviderV1 {
  apiVersion: 1;
  list(workspaceRoot: string): { runner_id: string; name: string; verified: boolean; probe_ms: number | null }[];
  listPending?(workspaceRoot: string): { runner_id: string; name: string }[];
  add(workspaceRoot: string, name: string, template: string): Promise<{ runner_id: string; duration_ms: number }>;
  remove(workspaceRoot: string, runnerId: string): void;
  test(workspaceRoot: string, runnerId: string): Promise<unknown>;
  resolve(workspaceRoot: string, runnerId: string): { name: string; template: string };
}

export const customCommandProvider: CustomCommandProviderV1;
export function parseCommandTemplate(value: string, prompt: string): { command: string; args: string[] };

export function createCustomCommandBridgeAdapter(
  workspaceRoot: string,
  provider?: CustomCommandProviderV1 | (() => Promise<CustomCommandProviderV1>),
): {
  query(name: string, request: { request_id: string; input: Record<string, unknown> }): Promise<unknown>;
  command(name: string, request: { request_id: string; input: Record<string, unknown> }): Promise<unknown>;
};
