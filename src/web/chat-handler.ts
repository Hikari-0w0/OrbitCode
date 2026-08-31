import { randomUUID } from "node:crypto";

import type { AgentEvent, AgentMode } from "@/core/agent-events";
import type { AgentSession } from "@/core/agent-loop";
import type {
  AgentRunLogEntry,
  AgentRunLogSink,
} from "@/lib/local-agent-run-log";
import { encodeWebChatEvent } from "@/web/chat-contract";
import type { WebPersistenceState } from "@/web/chat-contract";

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
  const startedAt = Date.now();
  const runTracker = options.runLog === undefined
    ? undefined
    : new AgentRunTracker({
        ...options.runLog,
        inputChars: options.input.length,
        mode: options.mode,
        modeTurn: options.modeTurn,
      });
  const abortController = new AbortController();
  let consumerClosed = false;
  const abort = (): void => {
    consumerClosed = true;
    abortController.abort();
  };
  options.request.signal.addEventListener("abort", abort, { once: true });
  options.operationSignal?.addEventListener("abort", abort, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let stopped = false;
      let terminal: Extract<AgentEvent, { type: "stopped" }> | undefined;
      const events: AgentEvent[] = [];
      let persistence: WebPersistenceState | undefined;
      try {
        for await (const event of options.agent.streamTurn({
          input: options.input,
          mode: options.mode,
          modeTurn: options.modeTurn,
          signal: abortController.signal,
        })) {
          if (stopped) {
            throw new Error("Agent 在停止事件后仍返回了数据。");
          }
          runTracker?.observe(event);
          events.push(event);
          if (event.type === "stopped") {
            stopped = true;
            terminal = event;
          } else if (!consumerClosed) {
            controller.enqueue(encodeWebChatEvent(event));
          }
        }
        if (terminal) {
          persistence = options.persistTurn === undefined
            ? undefined
            : await options.persistTurn(events).catch((error: unknown) => ({
                status: "failed" as const,
                detail: error instanceof Error && error.message.length > 0
                  ? error.message
                  : "本轮对话未能保存，请重试。",
              }));
          runTracker?.setPersistence(persistence);
          if (!consumerClosed) {
            controller.enqueue(encodeWebChatEvent({
              ...terminal,
              ...(persistence === undefined ? {} : { persistence }),
            }));
          }
        }
        if (!consumerClosed && !stopped) {
          controller.enqueue(encodeWebChatEvent(unexpectedStop(Date.now() - startedAt)));
        }
      } catch {
        if (!consumerClosed && !stopped) {
          controller.enqueue(encodeWebChatEvent(unexpectedStop(Date.now() - startedAt)));
        }
      } finally {
        await runTracker?.finish(
          abortController.signal.aborted ? "cancelled" : "agent-error",
        ).catch(() => undefined);
        options.request.signal.removeEventListener("abort", abort);
        options.operationSignal?.removeEventListener("abort", abort);
        await Promise.resolve(options.onFinished?.()).catch(() => undefined);
        if (!consumerClosed) controller.close();
      }
    },
    cancel() {
      abort();
      options.request.signal.removeEventListener("abort", abort);
      options.operationSignal?.removeEventListener("abort", abort);
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

type RunTrackerOptions = NonNullable<
  Parameters<typeof streamAgentResponse>[0]["runLog"]
> & {
  readonly inputChars: number;
  readonly mode: AgentMode;
  readonly modeTurn: number;
};

type MutableToolLog = AgentRunLogEntry["tools"][number] & {
  readonly callId: string;
};

type MutableModelAttemptLog = NonNullable<
  AgentRunLogEntry["modelAttempts"]
>[number];

class AgentRunTracker {
  readonly #startedAtMs: number;
  readonly #now: () => number;
  readonly #runId: string;
  readonly #tools = new Map<string, MutableToolLog>();
  readonly #modelAttempts = new Map<string, MutableModelAttemptLog>();
  #usage: AgentRunLogEntry["usage"] = { availability: "unavailable" };
  #terminal?: Extract<AgentEvent, { type: "stopped" }>;
  #iterations = 0;
  #firstModelOutputMs?: number;
  #outputChars = 0;
  #sideEffect: AgentRunLogEntry["sideEffect"] = "none";
  #finished = false;
  #persistence: AgentRunLogEntry["persistence"] = { status: "not-attempted" };

  constructor(private readonly options: RunTrackerOptions) {
    this.#now = options.now ?? Date.now;
    this.#startedAtMs = this.#now();
    this.#runId = (options.createRunId ?? randomUUID)();
  }

  observe(event: AgentEvent): void {
    if ("iteration" in event) {
      this.#iterations = Math.max(this.#iterations, event.iteration);
    }
    if (event.type === "progress" && event.model !== undefined) {
      const key = `${event.iteration}:${event.model.attempt}`;
      const previous = this.#modelAttempts.get(key);
      this.#modelAttempts.set(key, {
        iteration: event.iteration,
        attempt: event.model.attempt,
        stage: event.model.stage,
        elapsedMs: Math.max(previous?.elapsedMs ?? 0, event.model.elapsedMs),
        ...(event.model.traceId === undefined
          ? previous?.traceId === undefined ? {} : { traceId: previous.traceId }
          : { traceId: event.model.traceId }),
        ...(event.model.toolName === undefined
          ? previous?.toolName === undefined ? {} : { toolName: previous.toolName }
          : { toolName: event.model.toolName }),
        ...(event.model.toolArgumentsChars === undefined &&
          previous?.toolArgumentsChars === undefined
          ? {}
          : {
              toolArgumentsChars: Math.max(
                previous?.toolArgumentsChars ?? 0,
                event.model.toolArgumentsChars ?? 0,
              ),
            }),
      });
      return;
    }
    if (event.type === "tool-call") {
      this.#recordFirstModelOutput();
      this.#tools.set(event.call.id, {
        callId: event.call.id,
        name: event.call.name,
        status: "unfinished",
      });
      return;
    }
    if (event.type === "text-delta") {
      this.#recordFirstModelOutput();
      this.#outputChars += event.text.length;
      return;
    }
    if (event.type === "tool-started" && !this.#tools.has(event.callId)) {
      this.#tools.set(event.callId, {
        callId: event.callId,
        name: event.name,
        status: "unfinished",
      });
      return;
    }
    if (event.type === "tool-result") {
      this.#sideEffect = higherSideEffect(this.#sideEffect, event.result.sideEffect);
      this.#tools.set(event.callId, {
        callId: event.callId,
        name: event.name,
        status: toolLogStatus(event.result),
        durationMs: event.result.meta.durationMs,
        ...(!event.result.ok ? { errorKind: event.result.error.kind } : {}),
      });
      return;
    }
    if (event.type === "token-usage") {
      this.#usage = event.cumulative.availability === "reported"
        ? {
            availability: "reported",
            promptTokens: event.cumulative.promptTokens,
            completionTokens: event.cumulative.completionTokens,
            totalTokens: event.cumulative.totalTokens,
          }
        : { availability: "unavailable" };
      return;
    }
    if (event.type === "stopped") {
      this.#terminal = event;
      this.#iterations = event.iterations;
      this.#sideEffect = event.sideEffect;
    }
  }

  setPersistence(persistence: WebPersistenceState | undefined): void {
    if (persistence?.status === "saved") {
      this.#persistence = {
        status: "saved",
        revisionAfter: persistence.revision,
      };
      return;
    }
    if (persistence?.status === "failed") this.#persistence = { status: "failed" };
  }

  async finish(fallbackReason: "cancelled" | "agent-error"): Promise<void> {
    if (this.#finished) return;
    this.#finished = true;
    const finishedAtMs = this.#now();
    const terminal = this.#terminal;
    await this.options.sink.append({
      runId: this.#runId,
      source: "web",
      conversationId: this.options.conversationId,
      revisionBefore: this.options.revisionBefore,
      persistence: this.#persistence,
      providerId: this.options.providerId,
      workspaceId: this.options.workspaceId,
      mode: this.options.mode,
      modeTurn: this.options.modeTurn,
      startedAt: new Date(this.#startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: terminal?.durationMs ?? Math.max(
        0,
        Math.round(finishedAtMs - this.#startedAtMs),
      ),
      ...(this.#firstModelOutputMs === undefined
        ? {}
        : { firstModelOutputMs: this.#firstModelOutputMs }),
      stopReason: terminal?.reason ?? fallbackReason,
      iterations: terminal?.iterations ?? this.#iterations,
      sideEffect: terminal?.sideEffect ?? this.#sideEffect,
      inputChars: this.options.inputChars,
      outputChars: this.#outputChars,
      usage: this.#usage,
      ...(this.#modelAttempts.size === 0
        ? {}
        : { modelAttempts: [...this.#modelAttempts.values()] }),
      tools: [...this.#tools.values()].map((tool) => ({
        name: tool.name,
        status: tool.status,
        ...(tool.durationMs === undefined ? {} : { durationMs: tool.durationMs }),
        ...(tool.errorKind === undefined ? {} : { errorKind: tool.errorKind }),
      })),
    });
  }

  #recordFirstModelOutput(): void {
    if (this.#firstModelOutputMs !== undefined) return;
    this.#firstModelOutputMs = Math.max(
      0,
      Math.round(this.#now() - this.#startedAtMs),
    );
  }
}

function toolLogStatus(
  result: Extract<AgentEvent, { type: "tool-result" }>["result"],
): AgentRunLogEntry["tools"][number]["status"] {
  if (result.ok) return "succeeded";
  if (result.error.kind === "timeout") return "timed-out";
  if (result.error.kind === "cancelled") return "cancelled";
  return "failed";
}

function higherSideEffect(
  left: AgentRunLogEntry["sideEffect"],
  right: AgentRunLogEntry["sideEffect"],
): AgentRunLogEntry["sideEffect"] {
  const rank = { none: 0, possible: 1, applied: 2 } as const;
  return rank[right] > rank[left] ? right : left;
}

function unexpectedStop(durationMs: number): Extract<AgentEvent, { type: "stopped" }> {
  return {
    type: "stopped",
    reason: "agent-error",
    iterations: 0,
    durationMs: Math.max(0, Math.round(durationMs)),
    sideEffect: "none",
    detail: "Agent 执行发生未知错误，请重试。",
  };
}
