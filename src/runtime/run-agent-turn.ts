import type { RuntimeInitializationEvent, McpInitializationRecord } from "@/core/mcp-events";
import type { AgentEvent, AgentMode } from "@/core/agent-events";
import type { AgentSession } from "@/core/agent-loop";
import { AgentRunTracker, type RunLogOptions } from "@/runtime/agent-run-tracker";
import type { PersistenceState, RuntimeTurnEvent } from "@/runtime/types";

export type PreparedAgentTurn = {
  readonly agent?: AgentSession;
  readonly initialize?: (signal: AbortSignal, deadlineMs: number) => AsyncGenerator<RuntimeInitializationEvent, AgentSession | undefined>;
  readonly maxRuntimeMs?: number;
  readonly input: string;
  readonly mode: AgentMode;
  readonly modeTurn: number;
  readonly operationSignal?: AbortSignal;
  readonly onPersistedTurn?: () => void;
  readonly onFinished?: () => void | Promise<void>;
  readonly persistTurn?: (events: readonly AgentEvent[], initialization: readonly McpInitializationRecord[]) => Promise<PersistenceState>;
  readonly runLog?: RunLogOptions;
};

export async function* runAgentTurn(
  options: PreparedAgentTurn & { readonly signal: AbortSignal },
): AsyncIterable<RuntimeTurnEvent> {
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const deadlineMs = started + (options.maxRuntimeMs ?? 86_400_000);
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, deadlineMs - started);
  const initialization: McpInitializationRecord[] = [];
  let startupSideEffect = false;
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
      let agent = options.agent;
      if (options.initialize) {
        const generator = options.initialize(signal, deadlineMs);
        try {
          for (;;) {
            const next = await generator.next();
            if (next.done) { agent = next.value; break; }
            const event = next.value;
            if (event.type === "mcp-status") {
              const { type: _type, ...record } = event;
              void _type;
              const previous = initialization.findIndex((item) => item.serverName === record.serverName);
              if (previous < 0) initialization.push(record);
              else initialization[previous] = record;
              if (event.phase === "connecting") startupSideEffect = true;
            }
            yield { type: "initialization", event };
          }
        } finally { await generator.return(undefined); }
      }
      if (!agent || signal.aborted) throw new Error("运行初始化未完成。");
      for await (const event of agent.streamTurn({
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
    // 事件循环可能先处理完成微任务，再调度到期定时器；终结必须核对绝对时限。
    timedOut ||= Date.now() >= deadlineMs;
    const cancelled = signal.aborted;
    clearTimeout(timer);
    controller.abort();
    terminal ??= {
      type: "stopped", reason: timedOut ? "max-runtime" : cancelled ? "cancelled" : "agent-error",
      iterations: events.reduce((maximum, event) => "iteration" in event ? Math.max(maximum, event.iteration) : maximum, 0),
      durationMs: Date.now() - started,
      sideEffect: events.some((event) => event.type === "tool-result" && event.result.sideEffect === "applied")
        ? "applied" : events.some((event) => event.type === "tool-started") ? "possible" : "none",
      detail: timedOut ? "本轮已达到总运行时限。" : cancelled ? "本轮运行已取消。" : "Agent 执行发生未知错误，请重试。",
    };
    if (startupSideEffect && terminal.sideEffect === "none") terminal = { ...terminal, sideEffect: "possible" };
    if (timedOut) terminal = { ...terminal, reason: "max-runtime" };
    const terminalIndex = events.findIndex((event) => event.type === "stopped");
    if (terminalIndex >= 0) events[terminalIndex] = terminal; else events.push(terminal);
    tracker?.setInitialization(initialization);
    tracker?.observe(terminal);
    try {
      if (options.persistTurn) persistence = await options.persistTurn(events, initialization);
    } catch (error) {
      persistence = { status: "failed", detail: error instanceof Error && error.message ? error.message : "本轮未保存，请重试保存。" };
    }
    tracker?.setPersistence(options.persistTurn ? persistence : undefined);
    try { await options.onFinished?.(); }
    catch { warnings.push({ type: "warning", kind: "cleanup", detail: "部分运行资源清理失败。" }); }
    if (persistence.status === "saved" && terminal.reason === "final-response" && terminal.finalMessage?.content.trim()) {
      try { options.onPersistedTurn?.(); }
      catch { warnings.push({ type: "warning", kind: "memory", detail: "后台记忆任务未能安排，对话已保存。" }); }
    }
    try { await tracker?.finish(options.signal.aborted ? "cancelled" : "agent-error"); }
    catch { warnings.push({ type: "warning", kind: "run-log", detail: "运行记录写入失败。" }); }
  }
  for (const warning of warnings) yield warning;
  yield { type: "finished", stopped: terminal, persistence };
}
