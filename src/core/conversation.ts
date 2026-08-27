import {
  ConversationStateError,
  toRecoverableChatError,
  type RecoverableChatError,
} from "@/core/errors";
import {
  ProviderError,
  type AssistantMessage,
  type ChatProvider,
  type ConversationMessage,
} from "@/models/provider";

export type TurnEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "completed"; readonly message: AssistantMessage }
  | { readonly type: "failed"; readonly error: RecoverableChatError }
  | { readonly type: "cancelled" };

export interface ConversationSession {
  getHistory(): readonly ConversationMessage[];
  streamTurn(input: string, signal: AbortSignal): AsyncIterable<TurnEvent>;
}

export class InMemoryConversationSession implements ConversationSession {
  private history: ConversationMessage[] = [];
  private state: "idle" | "streaming" = "idle";

  constructor(private readonly provider: ChatProvider) {}

  getHistory(): readonly ConversationMessage[] {
    return this.history.map((message) => ({ ...message }));
  }

  async *streamTurn(
    input: string,
    signal: AbortSignal,
  ): AsyncIterable<TurnEvent> {
    if (this.state !== "idle") {
      throw new ConversationStateError("当前已有进行中的对话轮次。请等待其结束。");
    }

    if (input.trim().length === 0) {
      throw new ConversationStateError("对话输入不能为空。");
    }

    this.state = "streaming";
    const userMessage = { role: "user", content: input } as const;
    const requestMessages = [...this.history, userMessage];
    let assistantContent = "";
    let completed = false;

    try {
      for await (const event of this.provider.stream(requestMessages, { signal })) {
        if (signal.aborted) {
          throw new ProviderError("cancelled", "模型请求已取消。");
        }

        if (completed) {
          throw new ProviderError(
            "protocol",
            "模型在完成标记之后仍返回了数据。",
          );
        }

        if (event.type === "done") {
          completed = true;
          continue;
        }

        assistantContent += event.text;
        yield { type: "text-delta", text: event.text };
      }

      if (!completed) {
        throw new ProviderError("stream", "模型响应在完成标记前中断。");
      }

      const assistantMessage: AssistantMessage = {
        role: "assistant",
        content: assistantContent,
      };
      this.history = [...this.history, userMessage, assistantMessage];
      yield { type: "completed", message: { ...assistantMessage } };
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof ProviderError && error.kind === "cancelled")
      ) {
        yield { type: "cancelled" };
        return;
      }

      yield { type: "failed", error: toRecoverableChatError(error) };
    } finally {
      this.state = "idle";
    }
  }
}
