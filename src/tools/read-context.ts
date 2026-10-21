import type { ContextSearchInput, ContextSearchResult } from "@/core/context/context-search";
import { ContextManagementError } from "@/core/context/context-errors";
import type { ContextChunk } from "@/core/context/types";
import { defineTool, successfulToolResult } from "@/tools/registry";
import { integerSchema, objectSchema, optionalSchema, stringSchema } from "@/tools/schema";
import { toolFailure } from "@/tools/types";

export const MAX_CONTEXT_CHUNK_CHARACTERS = 32 * 1024;

export type ContextContentReader = (input: {
  readonly reference: string;
  readonly offset: number;
  readonly limit: number;
  readonly signal: AbortSignal;
}) => Promise<ContextChunk>;

export type ContextContentAccess = ContextContentReader | {
  readonly read: ContextContentReader;
  readonly search: (input: ContextSearchInput) => Promise<ContextSearchResult>;
};

export function createReadContextTool(access: ContextContentAccess) {
  const read = typeof access === "function" ? access : access.read;
  const search = typeof access === "function" ? undefined : access.search;
  return defineTool({
    name: "read_context",
    description:
      "按上下文压缩产生的 context:// 引用分块读取完整工具结果。逐字复制当前会话提供的引用，不猜引用、不传文件路径。可按搜索返回的偏移定位阅读；需要完整顺序扫描时从 offset=0 开始，按返回的 nextOffset 继续，不猜偏移或跳过未读内容。单页 hasMore=false 只表示已到结尾，不证明前面区间读完。limit 最大32768字符；覆盖不完整时不能声称目标不存在。" + (search ? " 查找已知文本优先提供 query（区分大小写的字面量，非正则），offset=0；运行时搜索整个引用，返回完整扫描范围、精确匹配数及最多4段摘录。无匹配只证明该字面量不存在，不证明语义事实不存在。" : ""),
    inputSchema: objectSchema({
      query: optionalSchema(stringSchema({ minLength: 1, maxLength: 128, description: "在整个引用中搜索字面量；搜索时 offset 必须为0，limit仅用于普通读取。" })),
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
        if (input.query !== undefined) {
          if (!search) return toolFailure("invalid-arguments", "当前引用适配器不支持全文搜索。", { retryable: false });
          if (input.offset !== 0) return toolFailure("invalid-arguments", "全文搜索的 offset 必须为0；定位阅读时省略 query。", { retryable: true });
          return successfulToolResult({ reference: input.reference, ...await search({ reference: input.reference, query: input.query, signal: context.signal }) });
        }
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
