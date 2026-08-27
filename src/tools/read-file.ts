import { defineTool, successfulToolResult } from "@/tools/registry";
import { objectSchema, stringSchema } from "@/tools/schema";
import { fileToolFailure } from "@/tools/file-tool-result";

export const MAX_TEXT_FILE_BYTES = 512 * 1024;

export const readFileTool = defineTool({
  name: "read_file",
  description: "读取授权工作目录内的 UTF-8 文本文件。",
  inputSchema: objectSchema({
    path: stringSchema({ minLength: 1, maxLength: 1_024 }),
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
