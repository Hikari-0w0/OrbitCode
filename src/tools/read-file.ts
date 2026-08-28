import { defineTool, successfulToolResult } from "@/tools/registry";
import { objectSchema, stringSchema } from "@/tools/schema";
import { fileToolFailure } from "@/tools/file-tool-result";
import { WORKSPACE_RELATIVE_PATH_DESCRIPTION } from "@/tools/workspace-path";

export const MAX_TEXT_FILE_BYTES = 512 * 1024;

export const readFileTool = defineTool({
  name: "read_file",
  description:
    "读取授权 Workspace 内 UTF-8 文本文件的最新内容。检查文件或准备修改、覆盖已有文件时优先使用本工具；不要用 shell 命令代替读取。",
  inputSchema: objectSchema({
    path: stringSchema({
      minLength: 1,
      maxLength: 1_024,
      description: WORKSPACE_RELATIVE_PATH_DESCRIPTION,
    }),
  }),
  mutability: "read-only",
  async execute(input, context) {
    try {
      const snapshot = await context.workspace.readTextFile(input.path, {
        maxBytes: MAX_TEXT_FILE_BYTES,
      });
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
