export const McpIpcChannel = {
  List: 'mcp:list',
  Create: 'mcp:create',
  Update: 'mcp:update',
  Delete: 'mcp:delete',
  DeleteByRegistryId: 'mcp:deleteByRegistryId',
  SetEnabled: 'mcp:setEnabled',
  SetEnabledByRegistryId: 'mcp:setEnabledByRegistryId',
  RetryLaunchResolution: 'mcp:retryLaunchResolution',
  FetchMarketplace: 'mcp:fetchMarketplace',
  ConnectQichacha: 'mcp:qichachaConnect',
  Changed: 'mcp:changed',
} as const;
export type McpIpcChannel = typeof McpIpcChannel[keyof typeof McpIpcChannel];

/**
 * Canonical MCP transport types recognized by LobsterAI.
 *
 * `StreamableHttp` is the MCP spec name and the value used in OpenClaw's
 * `mcp.servers.<name>.transport` field. `Http` is preserved as a legacy alias
 * so older SQLite records and existing JSON imports keep working without a
 * database migration. New data is normalized to `StreamableHttp`.
 */
export const McpTransportType = {
  Stdio: 'stdio',
  Sse: 'sse',
  Http: 'http',
  StreamableHttp: 'streamable-http',
} as const;
export type McpTransportType = typeof McpTransportType[keyof typeof McpTransportType];
