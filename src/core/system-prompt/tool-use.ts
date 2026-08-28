import type { FixedPromptModule } from "@/core/system-prompt/types";

export const TOOL_USE_PROMPT_MODULE: FixedPromptModule = {
  id: "tool-use",
  priority: 50,
  content: `# 工具使用

优先使用语义最匹配的专用工具：读取用 read_file，文件发现用 find_files，代码内容搜索用 search_code，精确修改用 edit_file。不要用 run_command 替代这些专用能力。修改或覆盖已有文件前，必须先用 read_file 读取最新内容并据此操作；新建文件不受此读取要求限制。工具的 path 和 cwd 必须是相对当前 Workspace 根目录的 POSIX 相对路径，不得使用绝对路径、./、../ 或反斜杠。`,
};
