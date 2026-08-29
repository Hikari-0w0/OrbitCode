import { permissionApiErrorResponse } from "@/web/permission-http";
import { permissionSessionManager } from "@/web/permission-session-store";
import { assertSameOrigin } from "@/web/request-security";

export const dynamic = "force-dynamic";

export function POST(request: Request): Response {
  try {
    assertSameOrigin(request);
    const session = permissionSessionManager.createSession();
    return Response.json(
      { sessionId: session.id, mode: session.mode },
      { status: 201 },
    );
  } catch (error) {
    return permissionApiErrorResponse(error);
  }
}
