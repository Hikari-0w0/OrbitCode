import { parseConversationMutationRequest } from "@/web/chat-contract";
import { conversationApiErrorResponse } from "@/web/conversation-http";
import { assertSameOrigin, readPermissionJsonBody } from "@/web/request-security";
import { webConversationService } from "@/web/agent-runtime";

type RouteContext = { readonly params: Promise<{ readonly conversationId: string }> };
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { conversationId } = await context.params;
    const body = parseConversationMutationRequest(await readPermissionJsonBody(request));
    const result = await webConversationService.compress({ conversationId, ...body, signal: request.signal });
    return Response.json(result.report, { headers: { "cache-control": "no-store" } });
  } catch (error) { return conversationApiErrorResponse(error); }
}
