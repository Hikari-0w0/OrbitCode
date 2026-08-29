import { ContextManagementError } from "@/core/context/context-errors";
import { ConfigurationError } from "@/models/config";
import { WebChatContractError, type WebApiError } from "@/web/chat-contract";
import { ContextSessionError } from "@/web/context-session-manager";
import { WebRequestSecurityError } from "@/web/request-security";
import { WorkspaceCatalogError } from "@/web/workspace-config";

export function contextApiErrorResponse(error: unknown): Response {
  let status = 500;
  let message = "上下文服务暂时不可用。";
  let code: WebApiError["code"] = "context-session";
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
  } else if (error instanceof ContextSessionError) {
    status = error.kind === "unknown-session" || error.kind === "session-closed"
      ? 404
      : 409;
    message = error.message;
  } else if (error instanceof ContextManagementError) {
    status = error.kind === "concurrent" ? 409 : 422;
    message = error.message;
    code = "context-compression";
  } else if (error instanceof WorkspaceCatalogError) {
    status = error.kind === "unknown-workspace" || error.kind === "config-value"
      ? 400
      : 503;
    message = error.message;
    code = error.kind === "unknown-workspace"
      ? "workspace-unknown"
      : error.kind === "workspace-unavailable"
        ? "workspace-unavailable"
        : "workspace-config";
  } else if (error instanceof ConfigurationError) {
    status = error.kind === "config-value" ? 400 : 503;
    message = error.message;
  }
  return Response.json(
    { error: message, code } satisfies WebApiError,
    { status, headers: { "cache-control": "no-store" } },
  );
}

export function requireContextSessionId(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new WebChatContractError("上下文会话 ID 无效。");
  }
  return value;
}
