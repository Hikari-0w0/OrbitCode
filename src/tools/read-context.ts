import { ContextManagementError } from "@/core/context/context-errors";
import type { ContextChunk } from "@/core/context/types";
import { defineTool, successfulToolResult } from "@/tools/registry";
import { integerSchema, objectSchema, stringSchema } from "@/tools/schema";
import { toolFailure } from "@/tools/types";

export const MAX_CONTEXT_CHUNK_CHARACTERS = 32 * 1024;

export type ContextContentReader = (input: {
  readonly reference: string;
  readonly offset: number;
  readonly limit: number;
  readonly signal: AbortSignal;
}) => Promise<ContextChunk>;

export function createReadContextTool(read: ContextContentReader) {
  return defineTool({
    name: "read_context",
    description:
      "按上下文压缩产生的 context:// 引用分块读取完整工具结果。只接受当前会话提供的引用；不要传入文件路径。",
    inputSchema: objectSchema({
      reference: stringSchema({
        minLength: 1,
        maxLength: 256,
        description: "工具结果占位内容中的 context:// 引用。",
      }),
      offset: integerSchema({
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
        description: "从零开始的 Unicode 字符偏移。",
      }),
      limit: integerSchema({
        minimum: 1,
        maximum: MAX_CONTEXT_CHUNK_CHARACTERS,
        description: "本次最多读取的 Unicode 字符数。",
      }),
    }),
    mutability: "read-only",
    permission: {
      targetKind: "context",
      resolve: (input) => ({
        kind: "context",
        reference: input.reference,
      }),
    },
    async execute(input, context) {
      try {
        const chunk = await read({ ...input, signal: context.signal });
        return successfulToolResult({
          reference: input.reference,
          content: chunk.content,
          offset: chunk.offset,
          nextOffset: chunk.nextOffset,
          totalCharacters: chunk.totalCharacters,
          hasMore: chunk.hasMore,
        });
      } catch (error) {
        if (
          context.signal.aborted ||
          (error instanceof ContextManagementError && error.kind === "cancelled")
        ) {
          return toolFailure("cancelled", "上下文读取已取消。");
        }
        return toolFailure(
          "context-reference",
          "上下文引用无效、已过期或不属于当前会话。",
          { retryable: true },
        );
      }
    },
  });
}
