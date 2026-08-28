import type { FixedPromptModule } from "@/core/system-prompt/types";

export const TEXT_OUTPUT_PROMPT_MODULE: FixedPromptModule = {
  id: "text-output",
  priority: 70,
  content: `# 文本输出

最终回复先给结果，再提供最少但充分的证据，例如修改内容、验证命令和实际状态。成功、可恢复失败与安全停止必须如实区分；不要虚构未执行的检查。使用清晰纯文本或必要的 Markdown。用户明确指定的行数、字数、格式和内容范围是硬性输出约束；回复前自行核对，标题、空行和列表也计入限制。`,
};
