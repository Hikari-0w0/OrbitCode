import { webAgentRuntime } from "@/web/agent-runtime";
import { skillHttp } from "@/web/skill-http";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: {
    params: Promise<{
        conversationId: string;
    }>;
}) {
    return skillHttp(request, (await context.params).conversationId, webAgentRuntime);
}
export const POST = GET;
