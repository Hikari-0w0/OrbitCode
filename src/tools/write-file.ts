import { fileToolFailure } from "@/tools/file-tool-result";
import { defineTool, successfulToolResult } from "@/tools/registry";
import { objectSchema, stringSchema } from "@/tools/schema";
import { toolFailure } from "@/tools/types";
import { MAX_TEXT_FILE_BYTES } from "@/tools/read-file";
import { WORKSPACE_RELATIVE_PATH_DESCRIPTION } from "@/tools/workspace-path";

export const writeFileTool = defineTool({
  name: "write_file",
  description:
    "创建或完整覆盖授权 Workspace 内的 UTF-8 文本文件，缺失的父目录会自动创建。仅新建文件可直接调用；覆盖已有文件前必须先用 read_file 读取最新内容，小范围修改优先使用 edit_file。",
  inputSchema: objectSchema({
    path: stringSchema({
      minLength: 1,
      maxLength: 1_024,
      description: WORKSPACE_RELATIVE_PATH_DESCRIPTION,
    }),
    content: stringSchema({ maxLength: MAX_TEXT_FILE_BYTES }),
  }),
  mutability: "workspace-write",
  permission: {
    targetKind: "path",
    resolve: (input) => ({
      kind: "path",
      requestedPath: input.path,
      resolution: "write-target",
      byteLength: Buffer.byteLength(input.content, "utf8"),
    }),
  },
  async execute(input, context) {
    const byteLength = Buffer.byteLength(input.content, "utf8");
    if (byteLength > MAX_TEXT_FILE_BYTES) {
      return toolFailure("limit-exceeded", "写入内容超过允许大小。", {
        retryable: true,
      });
    }
    try {
      const target = await context.workspace.resolveWriteTarget(input.path);
      await context.workspace.atomicWrite(target, input.content);
      return successfulToolResult(
        { path: target.relativePath, byteLength, created: !target.existed },
        "applied",
      );
    } catch (error) {
      return fileToolFailure(error, context.signal);
    }
  },
});
