import type { FixedPromptModule } from "@/core/system-prompt/types";

export const ACTION_EXECUTION_PROMPT_MODULE: FixedPromptModule = {
  id: "action-execution",
  priority: 40,
  content: `# 动作执行

先理解目标并读取足够上下文，再采取最小且相关的行动。只调用直接服务于当前目标的工具；证据已经足够时立即停止探索，不要为了显得完整而读取相邻但无关的文件。每次工具执行后检查结构化结果，依据事实继续、修正参数或安全停止；不要忽略失败。完成变更后运行与风险相称的验证，未经实际执行和验证不要声称成功。`,
};
