import type { ContextSessionResponse } from "@/web/chat-contract";
import {
  contextApiErrorResponse,
  requireContextSessionId,
} from "@/web/context-http";
import { contextSessionManager } from "@/web/context-session-store";
import { assertSameOrigin } from "@/web/request-security";

type RouteContext = {
  readonly params: Promise<{ readonly sessionId: string }>;
};

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { sessionId: rawSessionId } = await context.params;
    const session = contextSessionManager.getSession(
      requireContextSessionId(rawSessionId),
    );
    const response: ContextSessionResponse = {
      sessionId: session.id,
      provider: session.binding.providerId,
      workspaceId: session.binding.workspace.id,
    };
    return Response.json(response, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return contextApiErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { sessionId: rawSessionId } = await context.params;
    await contextSessionManager.closeSession(
      requireContextSessionId(rawSessionId),
    );
    return new Response(null, { status: 204 });
  } catch (error) {
    return contextApiErrorResponse(error);
  }
}
