import { permissionApiErrorResponse } from "@/web/permission-http";
import { permissionSessionManager } from "@/web/permission-session-store";
import { assertSameOrigin } from "@/web/request-security";
import { webSettingsStore } from "@/web/storage-paths";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const mode = (await webSettingsStore.load())?.defaultPermissionMode;
    const session = permissionSessionManager.createSession();
    if (mode) permissionSessionManager.setMode(session.id, mode);
    return Response.json(
      { sessionId: session.id, mode: mode ?? session.mode },
      { status: 201 },
    );
  } catch (error) {
    return permissionApiErrorResponse(error);
  }
}
