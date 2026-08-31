import { fileToolFailure } from "@/tools/file-tool-result";
import { MAX_TEXT_FILE_BYTES } from "@/tools/read-file";
import { defineTool, successfulToolResult } from "@/tools/registry";
import { arraySchema, objectSchema, stringSchema } from "@/tools/schema";
import {
  MAX_TOOL_ARGUMENTS_JSON_CHARS,
  toolFailure,
  type JsonValue,
  type ResolvedWorkspacePath,
  type ToolInputSchema,
} from "@/tools/types";
import { WORKSPACE_RELATIVE_PATH_DESCRIPTION } from "@/tools/workspace-path";

export const MAX_WRITE_FILES_ITEMS = 32;
export const MAX_WRITE_FILES_TOTAL_BYTES = MAX_TOOL_ARGUMENTS_JSON_CHARS;

type WriteFilesInput = {
  readonly files: readonly {
    readonly path: string;
    readonly content: string;
  }[];
};

const baseWriteFilesSchema = objectSchema({
  files: arraySchema(
    objectSchema({
      path: stringSchema({
        minLength: 1,
        maxLength: 1_024,
        description: WORKSPACE_RELATIVE_PATH_DESCRIPTION,
      }),
      content: stringSchema({ maxLength: MAX_TEXT_FILE_BYTES }),
    }),
    {
      minItems: 1,
      maxItems: MAX_WRITE_FILES_ITEMS,
      description: "按顺序写入的文件列表。",
    },
  ),
});

const writeFilesSchema: ToolInputSchema<WriteFilesInput> = {
  jsonSchema: baseWriteFilesSchema.jsonSchema,
  parse(value) {
    const parsed = baseWriteFilesSchema.parse(value);
    if (!parsed.ok) return parsed;
    const issues = [];
    const paths = new Set<string>();
    let totalBytes = 0;
    for (const [index, file] of parsed.value.files.entries()) {
      const normalizedPath = file.path.replaceAll("\\", "/");
      if (paths.has(normalizedPath)) {
        issues.push({
          path: `$.files[${index}].path`,
          message: "同一批次不能重复写入同一路径。",
        });
      }
      paths.add(normalizedPath);
      const byteLength = Buffer.byteLength(file.content, "utf8");
      totalBytes += byteLength;
      if (byteLength > MAX_TEXT_FILE_BYTES) {
        issues.push({
          path: `$.files[${index}].content`,
          message: "单个文件内容超过允许大小。",
        });
      }
    }
    if (totalBytes > MAX_WRITE_FILES_TOTAL_BYTES) {
      issues.push({
        path: "$.files",
        message: "批量写入内容总大小超过允许上限。",
      });
    }
    return issues.length > 0
      ? { ok: false, issues }
      : { ok: true, value: parsed.value };
  },
};

type FileWriteResult = {
  readonly path: string;
  readonly byteLength: number;
  readonly created: boolean;
};

export const writeFilesTool = defineTool({
  name: "write_files",
  description:
    "按输入顺序创建或完整覆盖多个 Workspace UTF-8 文本文件，缺失的父目录会自动创建。适合一次生成多个独立文件；所有路径会先完成校验和授权，再串行原子写入。覆盖已有文件前仍应先读取最新内容。",
  inputSchema: writeFilesSchema,
  mutability: "workspace-write",
  permission: {
    targetKind: "path",
    resolve: (input) => input.files.map((file) => ({
      kind: "path" as const,
      requestedPath: file.path,
      resolution: "write-target" as const,
      byteLength: Buffer.byteLength(file.content, "utf8"),
    })),
  },
  async execute(input, context) {
    const targets: ResolvedWorkspacePath[] = [];
    try {
      for (const file of input.files) {
        if (context.signal.aborted) {
          return toolFailure("cancelled", "批量写入已取消。", { retryable: true });
        }
        targets.push(await context.workspace.resolveWriteTarget(file.path));
      }
    } catch (error) {
      return fileToolFailure(error, context.signal);
    }

    const written: FileWriteResult[] = [];
    for (const [index, file] of input.files.entries()) {
      const target = targets[index];
      if (target === undefined) {
        return toolFailure("execution-failed", "批量写入目标状态无效。");
      }
      if (context.signal.aborted) {
        return batchFailure(
          toolFailure("cancelled", "批量写入已取消。", { retryable: true }),
          written,
        );
      }
      try {
        await context.workspace.atomicWrite(target, file.content);
        written.push({
          path: target.relativePath,
          byteLength: Buffer.byteLength(file.content, "utf8"),
          created: !target.existed,
        });
      } catch (error) {
        return batchFailure(
          fileToolFailure(
            error,
            context.signal,
            written.length > 0 ? "applied" : "none",
          ),
          written,
        );
      }
    }
    return successfulToolResult({ files: written }, "applied");
  },
});

function batchFailure(
  failure: ReturnType<typeof toolFailure>,
  written: readonly FileWriteResult[],
) {
  if (failure.ok) return failure;
  return {
    ...failure,
    output: { files: written } satisfies JsonValue,
    sideEffect: written.length > 0 ? "applied" as const : failure.sideEffect,
  };
}
