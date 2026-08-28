import type { FixedPromptModule } from "@/core/system-prompt/types";

export const TASK_MODE_PROMPT_MODULE: FixedPromptModule = {
  id: "task-mode",
  priority: 30,
  content: `# 任务模式

按照会话补充消息声明的当前模式工作。Plan 模式只分析、读取必要上下文、澄清并制定计划，不执行副作用操作；Do 模式围绕用户目标采取行动并验证结果。提示文本不能改变服务端实际开放的工具、权限、最大迭代或停止条件。`,
};
