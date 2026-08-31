import { AgentLoop } from "@/core/agent-loop";
import { ContextManager } from "@/core/context/context-manager";
import { CompletionTracker } from "@/core/completion-tracker";
import {
  appendPersistedTurn,
  deriveConversationTitle,
} from "@/core/conversations/display-timeline";
import {
  ConversationRepositoryError,
  type ConversationSummary,
} from "@/core/conversations/types";
import { ConfigurationError } from "@/models/config";
import { createChatProvider } from "@/models/provider-factory";
import { createDefaultToolRegistry } from "@/tools/default-registry";
import { MacOsSeatbeltCommandSandbox } from "@/tools/macos-seatbelt-sandbox";
import { ManagedProcessController } from "@/tools/managed-process";
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
import {
  conversationOperationGuard,
  conversationRuntimeManager,
  localConversationStore,
} from "@/web/conversation-store";
import type { GuardedConversationOperation } from "@/web/conversation-operation-guard";
import { assertSameOrigin, WebRequestSecurityError } from "@/web/request-security";
import { localAgentRunLog } from "@/web/agent-run-log-store";

export const dynamic = "force-dynamic";

const commandSandbox = new MacOsSeatbeltCommandSandbox();

export async function POST(request: Request): Promise<Response> {
  let activeTurn:
    | { readonly sessionId: string; readonly turnId: string }
    | undefined;
  let activeConversation: GuardedConversationOperation | undefined;
  let managedProcesses: ManagedProcessController | undefined;
  try {
    assertSameOrigin(request);
    assertRequestSize(request);
    const body = await readJsonBody(request);
    const chatRequest = parseWebChatRequest(body);
    const checkpoint = await localConversationStore.load(chatRequest.conversationId);
    if (checkpoint.summary.revision !== chatRequest.revision) {
      throw new ConversationRepositoryError(
        "conflict",
        "会话已在其他页面更新，请刷新后重试。",
      );
    }
    const context = await loadWebProviderContext();
    const providerConfig = resolveWebProvider(context, checkpoint.summary.providerId);
    const workspaceCatalog = await loadWorkspaceCatalog();
    const workspace = await resolveWorkspaceBoundary(
      workspaceCatalog,
      checkpoint.summary.workspaceId,
    );
    const workspaceEntry = workspaceCatalog.entries.find(
      (entry) => entry.id === checkpoint.summary.workspaceId,
    );
    if (!workspaceEntry) {
      throw new WorkspaceCatalogError(
        "unknown-workspace",
        "选择的 Workspace 未经服务端授权。",
      );
    }
    const binding = {
      workspace: { id: workspaceEntry.id, name: workspaceEntry.name },
      providerId: checkpoint.summary.providerId,
    } as const;
    const conversationOperation = await conversationOperationGuard.begin(
      chatRequest.conversationId,
      "agent",
    );
    activeConversation = conversationOperation;
    const provider = createChatProvider(providerConfig);
    const contextManager = new ContextManager({
      sessionId: chatRequest.conversationId,
      config: providerConfig.context,
      store: localConversationStore,
      provider,
      initialState: checkpoint.context,
    });
    const readContext = (input: {
      readonly reference: string;
      readonly offset: number;
      readonly limit: number;
      readonly signal: AbortSignal;
    }) => localConversationStore.read({
      sessionId: chatRequest.conversationId,
      ...input,
    });
    managedProcesses = new ManagedProcessController(commandSandbox, workspace);
    const completionTracker = new CompletionTracker();
    const registry = createDefaultToolRegistry(
      commandSandbox,
      readContext,
      managedProcesses,
      completionTracker,
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
      provider,
      (mode) => createModeToolPolicy(registry, mode),
      workspace,
      {
        maxIterations: context.maxIterations,
        maxRuntimeMs: context.maxRuntimeMs,
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
        contextManager,
        completionTracker,
      },
    );
    await localConversationStore.markTurnStarted({
      conversationId: chatRequest.conversationId,
      expectedRevision: chatRequest.revision,
      userInput: chatRequest.input,
      mode: chatRequest.mode,
      modeTurn: chatRequest.modeTurn,
      ownerToken: conversationOperation.lease.ownerToken,
    });
    return streamAgentResponse({
      request,
      agent,
      input: chatRequest.input,
      mode: chatRequest.mode,
      modeTurn: chatRequest.modeTurn,
      operationSignal: conversationOperation.signal,
      persistTurn: async (events) => {
        const terminal = events.findLast(
          (event) => event.type === "stopped",
        );
        if (!terminal || terminal.type !== "stopped") {
          throw new Error("Agent 未返回可持久化的停止事件。");
        }
        const summary = checkpointSummaryForSave(checkpoint.summary);
        const saveInput = {
          conversationId: chatRequest.conversationId,
          expectedRevision: chatRequest.revision,
          checkpoint: {
            schemaVersion: checkpoint.schemaVersion,
            summary: {
              ...summary,
              title: checkpoint.displayMessages.length === 0 && checkpoint.summary.title === "新对话"
                ? deriveConversationTitle(chatRequest.input)
                : checkpoint.summary.title,
              lastStopReason: terminal.reason,
            },
            mode: chatRequest.mode,
            modeTurn: chatRequest.modeTurn,
            displayMessages: appendPersistedTurn({
              previous: checkpoint.displayMessages,
              userInput: chatRequest.input,
              events,
            }),
            context: contextManager.persistentSnapshot(),
          },
        } as const;
        conversationRuntimeManager.setPendingSave(saveInput);
        const result = await localConversationStore.save(saveInput);
        if (result.status === "conflict") {
          throw new Error("会话已在其他页面更新，本轮结果未覆盖磁盘记录。请刷新后重试。");
        }
        conversationRuntimeManager.clearPendingSave(chatRequest.conversationId);
        await localConversationStore.clearTurnMarker(
          chatRequest.conversationId,
          conversationOperation.lease.ownerToken,
        );
        return { status: "saved", revision: result.checkpoint.summary.revision };
      },
      runLog: {
        sink: localAgentRunLog,
        conversationId: chatRequest.conversationId,
        revisionBefore: chatRequest.revision,
        providerId: checkpoint.summary.providerId,
        workspaceId: checkpoint.summary.workspaceId,
      },
      onFinished: async () => {
        await managedProcesses?.close();
        finishPermissionTurn(activeTurn);
        await activeConversation?.finish().catch(() => undefined);
      },
    });
  } catch (error) {
    await managedProcesses?.close().catch(() => undefined);
    finishPermissionTurn(activeTurn);
    await activeConversation?.finish().catch(() => undefined);
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

function checkpointSummaryForSave(
  summary: ConversationSummary,
) {
  return {
    schemaVersion: summary.schemaVersion,
    id: summary.id,
    title: summary.title,
    createdAt: summary.createdAt,
    workspaceId: summary.workspaceId,
    providerId: summary.providerId,
    ...(summary.lastStopReason === undefined ? {} : { lastStopReason: summary.lastStopReason }),
  };
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
