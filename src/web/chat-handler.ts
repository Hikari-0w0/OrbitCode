import type { AgentTurnEvent, SingleToolAgentSession } from "@/core/single-tool-agent";
import type { ToolName } from "@/tools/types";
import {
  encodeWebChatEvent,
  type WebChatEvent,
} from "@/web/chat-contract";

export function streamAgentResponse(options: {
  readonly request: Request;
  readonly agent: SingleToolAgentSession;
  readonly input: string;
}): Response {
  const abortController = new AbortController();
  let consumerClosed = false;
  const abort = (): void => {
    consumerClosed = true;
    abortController.abort();
  };
  options.request.signal.addEventListener("abort", abort, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of options.agent.streamTurn(
          options.input,
          abortController.signal,
        )) {
          if (consumerClosed) break;
          const webEvent = toWebEvent(event);
          if (webEvent) controller.enqueue(encodeWebChatEvent(webEvent));
        }
      } catch {
        if (!consumerClosed) {
          controller.enqueue(
            encodeWebChatEvent({
              type: "failed",
              message: "Agent 执行发生未知错误，请重试。",
              sideEffect: "none",
            }),
          );
        }
      } finally {
        options.request.signal.removeEventListener("abort", abort);
        if (!consumerClosed) controller.close();
      }
    },
    cancel() {
      abort();
      options.request.signal.removeEventListener("abort", abort);
    },
  });
  return new Response(stream, {
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

function toWebEvent(event: AgentTurnEvent): WebChatEvent | undefined {
  switch (event.type) {
    case "text-delta":
      return event;
    case "tool-started":
      return isToolName(event.name)
        ? { type: "tool-started", callId: event.callId, name: event.name }
        : undefined;
    case "tool-completed":
      return isToolName(event.name)
        ? {
            type: "tool-completed",
            callId: event.callId,
            name: event.name,
            result: event.result,
          }
        : undefined;
    case "completed":
      return { type: "completed", content: event.message.content };
    case "failed":
      return {
        type: "failed",
        message: event.error.message,
        sideEffect: event.sideEffect,
      };
    case "cancelled":
      return undefined;
  }
}

function isToolName(value: string): value is ToolName {
  return [
    "read_file",
    "write_file",
    "edit_file",
    "run_command",
    "find_files",
    "search_code",
  ].includes(value);
}
