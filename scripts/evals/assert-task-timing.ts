import assert from "node:assert/strict";
import type { TaskView } from "@/core/sub-agents/types";
import { TASK_EXECUTION_PHASES } from "@/core/sub-agents/task-timing";

export function assertTaskTiming(task: TaskView): void {
  assert.equal(task.state.status, "terminal");
  assert.ok(task.timing, "当前运行时应提供阶段清单");
  const timing = task.timing;
  assert.equal(timing.clock, "monotonic-offset-ms"); assert.equal(timing.current, "terminal");
  assert.ok(timing.phases.length <= TASK_EXECUTION_PHASES.length);
  assert.equal(timing.phases[0]?.phase, "preparation-queue"); assert.equal(timing.phases.at(-1)?.phase, "finalization");
  let elapsed = 0, previous = -1;
  for (const phase of timing.phases) {
    assert.equal(phase.complete, true); assert.equal(phase.startedMs, elapsed);
    assert.ok(Number.isSafeInteger(phase.durationMs) && phase.durationMs >= 0);
    const rank = TASK_EXECUTION_PHASES.indexOf(phase.phase); assert.ok(rank > previous); previous = rank;
    elapsed += phase.durationMs;
  }
  assert.equal(timing.elapsedMs, elapsed);
  if (task.state.status === "terminal") assert.deepEqual(task.state.result.timing, timing);
  if (timing.stopRequested) {
    assert.ok(timing.stopRequested.offsetMs <= timing.elapsedMs);
    assert.equal(timing.stopLatencyMs, timing.elapsedMs - timing.stopRequested.offsetMs);
  }
  const delivery = task.deliveryTiming;
  if (delivery?.committedMs !== undefined) assert.equal(delivery.commitLatencyMs, delivery.committedMs - timing.elapsedMs);
}
