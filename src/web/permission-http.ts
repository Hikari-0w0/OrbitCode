import { WebChatContractError, type WebApiError } from "@/web/chat-contract";
import { PermissionSessionError } from "@/web/permission-session-manager";
import { WebRequestSecurityError } from "@/web/request-security";

export function permissionApiErrorResponse(error: unknown): Response {
  let status = 500;
  let message = "权限服务暂时不可用。";
  let code: WebApiError["code"] = "permission-session";
  if (error instanceof WebChatContractError) {
    status = 400;
    message = error.message;
    code = "invalid-request";
  } else if (error instanceof WebRequestSecurityError) {
    status = error.kind === "forbidden-origin"
      ? 403
      : error.kind === "body-too-large"
        ? 413
        : 400;
    message = error.message;
    code = error.kind === "forbidden-origin" ? "forbidden" : "invalid-request";
  } else if (error instanceof PermissionSessionError) {
    status = error.kind === "unknown-session" || error.kind === "session-closed"
      ? 404
      : 409;
    message = error.message;
    code = error.kind === "unknown-request"
      ? "permission-request"
      : "permission-session";
  }
  return Response.json({ error: message, code } satisfies WebApiError, { status });
}

export function requirePermissionSessionId(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new WebChatContractError("权限会话 ID 无效。");
  }
  return value;
}
