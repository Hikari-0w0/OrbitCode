import { parsePermissionSessionUpdateRequest } from "@/web/chat-contract";
import {
  permissionApiErrorResponse,
  requirePermissionSessionId,
} from "@/web/permission-http";
import { permissionSessionManager } from "@/web/permission-session-store";
import {
  assertSameOrigin,
  readPermissionJsonBody,
} from "@/web/request-security";

type RouteContext = {
  readonly params: Promise<{ readonly sessionId: string }>;
};

export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { sessionId: rawSessionId } = await context.params;
    const sessionId = requirePermissionSessionId(rawSessionId);
    const body = parsePermissionSessionUpdateRequest(
      await readPermissionJsonBody(request),
    );
    const session = permissionSessionManager.setMode(sessionId, body.mode);
    return Response.json({ sessionId: session.id, mode: session.mode });
  } catch (error) {
    return permissionApiErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { sessionId: rawSessionId } = await context.params;
    const sessionId = requirePermissionSessionId(rawSessionId);
    permissionSessionManager.closeSession(sessionId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return permissionApiErrorResponse(error);
  }
}
