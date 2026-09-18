import type { AgentEvent, AgentMode } from "@/core/agent-events";
import type { AgentSession } from "@/core/agent-loop";
import { AgentRunTracker, type RunLogOptions } from "@/runtime/agent-run-tracker";
import type { PersistenceState, RuntimeTurnEvent } from "@/runtime/types";

export type PreparedAgentTurn = {
  readonly agent: AgentSession;
  readonly input: string;
  readonly mode: AgentMode;
  readonly modeTurn: number;
  readonly operationSignal?: AbortSignal;
  readonly onFinished?: () => void | Promise<void>;
  readonly persistTurn?: (events: readonly AgentEvent[]) => Promise<PersistenceState>;
  readonly runLog?: RunLogOptions;
};

export async function* runAgentTurn(
  options: PreparedAgentTurn & { readonly signal: AbortSignal },
): AsyncIterable<RuntimeTurnEvent> {
  const started = Date.now();
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal, options.signal,
    ...(options.operationSignal ? [options.operationSignal] : []),
  ]);
  const tracker = options.runLog ? new AgentRunTracker({
    ...options.runLog, inputChars: options.input.length,
    mode: options.mode, modeTurn: options.modeTurn,
  }) : undefined;
  const events: AgentEvent[] = [];
  let terminal: Extract<AgentEvent, { type: "stopped" }> | undefined;
  let persistence: PersistenceState = { status: "failed", detail: "本轮未保存。" };
  const warnings: Extract<RuntimeTurnEvent, { type: "warning" }>[] = [];
  try {
    try {
      for await (const event of options.agent.streamTurn({
        input: options.input, mode: options.mode, modeTurn: options.modeTurn, signal,
      })) {
        if (terminal) break;
        events.push(event);
        tracker?.observe(event);
        if (event.type === "stopped") terminal = event;
        else yield { type: "agent", event };
      }
    } catch {
      // 未知异常不暴露底层错误，已观察到的副作用仍必须保留。
    }
  } finally {
    const cancelled = signal.aborted;
    controller.abort();
    terminal ??= {
      type: "stopped", reason: cancelled ? "cancelled" : "agent-error",
      iterations: events.reduce((maximum, event) => "iteration" in event ? Math.max(maximum, event.iteration) : maximum, 0),
      durationMs: Date.now() - started,
      sideEffect: events.some((event) => event.type === "tool-result" && event.result.sideEffect === "applied")
        ? "applied" : events.some((event) => event.type === "tool-started") ? "possible" : "none",
      detail: "Agent 执行发生未知错误，请重试。",
    };
    if (!events.some((event) => event.type === "stopped")) events.push(terminal);
    tracker?.observe(terminal);
    try {
      if (options.persistTurn) persistence = await options.persistTurn(events);
    } catch (error) {
      persistence = { status: "failed", detail: error instanceof Error && error.message ? error.message : "本轮未保存，请重试保存。" };
    }
    tracker?.setPersistence(options.persistTurn ? persistence : undefined);
    try { await options.onFinished?.(); }
    catch { warnings.push({ type: "warning", kind: "cleanup", detail: "部分运行资源清理失败。" }); }
    try { await tracker?.finish(options.signal.aborted ? "cancelled" : "agent-error"); }
    catch { warnings.push({ type: "warning", kind: "run-log", detail: "运行记录写入失败。" }); }
  }
  for (const warning of warnings) yield warning;
  yield { type: "finished", stopped: terminal, persistence };
}
