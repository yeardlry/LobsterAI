/**
 * Minimal ACP (Agent Client Protocol) wire types used by the ccbt engine.
 *
 * These mirror the shapes defined by @agentclientprotocol/sdk (as consumed by
 * the ccbt agent) but are intentionally loose: unknown fields are preserved so
 * protocol additions do not break compilation. The full SDK is not imported
 * here because the LobsterAI side only needs to construct requests and forward
 * updates, never to validate them.
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcServerRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Notification pushed by the agent, e.g. `session/update`. */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface AcpClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
}

export interface AcpInitializeParams {
  protocolVersion: number;
  clientCapabilities: AcpClientCapabilities;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentInfo?: { name?: string; title?: string; version?: string };
  [key: string]: unknown;
}

export type AcpMcpServerConfig =
  | { name: string; type: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; [key: string]: unknown }
  | { name: string; type: 'http' | 'sse'; url: string; headers?: Record<string, string>; [key: string]: unknown };

export type AcpPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

export interface AcpNewSessionParams {
  cwd: string;
  /**
   * REQUIRED by the ACP schema (z.array without .optional()). Omitting it
   * fails session/new with -32602. Always send an array, even when empty.
   */
  mcpServers: AcpMcpServerConfig[];
  _meta?: { permissionMode?: AcpPermissionMode; [key: string]: unknown };
  [key: string]: unknown;
}

export interface AcpNewSessionResult {
  sessionId: string;
  [key: string]: unknown;
}

export type AcpContentBlock =
  | { type: 'text'; text: string; [key: string]: unknown }
  | { type: 'image'; data?: string; mimeType?: string; [key: string]: unknown }
  | { type: 'resource-link'; uri?: string; name?: string; [key: string]: unknown }
  | { type: 'audio'; data?: string; mimeType?: string; [key: string]: unknown }
  | { [key: string]: unknown };

export type AcpPromptBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string } | Record<string, unknown>;

export interface AcpSessionUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

export interface AcpPromptResult {
  stopReason: 'end_turn' | 'cancelled' | 'max_tokens' | 'refusal' | string;
  usage?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Params of an incoming `session/request_permission` server request. */
export interface AcpRequestPermissionParams {
  sessionId?: string;
  toolCallId?: string;
  options?: Array<{ optionId: string; name?: string; kind?: string }>;
  [key: string]: unknown;
}

/** Outcome payload the client responds with. */
export type AcpPermissionOutcome =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' };

export interface AcpSessionHandle {
  acpSessionId: string;
}
