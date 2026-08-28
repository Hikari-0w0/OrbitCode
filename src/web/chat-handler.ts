import type { AgentEvent, AgentMode } from "@/core/agent-events";
import type { AgentSession } from "@/core/agent-loop";
import { encodeWebChatEvent } from "@/web/chat-contract";

export function streamAgentResponse(options: {
  readonly request: Request;
  readonly agent: AgentSession;
  readonly input: string;
  readonly mode: AgentMode;
  readonly modeTurn: number;
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
      let stopped = false;
      try {
        for await (const event of options.agent.streamTurn({
          input: options.input,
          mode: options.mode,
          modeTurn: options.modeTurn,
          signal: abortController.signal,
        })) {
          if (consumerClosed) break;
          if (stopped) {
            throw new Error("Agent 在停止事件后仍返回了数据。");
          }
          controller.enqueue(encodeWebChatEvent(event));
          if (event.type === "stopped") stopped = true;
        }
        if (!consumerClosed && !stopped) {
          controller.enqueue(encodeWebChatEvent(unexpectedStop()));
        }
      } catch {
        if (!consumerClosed && !stopped) {
          controller.enqueue(encodeWebChatEvent(unexpectedStop()));
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

function unexpectedStop(): Extract<AgentEvent, { type: "stopped" }> {
  return {
    type: "stopped",
    reason: "agent-error",
    iterations: 0,
    sideEffect: "none",
    detail: "Agent 执行发生未知错误，请重试。",
  };
}
