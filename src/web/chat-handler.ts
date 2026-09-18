import type { AgentEvent, AgentMode } from "@/core/agent-events";
import type { AgentSession } from "@/core/agent-loop";
import type { AgentRunLogSink } from "@/lib/local-agent-run-log";
import { runAgentTurn } from "@/runtime/run-agent-turn";
import { encodeWebChatEvent, type WebPersistenceState } from "@/web/chat-contract";

export function streamAgentResponse(options: {
  readonly request: Request;
  readonly agent: AgentSession;
  readonly input: string;
  readonly mode: AgentMode;
  readonly modeTurn: number;
  readonly operationSignal?: AbortSignal;
  readonly onFinished?: () => void | Promise<void>;
  readonly persistTurn?: (
    events: readonly AgentEvent[],
  ) => Promise<WebPersistenceState>;
  readonly runLog?: {
    readonly sink: AgentRunLogSink;
    readonly conversationId: string;
    readonly providerId: string;
    readonly workspaceId: string;
    readonly revisionBefore: number;
    readonly createRunId?: () => string;
    readonly now?: () => number;
  };
}): Response {
  const abortController = new AbortController();
  let closed = false;
  const abort = () => { closed = true; abortController.abort(); };
  options.request.signal.addEventListener("abort", abort, { once: true });
  options.operationSignal?.addEventListener("abort", abort, { once: true });
  if (options.request.signal.aborted || options.operationSignal?.aborted) abort();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const warnings: string[] = [];
      try {
        for await (const event of runAgentTurn({ ...options, signal: abortController.signal })) {
          if (closed) continue;
          if (event.type === "warning") warnings.push(event.detail);
          if (event.type === "agent") controller.enqueue(encodeWebChatEvent(event.event));
          if (event.type === "finished") controller.enqueue(encodeWebChatEvent({
            ...event.stopped,
            ...(warnings.length ? { detail: [event.stopped.detail, ...warnings].filter(Boolean).join(" ") } : {}),
            ...(options.persistTurn ? { persistence: event.persistence } : {}),
          }));
        }
      } finally {
        options.request.signal.removeEventListener("abort", abort);
        options.operationSignal?.removeEventListener("abort", abort);
        if (!closed) controller.close();
      }
    },
    cancel() { abort(); },
  });
  return new Response(stream, { headers: {
    "cache-control": "no-cache, no-transform", connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8", "x-accel-buffering": "no",
  } });
}
