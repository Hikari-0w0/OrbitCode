import { fileToolFailure } from "@/tools/file-tool-result";
import { compileGlob, GlobPatternError } from "@/tools/glob";
import { defineTool, successfulToolResult } from "@/tools/registry";
import { objectSchema, optionalSchema, stringSchema } from "@/tools/schema";
import { emptyResultMeta, toolFailure } from "@/tools/types";

const MAX_RESULTS = 1_000;

export const findFilesTool = defineTool({
  name: "find_files",
  description: "按受限 Glob 模式查找授权工作目录内的文件。",
  inputSchema: objectSchema({
    pattern: stringSchema({ minLength: 1, maxLength: 512 }),
    path: optionalSchema(stringSchema({ minLength: 1, maxLength: 1_024 })),
  }),
  mutability: "read-only",
  async execute(input, context) {
    let matcher;
    try {
      matcher = compileGlob(input.pattern);
    } catch (error) {
      if (error instanceof GlobPatternError) {
        return toolFailure("invalid-arguments", error.message, { retryable: true });
      }
      return toolFailure("execution-failed", "无法解析文件模式。");
    }
    try {
      const paths: string[] = [];
      let truncated = false;
      for await (const entry of context.workspace.walk({
        path: input.path,
        signal: context.signal,
      })) {
        if (!matcher.matches(entry.relativePath)) continue;
        if (paths.length === MAX_RESULTS) {
          truncated = true;
          break;
        }
        paths.push(entry.relativePath);
      }
      return successfulToolResult(
        { paths, count: paths.length },
        "none",
        {
          ...emptyResultMeta(),
          truncated,
          truncatedFields: truncated ? ["paths"] : [],
        },
      );
    } catch (error) {
      return fileToolFailure(error, context.signal);
    }
  },
});
