import { permissionApiErrorResponse, requirePermissionSessionId } from "@/web/permission-http";
import { assertSameOrigin } from "@/web/request-security";
export async function POST(request: Request, context: { readonly params: Promise<{ readonly sessionId: string }> }): Promise<Response> {
  try {
    assertSameOrigin(request);
    requirePermissionSessionId((await context.params).sessionId);
    return Response.json({ error: "人工审批已移除，工具按权限规则直接执行或拒绝。" }, { status: 410 });
  } catch (error) { return permissionApiErrorResponse(error); }
}
