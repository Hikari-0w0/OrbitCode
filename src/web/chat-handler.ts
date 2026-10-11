import { runAgentTurn, type PreparedAgentTurn } from "@/runtime/run-agent-turn";
import { encodeWebChatEvent } from "@/web/chat-contract";

export function streamAgentResponse(options: PreparedAgentTurn & { readonly request: Request }): Response {
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
          if (event.type === "initialization") controller.enqueue(encodeWebChatEvent(event.event));
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
