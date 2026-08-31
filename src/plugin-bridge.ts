export const PLUGIN_BRIDGE_PROTOCOL_V1 = "plugin-bridge/1" as const;

export type PluginPrincipalV1 = "human-ui" | "host-cli" | "system" | "coordinator";

export interface PluginBridgeContextV1 {
  principal: PluginPrincipalV1;
  workspaceId: string;
  targetId: string;
  requestId: string;
  idempotencyKey?: string;
  signal: AbortSignal;
}

export interface PluginQueryRequestV1 {
  protocol: typeof PLUGIN_BRIDGE_PROTOCOL_V1;
  request_id: string;
  input: Readonly<Record<string, unknown>>;
}

export interface PluginCommandRequestV1 extends PluginQueryRequestV1 {
  idempotency_key: string;
  expected_revision?: string | null;
  client_seq?: number;
}

export interface PluginSubscriptionRequestV1 {
  protocol: typeof PLUGIN_BRIDGE_PROTOCOL_V1;
  after?: string;
}

export type PluginBridgeErrorCodeV1 =
  | "BAD_REQUEST"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_FAILED"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "PLUGIN_PROTOCOL_ERROR"
  | "PLUGIN_UNAVAILABLE"
  | "TIMEOUT"
  | "RESYNC_REQUIRED";

export interface PluginBridgeErrorV1 {
  code: PluginBridgeErrorCodeV1;
  message: string;
  retryable: boolean;
  fields?: Readonly<Record<string, string>>;
  request_id: string;
}

export type PluginBridgeEffectV1 =
  | { type: "resource.invalidate"; resources: string[] }
  | { type: "operation.completed"; operation_id: string }
  | { type: "target.reload" };

export type PluginBridgeResultV1 =
  | {
      ok: true;
      revision?: string;
      data: unknown;
      effects?: PluginBridgeEffectV1[];
    }
  | {
      ok: false;
      revision?: string;
      error: PluginBridgeErrorV1;
    };

export interface PluginInvalidationEventV1 {
  protocol: typeof PLUGIN_BRIDGE_PROTOCOL_V1;
  event_id: string;
  seq: number;
  plugin_id: string;
  type: "resources.invalidated" | "resync.required";
  revision?: string;
  resources: string[];
}

export interface PluginBridgeTransportV1 {
  query(pluginId: string, name: string, request: PluginQueryRequestV1): Promise<PluginBridgeResultV1>;
  sendAction(pluginId: string, name: string, request: PluginCommandRequestV1): Promise<PluginBridgeResultV1>;
  subscribe(pluginId: string, listener: (event: PluginInvalidationEventV1) => void): () => void;
  close(): void;
}
