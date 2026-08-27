import {
  ConversationStateError,
  toRecoverableAgentError,
  type RecoverableAgentError,
} from "@/core/errors";
import {
  ProviderError,
  type AssistantMessage,
  type ChatProvider,
  type ConversationMessage,
  type ModelToolCall,
  type PlainConversationMessage,
} from "@/models/provider";
import { ToolRegistry } from "@/tools/registry";
import {
  toolFailure,
  type SideEffectState,
  type ToolExecutionResult,
  type WorkspaceBoundary,
} from "@/tools/types";

const FILE_TOOL_TIMEOUT_MS = 10_000;
const COMMAND_TOOL_TIMEOUT_MS = 120_000;

export type AgentTurnEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | {
      readonly type: "tool-started";
      readonly callId: string;
      readonly name: string;
    }
  | {
      readonly type: "tool-completed";
      readonly callId: string;
      readonly name: string;
      readonly result: ToolExecutionResult;
    }
  | { readonly type: "completed"; readonly message: AssistantMessage }
  | {
      readonly type: "failed";
      readonly error: RecoverableAgentError;
      readonly sideEffect: SideEffectState;
    }
  | { readonly type: "cancelled"; readonly sideEffect: SideEffectState };

export interface SingleToolAgentSession {
  getHistory(): readonly PlainConversationMessage[];
  streamTurn(input: string, signal: AbortSignal): AsyncIterable<AgentTurnEvent>;
}

export class SingleToolAgent implements SingleToolAgentSession {
  private history: PlainConversationMessage[];
  private state: "idle" | "running" = "idle";

  constructor(
    private readonly provider: ChatProvider,
    private readonly registry: ToolRegistry,
    private readonly workspace: WorkspaceBoundary,
    initialHistory: readonly PlainConversationMessage[] = [],
  ) {
    this.history = initialHistory.map((message) => ({ ...message }));
  }

  getHistory(): readonly PlainConversationMessage[] {
    return this.history.map((message) => ({ ...message }));
  }

  async *streamTurn(
    input: string,
    signal: AbortSignal,
  ): AsyncIterable<AgentTurnEvent> {
    if (this.state !== "idle") {
      throw new ConversationStateError("当前已有进行中的 Agent 轮次。");
    }
    if (input.trim().length === 0) throw new ConversationStateError("对话输入不能为空。");

    this.state = "running";
    const userMessage = { role: "user", content: input } as const;
    const requestMessages: ConversationMessage[] = [...this.history, userMessage];
    let sideEffect: SideEffectState = "none";
    try {
      const initial = this.collectModelResponse(
        requestMessages,
        { signal, tools: this.registry.definitions(), toolChoice: "auto" },
      );
      let directContent = "";
      let toolCall: ModelToolCall | undefined;
      let initialFinish: "stop" | "tool-call" | undefined;
      for await (const event of initial) {
        if (event.type === "text-delta") {
          directContent += event.text;
          yield event;
        } else if (event.type === "tool-call") {
          toolCall = event.call;
        } else {
          initialFinish = event.finishReason;
        }
      }
      assertNotAborted(signal);

      if (initialFinish === "stop" && toolCall === undefined) {
        if (directContent.trim().length === 0) {
          throw new ProviderError("protocol", "模型返回了空的最终文本。");
        }
        const assistantMessage: AssistantMessage = {
          role: "assistant",
          content: directContent,
        };
        this.history = [...this.history, userMessage, assistantMessage];
        yield { type: "completed", message: { ...assistantMessage } };
        return;
      }
      if (initialFinish !== "tool-call" || toolCall === undefined) {
        throw new ProviderError("protocol", "模型没有给出可执行的单个工具调用。");
      }

      yield { type: "tool-started", callId: toolCall.id, name: toolCall.name };
      const rawArguments = parseArguments(toolCall.argumentsJson);
      const result =
        rawArguments.ok
          ? await this.registry.execute(toolCall.name, rawArguments.value, {
              workspace: this.workspace,
              signal,
              deadlineMs:
                Date.now() +
                (toolCall.name === "run_command"
                  ? COMMAND_TOOL_TIMEOUT_MS
                  : FILE_TOOL_TIMEOUT_MS),
            })
          : rawArguments.result;
      sideEffect = higherSideEffect(sideEffect, result.sideEffect);
      yield {
        type: "tool-completed",
        callId: toolCall.id,
        name: toolCall.name,
        result,
      };
      if (signal.aborted || (!result.ok && result.error.kind === "cancelled")) {
        yield { type: "cancelled", sideEffect };
        return;
      }

      const internalMessages: ConversationMessage[] = [
        ...requestMessages,
        { role: "assistant", content: null, toolCalls: [toolCall] },
        {
          role: "tool",
          toolCallId: toolCall.id,
          content: JSON.stringify(result),
        },
      ];
      let finalContent = "";
      let finalFinish: "stop" | "tool-call" | undefined;
      for await (const event of this.collectModelResponse(internalMessages, {
        signal,
        toolChoice: "none",
      })) {
        if (event.type === "text-delta") {
          finalContent += event.text;
          yield event;
        } else if (event.type === "tool-call") {
          throw new ProviderError("protocol", "模型超过了每轮一次工具调用上限。");
        } else {
          finalFinish = event.finishReason;
        }
      }
      assertNotAborted(signal);
      if (finalFinish !== "stop" || finalContent.trim().length === 0) {
        throw new ProviderError("protocol", "模型没有返回完整的最终文本。");
      }
      const assistantMessage: AssistantMessage = {
        role: "assistant",
        content: finalContent,
      };
      this.history = [...this.history, userMessage, assistantMessage];
      yield { type: "completed", message: { ...assistantMessage } };
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof ProviderError && error.kind === "cancelled")
      ) {
        yield { type: "cancelled", sideEffect };
        return;
      }
      yield {
        type: "failed",
        error: toRecoverableAgentError(error),
        sideEffect,
      };
    } finally {
      this.state = "idle";
    }
  }

  private async *collectModelResponse(
    messages: readonly ConversationMessage[],
    options: Parameters<ChatProvider["stream"]>[1],
  ) {
    let completed = false;
    for await (const event of this.provider.stream(messages, options)) {
      if (completed) {
        throw new ProviderError("protocol", "模型在完成事件后仍返回了数据。");
      }
      if (event.type === "done") completed = true;
      yield event;
    }
    if (!completed) throw new ProviderError("stream", "模型响应在完成事件前中断。");
  }
}

function parseArguments(
  source: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly result: ToolExecutionResult } {
  try {
    return { ok: true, value: JSON.parse(source) as unknown };
  } catch {
    return {
      ok: false,
      result: toolFailure("invalid-arguments", "工具参数不是有效 JSON。", {
        retryable: true,
      }),
    };
  }
}

function higherSideEffect(
  left: SideEffectState,
  right: SideEffectState,
): SideEffectState {
  const rank: Readonly<Record<SideEffectState, number>> = {
    none: 0,
    possible: 1,
    applied: 2,
  };
  return rank[right] > rank[left] ? right : left;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ProviderError("cancelled", "Agent 轮次已取消。");
}
