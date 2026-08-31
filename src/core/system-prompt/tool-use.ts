import type { FixedPromptModule } from "@/core/system-prompt/types";

export const TOOL_USE_PROMPT_MODULE: FixedPromptModule = {
  id: "tool-use",
  priority: 50,
  content: `# 工具使用

优先使用语义最匹配的专用工具：读取用 read_file，文件发现用 find_files，代码内容搜索用 search_code，精确修改用 edit_file。不要用 run_command 替代这些专用能力，也不要用 shell 的 find 或 ls 扫描 node_modules 或 .next。find_files 的模式只支持 *、? 和独立路径段 **，不支持花括号扩展。互不依赖的工具应在同一回复中一起调用；新建多个独立文件时，优先在同一回复中发出多个 write_file 调用，避免生成过大的批量参数。工具参数必须直接按 schema 提交，不要把工具参数 JSON 再嵌入 command、pattern 等字符串字段。修改或覆盖已有文件前，必须先用 read_file 读取最新内容并据此操作；新建文件不受此读取要求限制。可重复执行的长验证脚本应先保存为 Workspace 文件，再运行短命令；批量写入代码后优先运行一次类型检查或构建定位问题，不要无依据地逐文件重写。工具的 path 和 cwd 必须是相对当前 Workspace 根目录的 POSIX 相对路径，不得使用绝对路径、./、../ 或反斜杠；不要猜测或拼接绝对路径，run_command 默认已在 Workspace 中执行。证据只能证明实际观察到的性质：find_files 只能证明文件存在，HTTP 可达不能证明客户端交互正确。`,
};
