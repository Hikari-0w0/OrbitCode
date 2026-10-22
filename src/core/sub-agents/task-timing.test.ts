import test from "node:test";
import assert from "node:assert/strict";
import { TaskPhaseTimeline } from "./task-timing";

test("阶段时长分区不重叠，活跃阶段实时增长，终态不再随查询变化", () => {
  let now = 100;
  const timeline = new TaskPhaseTimeline(() => now);
  now = 110; timeline.enter("preparation"); now = 125; timeline.enter("execution-queue");
  now = 130; timeline.enter("execution"); now = 150;
  const active = timeline.snapshot(); assert.equal(active.current, "execution"); assert.equal(active.elapsedMs, 50);
  assert.equal(active.phases.at(-1)?.complete, false);
  now = 160; timeline.enter("cleanup"); now = 165; timeline.enter("finalization"); now = 168; timeline.finish();
  const finished = timeline.snapshot(); assert.equal(finished.current, "terminal"); assert.equal(finished.elapsedMs, 68);
  assert.equal(finished.phases.reduce((sum, phase) => sum + phase.durationMs, 0), 68);
  assert.ok(finished.phases.every(phase => phase.complete)); assert.ok(!finished.phases.some(phase => phase.phase === "resource-wait"));
  now = 500; timeline.finish(); timeline.enter("execution"); assert.deepEqual(timeline.snapshot(), finished);
});

test("首个停止来源及发生阶段稳定，停止到回收的延迟包含剩余执行和清理", () => {
  let now = 0; const timeline = new TaskPhaseTimeline(() => now);
  timeline.enter("preparation"); now = 3; timeline.enter("resource-wait"); now = 13; timeline.requestStop("cancelled");
  now = 20; timeline.requestStop("runtime-closed"); timeline.enter("cleanup"); now = 30; timeline.enter("finalization"); now = 33; timeline.finish();
  const snapshot = timeline.snapshot(); assert.deepEqual(snapshot.stopRequested, { reason: "cancelled", phase: "resource-wait", offsetMs: 13 });
  assert.equal(snapshot.stopLatencyMs, 20); timeline.requestStop("max-runtime"); assert.deepEqual(timeline.snapshot(), snapshot);
});

test("投递重试和确认耗时独立于执行终态，失效也不改写已完成耗时", () => {
  let now = 0; const timeline = new TaskPhaseTimeline(() => now);
  now = 10; timeline.enter("cleanup"); now = 15; timeline.enter("finalization"); now = 20; timeline.finish();
  const execution = timeline.snapshot(); now = 30; timeline.recordDelivery("staged"); now = 45; timeline.recordDelivery("staged");
  now = 60; timeline.recordDelivery("committed"); now = 80; timeline.recordDelivery("committed");
  assert.deepEqual(timeline.deliverySnapshot(), { stagedCount: 2, firstStagedMs: 30, lastStagedMs: 45, committedMs: 60, commitLatencyMs: 40 });
  now = 90; timeline.recordDelivery("invalidated"); assert.equal(timeline.deliverySnapshot()?.invalidatedMs, 90);
  assert.deepEqual(timeline.snapshot(), execution);
});

test("时钟异常不会产生负耗时或改写既有偏移，阶段回退明确拒绝", () => {
  let now = 100; const timeline = new TaskPhaseTimeline(() => now);
  now = 120; timeline.enter("preparation"); now = 105; assert.equal(timeline.snapshot().elapsedMs, 20);
  now = NaN; timeline.enter("cleanup"); now = 130; timeline.enter("finalization"); timeline.finish();
  assert.ok(timeline.snapshot().phases.every(phase => phase.durationMs >= 0));
  let liveClock = 0; const live = new TaskPhaseTimeline(() => liveClock);
  liveClock = 1; live.enter("execution"); assert.throws(() => live.enter("preparation"), /不能回退/);
});
