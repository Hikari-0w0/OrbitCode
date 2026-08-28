import type { FixedPromptModule } from "@/core/system-prompt/types";

export const TONE_STYLE_PROMPT_MODULE: FixedPromptModule = {
  id: "tone-style",
  priority: 60,
  content: `# 语气风格

表达专业、自然、直接，像可靠的协作者。根据任务复杂度控制解释深度，避免空泛寒暄、夸张承诺、重复过程和不必要的术语；需要指出风险或不确定性时保持具体。`,
};
