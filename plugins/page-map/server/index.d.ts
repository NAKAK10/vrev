export interface PageMapTargetDescriptorV1 {
  projectRoot: string;
  entryPath: string;
  kind: "html" | "image";
  liveUrl?: string;
  urlMode?: "loopback" | "private" | "public";
}

export interface PageMapBridgeRequestV1 {
  request_id: string;
  expected_revision?: unknown;
  input: Record<string, unknown>;
}

export type PageMapBridgeResultV1 =
  | { ok: true; revision?: string; data: unknown; effects?: unknown[] }
  | { ok: false; error: { code: string; message: string; retryable: boolean; request_id: string } };

export interface PageMapBridgeAdapterV1 {
  query(name: string, request: PageMapBridgeRequestV1): Promise<PageMapBridgeResultV1>;
  command(name: string, request: PageMapBridgeRequestV1): Promise<PageMapBridgeResultV1>;
}

export function createPageMapBridgeAdapter(
  targetDescriptor: PageMapTargetDescriptorV1,
  options?: { cache?: unknown; limits?: Record<string, number> },
): PageMapBridgeAdapterV1;

declare const serverProvider: {
  apiVersion: 1;
  create(context: unknown): unknown;
};
export default serverProvider;
