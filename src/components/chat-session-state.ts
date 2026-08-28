import type { VisibleMessage, VisibleToolExecution } from "@/components/message-list";
import type { AgentMode } from "@/core/agent-events";
import type { PlainConversationMessage } from "@/models/provider";
import type { WebChatEvent } from "@/web/chat-contract";

type ProgressEvent = Extract<WebChatEvent, { type: "progress" }>;
type ToolCallEvent = Extract<WebChatEvent, { type: "tool-call" }>;
type ToolStartedEvent = Extract<WebChatEvent, { type: "tool-started" }>;
type ToolResultEvent = Extract<WebChatEvent, { type: "tool-result" }>;
type TokenUsageEvent = Extract<WebChatEvent, { type: "token-usage" }>;
type StoppedEvent = Extract<WebChatEvent, { type: "stopped" }>;

export type ChatSessionState = {
  readonly selectedWorkspaceId: string;
  readonly selectedProvider: string;
  readonly mode: AgentMode;
  readonly modeTurn: number;
  readonly messages: readonly VisibleMessage[];
  readonly history: readonly PlainConversationMessage[];
  readonly draft: string;
  readonly requestState: "idle" | "streaming" | "stopping";
  readonly executablePlanMessageId?: string;
  readonly notice?: string;
};

export type ChatSessionAction =
  | {
      readonly type: "catalogs-ready";
      readonly workspaceId: string;
      readonly provider: string;
    }
  | { readonly type: "workspace-selected"; readonly workspaceId: string }
  | { readonly type: "provider-selected"; readonly provider: string }
  | {
      readonly type: "mode-selected";
      readonly mode: AgentMode;
      readonly clearDraft?: boolean;
      readonly notice?: string;
    }
  | { readonly type: "conversation-cleared" }
  | { readonly type: "draft-changed"; readonly draft: string }
  | { readonly type: "notice-set"; readonly notice?: string }
  | {
      readonly type: "request-started";
      readonly mode: AgentMode;
      readonly modeTurn: number;
      readonly userId: string;
      readonly assistantId: string;
      readonly userMessage: PlainConversationMessage;
    }
  | { readonly type: "text-delta"; readonly assistantId: string; readonly text: string }
  | { readonly type: "progress"; readonly assistantId: string; readonly event: ProgressEvent }
  | { readonly type: "tool-call"; readonly assistantId: string; readonly event: ToolCallEvent }
  | { readonly type: "tool-started"; readonly assistantId: string; readonly event: ToolStartedEvent }
  | { readonly type: "tool-result"; readonly assistantId: string; readonly event: ToolResultEvent }
  | { readonly type: "token-usage"; readonly assistantId: string; readonly event: TokenUsageEvent }
  | {
      readonly type: "request-completed";
      readonly assistantId: string;
      readonly userMessage: PlainConversationMessage;
      readonly finalMessage: PlainConversationMessage;
      readonly mode: AgentMode;
    }
  | {
      readonly type: "request-stopped";
      readonly assistantId: string;
      readonly event: StoppedEvent;
    }
  | {
      readonly type: "request-transport-failed";
      readonly assistantId: string;
      readonly detail: string;
      readonly cancelled: boolean;
    }
  | { readonly type: "request-stopping" }
  | { readonly type: "request-settled" };

export const INITIAL_CHAT_SESSION_STATE: ChatSessionState = {
  selectedWorkspaceId: "",
  selectedProvider: "",
  mode: "do",
  modeTurn: 0,
  messages: [],
  history: [],
  draft: "",
  requestState: "idle",
};

export function chatSessionReducer(
  state: ChatSessionState,
  action: ChatSessionAction,
): ChatSessionState {
  if (action.type === "catalogs-ready") {
    return {
      ...state,
      selectedWorkspaceId: state.selectedWorkspaceId || action.workspaceId,
      selectedProvider: state.selectedProvider || action.provider,
    };
  }
  if (action.type === "workspace-selected") {
    if (
      state.requestState !== "idle" ||
      action.workspaceId === state.selectedWorkspaceId
    ) return state;
    return resetConversation(state, {
      selectedWorkspaceId: action.workspaceId,
    });
  }
  if (action.type === "provider-selected") {
    if (
      state.requestState !== "idle" ||
      action.provider === state.selectedProvider
    ) return state;
    return resetConversation(state, { selectedProvider: action.provider });
  }
  if (action.type === "mode-selected") {
    if (state.requestState !== "idle") return state;
    if (state.mode === action.mode && !action.clearDraft) return state;
    return {
      ...state,
      mode: action.mode,
      modeTurn: state.mode === action.mode ? state.modeTurn : 0,
      draft: action.clearDraft ? "" : state.draft,
      executablePlanMessageId: undefined,
      notice: action.notice,
    };
  }
  if (action.type === "conversation-cleared") {
    if (state.requestState !== "idle") return state;
    return resetConversation(state);
  }
  if (action.type === "draft-changed") {
    if (state.requestState !== "idle") return state;
    return { ...state, draft: action.draft };
  }
  if (action.type === "notice-set") {
    return { ...state, notice: action.notice };
  }
  if (action.type === "request-started") {
    if (state.requestState !== "idle") return state;
    return {
      ...state,
      mode: action.mode,
      modeTurn: action.modeTurn,
      draft: "",
      notice: undefined,
      requestState: "streaming",
      executablePlanMessageId: undefined,
      messages: [
        ...state.messages,
        {
          id: action.userId,
          role: "user",
          content: action.userMessage.content,
          state: "complete",
        },
        {
          id: action.assistantId,
          role: "assistant",
          content: "",
          state: "streaming",
          toolExecutions: [],
        },
      ],
    };
  }
  if (action.type === "text-delta") {
    return updateMessage(state, action.assistantId, (message) => ({
      ...message,
      content: `${message.content}${action.text}`,
    }));
  }
  if (action.type === "progress") {
    return updateMessage(state, action.assistantId, (message) => ({
      ...message,
      progress: action.event,
    }));
  }
  if (action.type === "tool-call") {
    return updateMessage(state, action.assistantId, (message) => ({
      ...message,
      toolExecutions: upsertToolExecution(message.toolExecutions ?? [], {
        iteration: action.event.iteration,
        sequence: action.event.sequence,
        callId: action.event.call.id,
        name: action.event.call.name,
        argumentsJson: action.event.call.argumentsJson,
        state: "queued",
      }),
    }));
  }
  if (action.type === "tool-started") {
    return updateMessage(state, action.assistantId, (message) => ({
      ...message,
      toolExecutions: updateToolState(
        message.toolExecutions ?? [],
        action.event.iteration,
        action.event.callId,
        "running",
      ),
    }));
  }
  if (action.type === "tool-result") {
    return updateMessage(state, action.assistantId, (message) => ({
      ...message,
      toolExecutions: applyToolResult(
        message.toolExecutions ?? [],
        action.event,
      ),
    }));
  }
  if (action.type === "token-usage") {
    return updateMessage(state, action.assistantId, (message) => ({
      ...message,
      usage: action.event.usage,
      cumulativeUsage: action.event.cumulative,
    }));
  }
  if (action.type === "request-completed") {
    const next = updateMessage(state, action.assistantId, (message) => ({
      ...message,
      content: action.finalMessage.content,
      state: "complete",
      stopReason: "final-response",
      progress: undefined,
    }));
    return {
      ...next,
      history: [...state.history, action.userMessage, action.finalMessage],
      executablePlanMessageId:
        action.mode === "plan" ? action.assistantId : undefined,
    };
  }
  if (action.type === "request-stopped") {
    const detail = stopDetail(action.event);
    const next = updateMessage(state, action.assistantId, (message) => ({
      ...message,
      state: action.event.reason === "cancelled" ? "cancelled" : "failed",
      detail,
      stopReason: action.event.reason,
      progress: undefined,
      toolExecutions: settleInterruptedTools(message.toolExecutions ?? []),
    }));
    return {
      ...next,
      executablePlanMessageId: undefined,
      notice: action.event.reason === "cancelled" ? undefined : detail,
    };
  }
  if (action.type === "request-transport-failed") {
    const next = updateMessage(state, action.assistantId, (message) => ({
      ...message,
      state: action.cancelled ? "cancelled" : "failed",
      detail: action.detail,
      progress: undefined,
      toolExecutions: settleInterruptedTools(message.toolExecutions ?? []),
    }));
    return {
      ...next,
      executablePlanMessageId: undefined,
      notice: action.cancelled ? undefined : action.detail,
    };
  }
  if (action.type === "request-stopping") {
    return state.requestState === "streaming"
      ? { ...state, requestState: "stopping" }
      : state;
  }
  return { ...state, requestState: "idle" };
}

function resetConversation(
  state: ChatSessionState,
  selections: Partial<
    Pick<ChatSessionState, "selectedWorkspaceId" | "selectedProvider">
  > = {},
): ChatSessionState {
  return {
    ...state,
    ...selections,
    mode: "do",
    modeTurn: 0,
    messages: [],
    history: [],
    draft: "",
    requestState: "idle",
    executablePlanMessageId: undefined,
    notice: undefined,
  };
}

function updateMessage(
  state: ChatSessionState,
  id: string,
  update: (message: VisibleMessage) => VisibleMessage,
): ChatSessionState {
  return {
    ...state,
    messages: state.messages.map((message) =>
      message.id === id ? update(message) : message,
    ),
  };
}

function upsertToolExecution(
  current: readonly VisibleToolExecution[],
  next: VisibleToolExecution,
): readonly VisibleToolExecution[] {
  const index = current.findIndex(
    (execution) =>
      execution.iteration === next.iteration && execution.callId === next.callId,
  );
  if (index < 0) return [...current, next];
  return current.map((execution, currentIndex) =>
    currentIndex === index ? next : execution,
  );
}

function updateToolState(
  current: readonly VisibleToolExecution[],
  iteration: number,
  callId: string,
  state: VisibleToolExecution["state"],
): readonly VisibleToolExecution[] {
  return current.map((execution) =>
    execution.iteration === iteration && execution.callId === callId
      ? { ...execution, state }
      : execution,
  );
}

function applyToolResult(
  current: readonly VisibleToolExecution[],
  event: ToolResultEvent,
): readonly VisibleToolExecution[] {
  const existing = current.find(
    (execution) =>
      execution.iteration === event.iteration && execution.callId === event.callId,
  );
  return upsertToolExecution(current, {
    iteration: event.iteration,
    sequence: event.sequence,
    callId: event.callId,
    name: event.name,
    argumentsJson: existing?.argumentsJson ?? "{}",
    state: toolExecutionState(event.result),
    result: event.result,
  });
}

function settleInterruptedTools(
  current: readonly VisibleToolExecution[],
): readonly VisibleToolExecution[] {
  return current.map((execution) => {
    if (execution.state === "running") return { ...execution, state: "cancelled" };
    if (execution.state === "queued") return { ...execution, state: "skipped" };
    return execution;
  });
}

function toolExecutionState(
  result: ToolResultEvent["result"],
): VisibleToolExecution["state"] {
  if (result.ok) return "succeeded";
  if (result.error.kind === "timeout") return "timed-out";
  if (result.error.kind === "cancelled") return "cancelled";
  return "failed";
}

function stopDetail(event: StoppedEvent): string {
  const base = event.detail ?? stopReasonLabel(event.reason);
  return event.sideEffect === "none"
    ? base
    : `${base} 工具可能已产生本地副作用，请检查工作目录。`;
}

function stopReasonLabel(reason: StoppedEvent["reason"]): string {
  if (reason === "final-response") return "任务已完成";
  if (reason === "max-iterations") return "已达到最大迭代次数";
  if (reason === "cancelled") return "用户已取消运行";
  if (reason === "repeated-unknown-tool") return "模型连续请求未知工具";
  if (reason === "model-error") return "模型响应流发生错误";
  return "Agent 内部发生错误";
}
