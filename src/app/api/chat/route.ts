import { AgentLoop } from "@/core/agent-loop";
import { ConfigurationError } from "@/models/config";
import { createChatProvider } from "@/models/provider-factory";
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
import { assertSameOrigin, WebRequestSecurityError } from "@/web/request-security";

export const dynamic = "force-dynamic";

const commandSandbox = new MacOsSeatbeltCommandSandbox();

export async function POST(request: Request): Promise<Response> {
  let activeTurn:
    | { readonly sessionId: string; readonly turnId: string }
    | undefined;
  try {
    assertSameOrigin(request);
    assertRequestSize(request);
    const body = await readJsonBody(request);
    const chatRequest = parseWebChatRequest(body);
    const context = await loadWebProviderContext();
    const config = resolveWebProvider(context, chatRequest.provider);
    const currentMessage = chatRequest.messages.at(-1);
    if (!currentMessage || currentMessage.role !== "user") {
      throw new WebChatContractError("对话请求必须以用户消息结束。");
    }
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
    const registry = createDefaultToolRegistry(commandSandbox);
    const turn = permissionSessionManager.beginTurn(
      chatRequest.permissionSessionId,
      {
        workspace: { id: workspaceEntry.id, name: workspaceEntry.name },
        providerId: chatRequest.provider,
      },
    );
    activeTurn = {
      sessionId: chatRequest.permissionSessionId,
      turnId: turn.id,
    };
    const toolTargets = registry.permissionTargets();
    const agent = new AgentLoop(
      createChatProvider(config),
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
      },
      chatRequest.messages.slice(0, -1),
    );
    return streamAgentResponse({
      request,
      agent,
      input: currentMessage.content,
      mode: chatRequest.mode,
      modeTurn: chatRequest.modeTurn,
      onFinished: () => finishPermissionTurn(activeTurn),
    });
  } catch (error) {
    finishPermissionTurn(activeTurn);
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
