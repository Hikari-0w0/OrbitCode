import { fileToolFailure } from "@/tools/file-tool-result";
import { defineTool, successfulToolResult } from "@/tools/registry";
import { objectSchema, stringSchema } from "@/tools/schema";
import { toolFailure } from "@/tools/types";
import { MAX_TEXT_FILE_BYTES } from "@/tools/read-file";
import { WORKSPACE_RELATIVE_PATH_DESCRIPTION } from "@/tools/workspace-path";

export const editFileTool = defineTool({
  name: "edit_file",
  description:
    "在已有文本文件中执行一次原文唯一匹配替换。调用前必须先用 read_file 读取最新内容，并从该内容构造唯一、精确的 old_text；不要用 shell 命令编辑文件。",
  inputSchema: objectSchema({
    path: stringSchema({
      minLength: 1,
      maxLength: 1_024,
      description: WORKSPACE_RELATIVE_PATH_DESCRIPTION,
    }),
    old_text: stringSchema({ minLength: 1, maxLength: MAX_TEXT_FILE_BYTES }),
    new_text: stringSchema({ maxLength: MAX_TEXT_FILE_BYTES }),
  }),
  mutability: "workspace-write",
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
      const first = snapshot.content.indexOf(input.old_text);
      if (first < 0) {
        return toolFailure("conflict", "待替换原文没有匹配。", { retryable: true });
      }
      if (snapshot.content.indexOf(input.old_text, first + input.old_text.length) >= 0) {
        return toolFailure("conflict", "待替换原文匹配多次，必须提供唯一上下文。", {
          retryable: true,
        });
      }
      if (input.old_text === input.new_text) {
        return toolFailure("conflict", "替换前后内容相同，文件未修改。", {
          retryable: true,
        });
      }
      const content =
        snapshot.content.slice(0, first) +
        input.new_text +
        snapshot.content.slice(first + input.old_text.length);
      const byteLength = Buffer.byteLength(content, "utf8");
      if (byteLength > MAX_TEXT_FILE_BYTES) {
        return toolFailure("limit-exceeded", "修改后的文件超过允许大小。", {
          retryable: true,
        });
      }
      await context.workspace.replaceSnapshot(snapshot, content);
      return successfulToolResult(
        { path: snapshot.path.relativePath, replacements: 1, byteLength },
        "applied",
      );
    } catch (error) {
      return fileToolFailure(error, context.signal);
    }
  },
});
