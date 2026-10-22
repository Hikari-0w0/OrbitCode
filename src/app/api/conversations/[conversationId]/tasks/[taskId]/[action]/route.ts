import { webAgentRuntime } from "@/web/agent-runtime";
import { agentTaskHttp } from "@/web/agent-task-http";

export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ conversationId: string; taskId: string; action: string }> }) {
  const { conversationId, taskId, action } = await context.params;
  // 操作白名单、来源和参数校验集中在共享入口，避免新增操作只接入一半路由。
  return agentTaskHttp(request, conversationId, webAgentRuntime, taskId, action);
}
