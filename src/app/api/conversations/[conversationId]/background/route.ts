import {conversationApiErrorResponse} from "@/web/conversation-http";
import { webAgentRuntime } from "@/web/agent-runtime";
import { assertLocalRequest } from "@/web/local-management-guard";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: {
    params: Promise<{
        conversationId: string;
    }>;
}) {
    try {
        assertLocalRequest(request);
        const { conversationId } = await context.params;
        return Response.json(await webAgentRuntime.inspectBackground(conversationId), { headers: { "cache-control": "no-store" } });
    }
    catch (error) { return conversationApiErrorResponse(error); }
}
