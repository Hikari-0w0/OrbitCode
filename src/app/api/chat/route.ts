import { ConfigurationError } from "@/models/config";
import { ConversationRepositoryError } from "@/core/conversations/types";
import { MAX_WEB_CHAT_BODY_BYTES, parseWebChatRequest, WebChatContractError, type WebApiError } from "@/web/chat-contract";
import { streamAgentResponse } from "@/web/chat-handler";
import { WorkspaceCatalogError } from "@/web/workspace-config";
import { PermissionSessionError } from "@/web/permission-session-manager";
import { assertSameOrigin, WebRequestSecurityError } from "@/web/request-security";
import { webAgentRuntime } from "@/web/agent-runtime";

export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    assertRequestSize(request);
    const input = parseWebChatRequest(await readJsonBody(request));
    const turn = await webAgentRuntime.prepare({ ...input,
      expectedRevision: input.revision, source: "web", signal: request.signal });
    return streamAgentResponse({ ...turn, request });
  } catch (error) { return startupErrorResponse(error); }
}

function assertRequestSize(request: Request): void {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_WEB_CHAT_BODY_BYTES)
  ) {
    throw new WebChatContractError("对话请求体过大。");
  }
}

async function readJsonBody(request: Request): Promise<unknown> {
  if (!request.body) throw new WebChatContractError("对话请求体不能为空。");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let source = "";
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_WEB_CHAT_BODY_BYTES) {
        await reader.cancel();
        throw new WebChatContractError("对话请求体过大。");
      }
      source += decoder.decode(result.value, { stream: true });
    }
    source += decoder.decode();
  } catch (error) {
    if (error instanceof WebChatContractError) throw error;
    throw new WebChatContractError("无法读取对话请求体。");
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new WebChatContractError("对话请求必须是有效 JSON。");
  }
}

function startupErrorResponse(error: unknown): Response {
  let status = 500;
  let message = "聊天服务暂时不可用。";
  let code: WebApiError["code"];
  if (error instanceof WebChatContractError) {
    status = 400;
    message = error.message;
  } else if (error instanceof ConfigurationError) {
    status = error.kind === "config-value" ? 400 : 503;
    message = error.message;
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
  } else if (error instanceof PermissionSessionError) {
    status = error.kind === "unknown-session" || error.kind === "session-closed"
      ? 404
      : 409;
    message = error.message;
    code = "permission-session";
  } else if (error instanceof ConversationRepositoryError) {
    status = error.kind === "not-found"
      ? 404
      : error.kind === "conflict" || error.kind === "busy"
        ? 409
        : 500;
    message = error.message;
    code = error.kind === "not-found"
      ? "conversation-not-found"
      : error.kind === "conflict"
        ? "conversation-conflict"
        : error.kind === "busy"
          ? "conversation-busy"
          : "conversation-storage";
  } else if (error instanceof WebRequestSecurityError) {
    status = error.kind === "forbidden-origin" ? 403 : 400;
    message = error.message;
    code = error.kind === "forbidden-origin" ? "forbidden" : "invalid-request";
  }
  const response: WebApiError = code === undefined
    ? { error: message }
    : { error: message, code };
  return Response.json(response, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
