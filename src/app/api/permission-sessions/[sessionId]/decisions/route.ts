import { parsePermissionDecisionRequest } from "@/web/chat-contract";
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

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { sessionId: rawSessionId } = await context.params;
    const sessionId = requirePermissionSessionId(rawSessionId);
    const body = parsePermissionDecisionRequest(
      await readPermissionJsonBody(request),
    );
    permissionSessionManager.resolveDecision(
      sessionId,
      body.requestId,
      body.decision,
    );
    return Response.json({ accepted: true } as const);
  } catch (error) {
    return permissionApiErrorResponse(error);
  }
}
