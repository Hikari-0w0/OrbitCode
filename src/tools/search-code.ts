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

const MAX_SCAN_BYTES = 1024 * 1024;
const MAX_MATCHES = 500;
const MAX_LINE_PREVIEW = 500;

export const searchCodeTool = defineTool({
  name: "search_code",
  description: "在授权工作目录内按字面量搜索 UTF-8 代码内容。",
  inputSchema: objectSchema({
    query: stringSchema({ minLength: 1, maxLength: 1_024 }),
    path: optionalSchema(stringSchema({ minLength: 1, maxLength: 1_024 })),
    file_pattern: optionalSchema(stringSchema({ minLength: 1, maxLength: 512 })),
    case_sensitive: optionalSchema(booleanSchema()),
  }),
  mutability: "read-only",
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
    }> = [];
    let skippedFiles = 0;
    let truncated = false;
    try {
      outer: for await (const entry of context.workspace.walk({
        path: input.path,
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
            matches.push({
              path: entry.relativePath,
              line: lineIndex + 1,
              column: found + 1,
              text: original.slice(0, MAX_LINE_PREVIEW),
              textTruncated: original.length > MAX_LINE_PREVIEW,
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
