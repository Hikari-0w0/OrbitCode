import { mcpDigest, redactMcpJson } from "@/lib/mcp-redaction";
import { McpError, type McpCallResult, type McpRequestOptions, type McpToolDefinition } from "@/mcp/types";
import { compileMcpSchema } from "@/tools/mcp-json-schema";
import { convertMcpResult } from "@/tools/mcp-result";
import { defineTool, type RegisteredTool } from "@/tools/registry";
import { toolFailure, type JsonObject, type ToolExecutionResult, type ToolName } from "@/tools/types";

export function mcpToolName(serverName: string, name: string): ToolName {
  const normalized = (text: string) => text.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 12);
  return `mcp__${normalized(serverName)}__${normalized(name)}__${mcpDigest([serverName, name]).slice(0, 24)}`;
}
export type McpToolBinding = {
  readonly serverName: string;
  readonly configurationId: string;
  readonly redact: (text: string) => string;
  readonly revalidate: (signal: AbortSignal) => Promise<ToolExecutionResult | undefined>;
  readonly call: (name: string, args: JsonObject, options: McpRequestOptions) => Promise<McpCallResult>;
};
export function createMcpTool(definition: McpToolDefinition, binding: McpToolBinding): RegisteredTool {
  if (binding.redact(definition.name) !== definition.name) throw new Error("MCP 工具名称包含配置秘密，不能注册。");
  if (definition.execution?.taskSupport === "required") throw new Error("MCP 工具要求未支持的 tasks 能力。");
  if (Buffer.byteLength(definition.description ?? "") > 4096) throw new Error("MCP 工具描述超过上限。");
  const source = JSON.stringify(definition.inputSchema);
  if (JSON.stringify(redactMcpJson(definition.inputSchema, binding.redact)) !== source) throw new Error("MCP Schema 含配置秘密，不能注册。");
  const schema = compileMcpSchema(definition.inputSchema);
  const schemaId = mcpDigest(definition);
  const tool = defineTool({
    name: mcpToolName(binding.serverName, definition.name),
    description: binding.redact(`[外部 MCP 工具，可能产生副作用] ${definition.description ?? definition.name}`),
    inputSchema: schema,
    mutability: "external",
    permission: {
      targetKind: "mcp",
      resolve(input: JsonObject) {
        return { kind: "mcp", operation: "call", serverName: binding.serverName, configurationId: binding.configurationId,
          toolIdentity: { originalName: definition.name, schemaId, argumentsId: mcpDigest(input) },
          summary: { operation: "调用外部工具", serverName: binding.serverName, toolName: binding.redact(definition.name), arguments: JSON.stringify(redactMcpJson(input, binding.redact)).slice(0, 4096), boundary: "外部 Server 不受本地文件沙箱保证" } };
      },
    },
    async execute(input, context) {
      const failure = await binding.revalidate(context.signal);
      if (failure) return failure;
      try {
        return convertMcpResult(await binding.call(definition.name, input, context), binding.serverName, definition.name, binding.redact, definition.outputSchema);
      } catch (error) {
        return error instanceof McpError
          ? toolFailure(error.kind, error.message, { sideEffect: error.sent ? "possible" : "none", retryable: false })
          : toolFailure("mcp-transport", "外部工具连接不可用。", { sideEffect: "possible" });
      }
    },
  });
  return { ...tool, externalIdentity: { serverName: binding.serverName, toolName: binding.redact(definition.name) }, prepareUnknown(input) {
    const prepared = tool.prepareUnknown(input);
    return prepared.kind === "ready" ? { kind: "ready", call: Object.freeze({ ...prepared.call, revalidate: binding.revalidate }) } : prepared;
  } };
}
