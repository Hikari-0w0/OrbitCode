import type { TaskStopRequestReason } from "./types";

export const TASK_EXECUTION_PHASES = ["preparation-queue", "preparation", "resource-wait", "execution-queue", "execution", "cleanup", "finalization"] as const;
export type TaskExecutionPhase = typeof TASK_EXECUTION_PHASES[number];
export type TaskExecutionTiming = {
  readonly clock: "monotonic-offset-ms";
  readonly current: TaskExecutionPhase | "terminal";
  readonly elapsedMs: number;
  readonly phases: readonly { readonly phase: TaskExecutionPhase; readonly startedMs: number; readonly durationMs: number; readonly complete: boolean }[];
  readonly stopRequested?: { readonly reason: TaskStopRequestReason; readonly phase: TaskExecutionPhase; readonly offsetMs: number };
  readonly stopLatencyMs?: number;
};
export type TaskDeliveryTiming = {
  readonly stagedCount: number;
  readonly firstStagedMs?: number;
  readonly lastStagedMs?: number;
  readonly committedMs?: number;
  readonly commitLatencyMs?: number;
  readonly invalidatedMs?: number;
};
type PhasePeriod = { phase: TaskExecutionPhase; start: number; end?: number };

// 被动记录生命周期边界，不发停止信号、不执行资源清理，也不依赖可被截断的活动列表。
export class TaskPhaseTimeline {
  private readonly origin: number;
  private lastOffset = 0;
  private readonly periods: PhasePeriod[] = [{ phase: "preparation-queue", start: 0 }];
  private terminalMs?: number;
  private stop?: TaskExecutionTiming["stopRequested"];
  private delivery?: TaskDeliveryTiming;

  constructor(private readonly now: () => number) { this.origin = now(); }

  enter(phase: TaskExecutionPhase): void {
    if (this.terminalMs !== undefined) return;
    const current = this.periods[this.periods.length - 1];
    if (current.phase === phase) return;
    if (TASK_EXECUTION_PHASES.indexOf(phase) <= TASK_EXECUTION_PHASES.indexOf(current.phase)) throw new Error("子任务阶段不能回退。");
    const offset = this.offset(); current.end = offset;
    this.periods.push({ phase, start: offset });
  }

  requestStop(reason: NonNullable<TaskExecutionTiming["stopRequested"]>["reason"]): void {
    if (this.terminalMs !== undefined || this.stop) return;
    this.stop = { reason, phase: this.periods[this.periods.length - 1].phase, offsetMs: this.offset() };
  }

  finish(): void {
    if (this.terminalMs !== undefined) return;
    this.terminalMs = this.offset(); this.periods[this.periods.length - 1].end = this.terminalMs;
  }

  snapshot(): TaskExecutionTiming {
    const elapsedMs = this.terminalMs ?? this.offset();
    return { clock: "monotonic-offset-ms", current: this.terminalMs === undefined ? this.periods[this.periods.length - 1].phase : "terminal", elapsedMs,
      phases: this.periods.map(period => ({ phase: period.phase, startedMs: period.start, durationMs: (period.end ?? elapsedMs) - period.start, complete: period.end !== undefined })),
      ...(this.stop ? { stopRequested: { ...this.stop } } : {}),
      ...(this.stop && this.terminalMs !== undefined ? { stopLatencyMs: this.terminalMs - this.stop.offsetMs } : {}) };
  }

  recordDelivery(event: "staged" | "committed" | "invalidated"): void {
    const previous = this.delivery ?? { stagedCount: 0 }, offset = this.offset();
    if (event === "staged") this.delivery = { ...previous, stagedCount: previous.stagedCount + 1, firstStagedMs: previous.firstStagedMs ?? offset, lastStagedMs: offset };
    else if (event === "committed") this.delivery = { ...previous, committedMs: previous.committedMs ?? offset,
      ...(this.terminalMs !== undefined ? { commitLatencyMs: previous.commitLatencyMs ?? offset - this.terminalMs } : {}) };
    else this.delivery = { ...previous, invalidatedMs: previous.invalidatedMs ?? offset };
  }

  deliverySnapshot(): TaskDeliveryTiming | undefined { return this.delivery ? { ...this.delivery } : undefined; }

  private offset(): number {
    const value = Math.floor(this.now() - this.origin);
    if (Number.isFinite(value)) this.lastOffset = Math.max(this.lastOffset, value);
    return this.lastOffset;
  }
}
