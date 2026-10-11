export type McpJsonValue = null | boolean | number | string | McpJsonObject | readonly McpJsonValue[];
export type McpJsonObject = { readonly [key: string]: McpJsonValue };
export type McpId = string | number;
export type McpMessage =
  | { readonly jsonrpc: "2.0"; readonly id: McpId; readonly method: string; readonly params?: McpJsonObject }
  | { readonly jsonrpc: "2.0"; readonly method: string; readonly params?: McpJsonObject }
  | { readonly jsonrpc: "2.0"; readonly id: McpId; readonly result: McpJsonValue }
  | { readonly jsonrpc: "2.0"; readonly id: McpId; readonly error: { readonly code: number; readonly message: string } };
export type McpErrorKind = "mcp-transport" | "mcp-protocol" | "mcp-tool-error" | "timeout" | "cancelled" | "limit-exceeded";
export class McpError extends Error {
  constructor(readonly kind: McpErrorKind, message: string, readonly sent = false) {
    super(message);
    this.name = "McpError";
  }
}
export const MCP_VERSION = "2025-11-25";
export const MCP_MAX_BYTES = 2 * 1024 * 1024;
export type McpRequestOptions = { readonly signal: AbortSignal; readonly deadlineMs: number };
export type McpTransportHandlers = {
  readonly message: (message: McpMessage) => void;
  readonly closed: (error: McpError) => void;
};
export interface McpTransport {
  start(handlers: McpTransportHandlers, signal: AbortSignal): Promise<void>;
  send(message: McpMessage, signal: AbortSignal): Promise<void>;
  openNotifications?(options: McpRequestOptions): Promise<void>;
  close(): Promise<void>;
}
export type McpToolDefinition = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: McpJsonObject;
  readonly outputSchema?: McpJsonObject;
  readonly annotations?: McpJsonObject;
  readonly execution?: McpJsonObject;
};
export type McpCallResult = {
  readonly content: readonly McpJsonObject[];
  readonly structuredContent?: McpJsonObject;
  readonly isError?: boolean;
};
