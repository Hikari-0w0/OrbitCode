import test from "node:test";
import assert from "node:assert/strict";
import { BackgroundTaskManager } from "./background-task-manager";
import { DEFAULT_SUB_AGENT_LIMITS, type ChildExecutionResult } from "@/core/sub-agents/types";
import { testTaskSpecification } from "../../tests/helpers/task-admission";
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function until(check: () => boolean) { for (let index = 0; index < 100; index++) { if (check()) return; await new Promise<void>(resolve => setImmediate(resolve)); } throw new Error("阶段未按门闩推进"); }
const scope = { conversationId: "parent", lifecycleEpoch: "epoch" };
const result = (taskId: string): ChildExecutionResult => ({ taskId, stopReason: "final-response", failures: [], sideEffect: "none", verification: { status: "unverified", checks: [], blockers: [] }, usage: { scope: "self", categories: [] }, cleanup: "complete", truncated: false, evidenceRunId: taskId });

test("准备队列中的取消记录真实等待阶段，不把未启动的准备算作初始化耗时", async () => {
  let clock = 0, preparations = 0;
  const manager = new BackgroundTaskManager({ ...DEFAULT_SUB_AGENT_LIMITS, concurrency: 1 }, Date.now, () => clock), preparation = gate();
  const start = (callId: string) => manager.start({ scope, turnId: "queued-preparation", callId, specification: testTaskSpecification({ kind: "fork", prompt: "排队准备", background: true }, 2, 5000), signal: new AbortController().signal,
    prepare: async contract => { preparations++; await preparation.promise; return { run: async () => result(contract.taskId), close: async () => {} }; } });
  try {
    await start("first"); const queued = await start("second"); assert.equal(queued.timing?.current, "preparation-queue");
    clock = 10; const stopped = await manager.cancel(scope, queued.id);
    assert.equal(preparations, 1); assert.equal(stopped.timing?.stopRequested?.phase, "preparation-queue");
    assert.deepEqual(stopped.timing?.phases.map(phase => [phase.phase, phase.durationMs]), [["preparation-queue", 10], ["cleanup", 0], ["finalization", 0]]);
  } finally { preparation.release(); await manager.close(); }
});

test("实际管理器分离资源/执行排队，清理与投递可测，活动截断不丢阶段证据", async () => {
  let clock = 0, acquiring = false, running = false, closing = false;
  const manager = new BackgroundTaskManager({ ...DEFAULT_SUB_AGENT_LIMITS, concurrency: 1 }, Date.now, () => clock);
  const preparation = gate(), resource = gate(), execution = gate(), cleanup = gate(), occupied = gate();
  const foreground = manager.withForeground(new AbortController().signal, () => occupied.promise);
  try {
    const task = await manager.start({ scope, turnId: "turn", callId: "call", specification: testTaskSpecification({ kind: "fork", prompt: "隔离计时", background: true }, 2, 5000), signal: new AbortController().signal,
      prepare: async contract => { await preparation.promise; return {
        acquire: async () => { acquiring = true; await resource.promise; },
        run: async () => { running = true; await execution.promise; return result(contract.taskId); },
        close: async () => { closing = true; await cleanup.promise; },
      }; } });
    clock = 10; preparation.release(); await until(() => acquiring);
    assert.equal(manager.get(scope, task.id).timing?.current, "resource-wait");
    clock = 30; resource.release(); await until(() => manager.get(scope, task.id).state.status === "queued");
    clock = 45; occupied.release(); await foreground; await until(() => running);
    clock = 80; execution.release(); await until(() => closing); assert.equal(manager.get(scope, task.id).timing?.current, "cleanup");
    clock = 95; cleanup.release(); const done = await manager.wait(scope, task.id, 1000, new AbortController().signal);
    assert.deepEqual(done.task.timing?.phases.map(phase => [phase.phase, phase.durationMs]), [["preparation-queue", 0], ["preparation", 10], ["resource-wait", 20], ["execution-queue", 15], ["execution", 35], ["cleanup", 15], ["finalization", 0]]);
    assert.ok(done.task.state.status === "terminal"); assert.deepEqual(done.task.state.result.timing, done.task.timing);
    clock = 110; manager.stage(scope, task.id, "unsaved"); clock = 125; manager.stage(scope, task.id, "retry"); clock = 160; manager.commit(scope, task.id, 7);
    for (let index = 0; index < 40; index++) await manager.wait(scope, task.id, 1000, new AbortController().signal);
    const observed = manager.get(scope, task.id); assert.ok((observed.activityOmitted ?? 0) > 0); assert.deepEqual(observed.timing, done.task.timing);
    assert.deepEqual(observed.deliveryTiming, { stagedCount: 2, firstStagedMs: 110, lastStagedMs: 125, committedMs: 160, commitLatencyMs: 65 });
  } finally { preparation.release(); resource.release(); execution.release(); cleanup.release(); occupied.release(); await foreground; await manager.close(); }
});

test("资源等待取消后仍等接纳和清理，首个停止阶段与失败回收延迟准确", async () => {
  let clock = 0, acquiring = false, closing = false, runs = 0, closes = 0;
  const manager = new BackgroundTaskManager(DEFAULT_SUB_AGENT_LIMITS, Date.now, () => clock), resource = gate(), cleanup = gate();
  try {
    const task = await manager.start({ scope, turnId: "stop", callId: "call", specification: testTaskSpecification({ kind: "fork", prompt: "取消等待", background: true }, 2, 5000), signal: new AbortController().signal,
      prepare: async contract => ({ acquire: async () => { acquiring = true; await resource.promise; }, run: async () => { runs++; return result(contract.taskId); }, close: async () => { closes++; closing = true; await cleanup.promise; throw new Error("清理失败"); } }) });
    await until(() => acquiring); clock = 20; const cancelled = manager.cancel(scope, task.id), closed = manager.close();
    assert.equal(manager.get(scope, task.id).timing?.stopRequested?.phase, "resource-wait"); assert.equal(closes, 0);
    clock = 35; resource.release(); await until(() => closing); clock = 45; cleanup.release(); const done = await cancelled; await closed;
    assert.equal(runs, 0); assert.equal(closes, 1); assert.equal(done.timing?.stopLatencyMs, 25);
    assert.deepEqual(done.timing?.stopRequested, { reason: "cancelled", phase: "resource-wait", offsetMs: 20 });
    assert.ok(done.state.status === "terminal" && done.state.result.cleanup === "failed" && done.state.result.terminationSource === "user");
    assert.ok(!done.timing?.phases.some(phase => phase.phase === "execution"));
  } finally { resource.release(); cleanup.release(); await manager.close(); }
});
