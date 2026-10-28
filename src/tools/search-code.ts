import { fileToolFailure } from "@/tools/file-tool-result";
import { compileGlob, GlobPatternError } from "@/tools/glob";
import { defineTool, successfulToolResult } from "@/tools/registry";
import {
  booleanSchema,
  objectSchema,
  optionalSchema,
  stringSchema,
} from "@/tools/schema";
import { emptyResultMeta, toolFailure } from "@/tools/types";
import type { WalkOptions, WorkspaceBoundary, WorkspaceEntry } from "@/tools/types";
import { WorkspaceError } from "@/tools/workspace";


const MAX_SCAN_BYTES = 1024 * 1024;
const MAX_MATCHES = 500;
const MAX_LINE_PREVIEW = 500;

export const searchCodeTool = defineTool({
  name: "search_code",
  description:
    "在授权 Workspace 内按字面量搜索 UTF-8 代码内容，优先于 shell 的 grep/rg。返回命中行列与周围原文，textStartColumn省略时为1；核实实现可用read_file按命中行分段读取。",
  inputSchema: objectSchema({
    query: stringSchema({ minLength: 1, maxLength: 1_024 }),
    path: optionalSchema(stringSchema({
      minLength: 1,
      maxLength: 1_024,
      description: "搜索文件或起始目录，相对 Workspace 根目录，例如 src/core 或 src/core/agent-loop.ts；省略则搜索根目录。不能传 glob、绝对路径或 ../。",
    })),
    file_pattern: optionalSchema(stringSchema({ minLength: 1, maxLength: 512, description: "相对 Workspace 根目录的文件 glob，例如 src/core/agent-loop.ts 或 **/*.ts；不是相对 path 目录。" })),
    case_sensitive: optionalSchema(booleanSchema()),
  }),
  mutability: "read-only",
  permission: {
    targetKind: "path",
    resolve: (input) => ({
      kind: "path",
      requestedPath: input.path ?? ".",
      resolution: "existing-path",
    }),
  },
  async execute(input, context) {
    let matcher;
    try {
      matcher = compileGlob(input.file_pattern ?? "**");
    } catch (error) {
      if (error instanceof GlobPatternError) {
        return toolFailure("invalid-arguments", error.message, { retryable: true });
      }
      return toolFailure("execution-failed", "无法解析文件模式。");
    }
    const caseSensitive = input.case_sensitive ?? true;
    const query = caseSensitive ? input.query : input.query.toLocaleLowerCase("en");
    const matches: Array<{
      readonly path: string;
      readonly line: number;
      readonly column: number;
      readonly text: string;
      readonly textTruncated: boolean;
      readonly textStartColumn?: number;
    }> = [];
    let skippedFiles = 0;
    let truncated = false;
    try {
      outer: for await (const entry of searchEntries(context.workspace, {
        path: input.path,
        pattern: input.file_pattern,
        signal: context.signal,
      })) {
        if (!matcher.matches(entry.relativePath)) continue;
        if (entry.byteLength > MAX_SCAN_BYTES) {
          skippedFiles++;
          continue;
        }
        let snapshot;
        try {
          snapshot = await context.workspace.readTextFile(entry.relativePath, {
            maxBytes: MAX_SCAN_BYTES,
          });
        } catch {
          skippedFiles++;
          continue;
        }
        const lines = snapshot.content.split(/\r?\n/);
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
          const source = caseSensitive ? lines[lineIndex] : lines[lineIndex].toLocaleLowerCase("en");
          let offset = 0;
          for (;;) {
            const found = source.indexOf(query, offset);
            if (found < 0) break;
            if (matches.length === MAX_MATCHES) {
              truncated = true;
              break outer;
            }
            const original = lines[lineIndex];
            const previewLength = Math.max(MAX_LINE_PREVIEW, query.length + 200);
            let previewStart = Math.max(0, Math.min(found - 100, original.length - previewLength));
            if (previewStart > 0 && /[\uDC00-\uDFFF]/u.test(original[previewStart])) previewStart--;
            let previewEnd = Math.min(original.length, previewStart + previewLength);
            if (previewEnd < original.length && /[\uDC00-\uDFFF]/u.test(original[previewEnd])) previewEnd++;
            matches.push({
              path: entry.relativePath,
              line: lineIndex + 1,
              column: found + 1,
              text: original.slice(previewStart, previewEnd),
              textTruncated: previewStart > 0 || previewEnd < original.length,
              ...(previewStart > 0 ? { textStartColumn: previewStart + 1 } : {}),
            });
            offset = found + Math.max(1, query.length);
          }
        }
      }
      return successfulToolResult(
        { matches, count: matches.length, skippedFiles },
        "none",
        {
          ...emptyResultMeta(),
          truncated,
          truncatedFields: truncated ? ["matches"] : [],
        },
      );
    } catch (error) {
      return fileToolFailure(error, context.signal);
    }
  },
});

async function* searchEntries(workspace: WorkspaceBoundary, options: WalkOptions): AsyncIterable<WorkspaceEntry> {
  options.signal.throwIfAborted();
  try { await workspace.resolveExistingDirectory(options.path); }
  catch (error) {
    if (!(error instanceof WorkspaceError) || error.kind !== "not-directory" || options.path === undefined) throw error;
    const file = await workspace.resolveExistingFile(options.path);
    if (!file.identity) throw new WorkspaceError("execution-failed", "文件身份缺失。");
    yield { relativePath: file.relativePath, absolutePath: file.absolutePath, byteLength: file.identity.size };
    return;
  }
  yield* workspace.walk(options);
}
