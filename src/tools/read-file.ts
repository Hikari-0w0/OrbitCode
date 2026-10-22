import { defineTool, successfulToolResult } from "@/tools/registry";
import { createHash } from "node:crypto";
import { integerSchema, objectSchema, optionalSchema, stringSchema } from "@/tools/schema";
import { fileToolFailure } from "@/tools/file-tool-result";
import { WORKSPACE_RELATIVE_PATH_DESCRIPTION } from "@/tools/workspace-path";
import { toolFailure, type ToolInputSchema } from "@/tools/types";

export const MAX_TEXT_FILE_BYTES = 512 * 1024;
const MAX_READ_LINES = 2_000;
const DEFAULT_READ_LINES = 200;

type ReadFileInput = { readonly path: string; readonly start_line?: number; readonly end_line?: number };
const baseReadFileSchema = objectSchema({
  path: stringSchema({ minLength: 1, maxLength: 1_024, description: WORKSPACE_RELATIVE_PATH_DESCRIPTION }),
  start_line: optionalSchema(integerSchema({ minimum: 1, maximum: 1_000_000, description: "从1开始的起始行。定位代码后优先按行读取；省略起止行则兼容完整读取。" })),
  end_line: optionalSchema(integerSchema({ minimum: 1, maximum: 1_000_000, description: "包含在结果中的结束行，单次最多2000行；指定起始行但省略结束行时最多读取200行。" })),
});
const readFileSchema: ToolInputSchema<ReadFileInput> = {
  jsonSchema: baseReadFileSchema.jsonSchema,
  parse(value) {
    const parsed = baseReadFileSchema.parse(value);
    if (!parsed.ok) return parsed;
    const start = parsed.value.start_line ?? 1;
    const end = parsed.value.end_line;
    if (end !== undefined && (end < start || end - start >= MAX_READ_LINES)) {
      return { ok: false, issues: [{ path: "$.end_line", message: "结束行必须不小于起始行，且单次最多读取2000行。" }] };
    }
    return parsed;
  },
};

export const readFileTool = defineTool({
  name: "read_file",
  description:
    "读取授权 Workspace 内 UTF-8 文本文件的最新内容，检查或准备修改文件时优先使用本工具。已定位代码时优先用start_line/end_line读取连续原文，结果range给出实际行号与是否覆盖全文。省略行参数则完整读取。分段内容不能当作完整文件覆盖写入；不要用shell替代读取。",
  inputSchema: readFileSchema,
  mutability: "read-only",
  permission: {
    targetKind: "path",
    resolve: (input) => ({
      kind: "path",
      requestedPath: input.path,
      resolution: "existing-file",
    }),
  },
  async execute(input, context) {
    try {
      const snapshot = await context.workspace.readTextFile(input.path, {
        maxBytes: MAX_TEXT_FILE_BYTES,
      });
      if (input.start_line !== undefined || input.end_line !== undefined) {
        // 保留换行符，分段结果仍可作为精确替换的原文；文件指纹始终针对完整快照。
        const lines = snapshot.content.match(/[^\n]*\n|[^\n]+$/gu) ?? [""];
        const startLine = input.start_line ?? 1;
        if (startLine > lines.length) return toolFailure("invalid-arguments", `起始行超过文件总行数 ${lines.length}。`, { retryable: true });
        const endLine = Math.min(input.end_line ?? startLine + DEFAULT_READ_LINES - 1, lines.length);
        return successfulToolResult({
          path: snapshot.path.relativePath,
          content: lines.slice(startLine - 1, endLine).join(""),
          byteLength: snapshot.byteLength,
          sha256: createHash("sha256").update(snapshot.content).digest("hex"),
          range: { startLine, endLine, totalLines: lines.length, complete: startLine === 1 && endLine === lines.length },
        });
      }
      return successfulToolResult({
        path: snapshot.path.relativePath,
        content: snapshot.content,
        byteLength: snapshot.byteLength,
      });
    } catch (error) {
      return fileToolFailure(error, context.signal);
    }
  },
});
