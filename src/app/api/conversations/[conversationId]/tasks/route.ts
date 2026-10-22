import { webAgentRuntime } from "@/web/agent-runtime";
import { agentTaskHttp } from "@/web/agent-task-http";
export const dynamic="force-dynamic";
export async function GET(request:Request, context:{params:Promise<{conversationId:string;taskId?:string}>}) { const params=await context.params;return agentTaskHttp(request,params.conversationId,webAgentRuntime, undefined); }
