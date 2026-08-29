import { AgentLoop } from "@/core/agent-loop";
import { ConfigurationError } from "@/models/config";
import { createDefaultToolRegistry } from "@/tools/default-registry";
import { MacOsSeatbeltCommandSandbox } from "@/tools/macos-seatbelt-sandbox";
import { createModeToolPolicy } from "@/tools/mode-policy";
import { PermissionGateway } from "@/tools/permission-gateway";
import {
  addLocalPermissionAllow,
  loadPermissionRules,
} from "@/tools/permission-config";
import {
  MAX_WEB_CHAT_BODY_BYTES,
  parseWebChatRequest,
  WebChatContractError,
  type WebApiError,
} from "@/web/chat-contract";
import { streamAgentResponse } from "@/web/chat-handler";
import {
  loadWebProviderContext,
  resolveWebProvider,
} from "@/web/server-config";
import {
  loadWorkspaceCatalog,
  resolveWorkspaceBoundary,
  WorkspaceCatalogError,
} from "@/web/workspace-config";
import { createPromptEnvironment } from "@/web/prompt-environment";
import { permissionSessionManager } from "@/web/permission-session-store";
import { PermissionSessionError } from "@/web/permission-session-manager";
import { contextSessionManager } from "@/web/context-session-store";
import { ContextSessionError } from "@/web/context-session-manager";
import { assertSameOrigin, WebRequestSecurityError } from "@/web/request-security";

export const dynamic = "force-dynamic";

const commandSandbox = new MacOsSeatbeltCommandSandbox();

export async function POST(request: Request): Promise<Response> {
  let activeTurn:
    | { readonly sessionId: string; readonly turnId: string }
    | undefined;
  let activeContext:
    | { readonly sessionId: string; readonly operationId: string }
    | undefined;
  try {
    assertSameOrigin(request);
    assertRequestSize(request);
    const body = await readJsonBody(request);
    const chatRequest = parseWebChatRequest(body);
    const context = await loadWebProviderContext();
    resolveWebProvider(context, chatRequest.provider);
    const workspaceCatalog = await loadWorkspaceCatalog();
    const workspace = await resolveWorkspaceBoundary(
      workspaceCatalog,
      chatRequest.workspaceId,
    );
    const workspaceEntry = workspaceCatalog.entries.find(
      (entry) => entry.id === chatRequest.workspaceId,
    );
    if (!workspaceEntry) {
      throw new WorkspaceCatalogError(
        "unknown-workspace",
        "选择的 Workspace 未经服务端授权。",
      );
    }
    const binding = {
      workspace: { id: workspaceEntry.id, name: workspaceEntry.name },
      providerId: chatRequest.provider,
    } as const;
    const contextTurn = contextSessionManager.beginAgentTurn(
      chatRequest.contextSessionId,
      binding,
    );
    activeContext = {
      sessionId: chatRequest.contextSessionId,
      operationId: contextTurn.id,
    };
    const registry = createDefaultToolRegistry(
      commandSandbox,
      contextTurn.readContext,
    );
    const turn = permissionSessionManager.beginTurn(
      chatRequest.permissionSessionId,
      binding,
    );
    activeTurn = {
      sessionId: chatRequest.permissionSessionId,
      turnId: turn.id,
    };
    const toolTargets = registry.permissionTargets();
    const agent = new AgentLoop(
      contextTurn.provider,
      (mode) => createModeToolPolicy(registry, mode),
      workspace,
      {
        maxIterations: context.maxIterations,
        promptEnvironment: createPromptEnvironment({
          workspace: { id: workspaceEntry.id, name: workspaceEntry.name },
        }),
        permissionGatewayForMode: (agentMode) => new PermissionGateway({
          agentMode,
          permissionMode: () =>
            permissionSessionManager.getSession(chatRequest.permissionSessionId).mode,
          workspace,
          broker: turn.broker,
          loadRules: async () =>
            (await loadPermissionRules({
              workspaceRoot: workspace.root,
              toolTargets,
            })).rules,
          persistAllow: async (expression) => {
            await addLocalPermissionAllow({
              workspaceRoot: workspace.root,
              toolTargets,
              expression,
            });
          },
        }),
        contextManager: contextTurn.context,
      },
    );
    return streamAgentResponse({
      request,
      agent,
      input: chatRequest.input,
      mode: chatRequest.mode,
      modeTurn: chatRequest.modeTurn,
      operationSignal: contextTurn.signal,
      onFinished: () => {
        finishPermissionTurn(activeTurn);
        finishContextOperation(activeContext);
      },
    });
  } catch (error) {
    finishPermissionTurn(activeTurn);
    finishContextOperation(activeContext);
    return startupErrorResponse(error);
  }
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
  } else if (error instanceof ContextSessionError) {
    status = error.kind === "unknown-session" || error.kind === "session-closed"
      ? 404
      : 409;
    message = error.message;
    code = "context-session";
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

function finishContextOperation(
  active:
    | { readonly sessionId: string; readonly operationId: string }
    | undefined,
): void {
  if (!active) return;
  try {
    contextSessionManager.finishOperation(active.sessionId, active.operationId);
  } catch (error) {
    if (!(error instanceof ContextSessionError)) throw error;
  }
}

function finishPermissionTurn(
  activeTurn:
    | { readonly sessionId: string; readonly turnId: string }
    | undefined,
): void {
  if (!activeTurn) return;
  try {
    permissionSessionManager.finishTurn(
      activeTurn.sessionId,
      activeTurn.turnId,
    );
  } catch (error) {
    if (!(error instanceof PermissionSessionError)) throw error;
  }
}
