import test from "node:test";
import assert from "node:assert/strict";
import { ChildExecutionScheduler, type ExecutionOutcome } from "./scheduler";
import { BackgroundTaskManager } from "@/runtime/background-task-manager";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

for (const boundary of ["acquire", "queued", "start", "execute", "cleanup"] as const) {
  test(`在${boundary}边界同步关闭仍等待本次操作清理，关闭后不能启动执行`, { timeout: 1000 }, async () => {
    const scheduler = new ChildExecutionScheduler(1), cleanup = gate();
    let closed = false, cleanupCalls = 0, executions = 0;
    let closing: Promise<void> | undefined;
    const close = () => { closing = scheduler.close().then(() => { closed = true; }); };
    const operation = scheduler.run({
      signal: new AbortController().signal,
      acquire: boundary === "acquire" ? async () => { close(); } : undefined,
      onQueued: boundary === "queued" ? close : undefined,
      onStart: boundary === "start" ? close : undefined,
      execute: async () => { executions++; if (boundary === "execute") close(); return 42; },
      cleanup: async () => { cleanupCalls++; if (boundary === "cleanup") close(); await cleanup.promise; },
    });
    try {
      await flush();
      assert.ok(closing, "真实回调已触发关闭");
      assert.equal(closed, false, "关闭不能漏等触发它的操作");
      assert.equal(cleanupCalls, 1);
      assert.equal(executions, boundary === "execute" || boundary === "cleanup" ? 1 : 0);
      cleanup.release();
      await closing;
      const outcome = await operation;
      assert.equal(outcome.started, executions === 1);
      assert.equal(outcome.cleanup, "complete");
      assert.equal(closed, true);
    } finally { cleanup.release(); await scheduler.close(); }
  });
}

test("排队回调触发取消会清理资源，不留下永远等不到事件的请求", async () => {
  const scheduler = new ChildExecutionScheduler(1), controller = new AbortController();
  let executions = 0, cleaned = 0;
  const outcome = await scheduler.run({
    signal: controller.signal,
    onQueued: () => controller.abort(),
    execute: async () => { executions++; },
    cleanup: async () => { cleaned++; },
  });
  assert.equal(outcome.started, false);
  assert.equal(outcome.result.ok, false);
  assert.equal(executions, 0);
  assert.equal(cleaned, 1);
  await scheduler.close();
});

test("就绪回调内接纳新任务和调整并发不能使新任务越过当前任务", async () => {
  const scheduler = new ChildExecutionScheduler(1), order: number[] = [];
  const nested: Promise<unknown>[] = [];
  const first = scheduler.run({
    signal: new AbortController().signal,
    onQueued: () => {
      nested.push(scheduler.run({ signal: new AbortController().signal, execute: async () => { order.push(2); } }));
      scheduler.configure(2);
    },
    execute: async () => { order.push(1); },
  });
  try { await Promise.all([first, ...nested]); assert.deepEqual(order, [1, 2]); }
  finally { await scheduler.close(); }
});

test("开始回调失败不标记执行已启动，并让后续任务继续", async () => {
  const scheduler = new ChildExecutionScheduler(1);
  let calls = 0;
  try {
    const failed = await scheduler.run({ signal: new AbortController().signal, onStart: () => { throw new Error("投影失败"); }, execute: async () => { calls++; } });
    assert.equal(failed.started, false);
    assert.equal(failed.result.ok, false);
    const next = await scheduler.run({ signal: new AbortController().signal, execute: async () => { calls++; } });
    assert.equal(next.started, true);
    assert.equal(calls, 1);
  } finally { await scheduler.close(); }
});

test("任务管理器关闭会等待前台资源接纳回调触发的异步清理", async () => {
  const manager = new BackgroundTaskManager(), cleanup = gate();
  let closing: Promise<void> | undefined, closed = false, executed = 0, cleaned = 0;
  const operation = manager.withForeground(new AbortController().signal, async () => { executed++; }, {
    acquire: async () => { closing = manager.close().then(() => { closed = true; }); },
    close: async () => { cleaned++; await cleanup.promise; },
  });
  const rejected = assert.rejects(operation);
  try {
    await flush();
    assert.ok(closing);
    assert.equal(closed, false);
    assert.equal(cleaned, 1);
    assert.equal(executed, 0);
    cleanup.release();
    await Promise.all([closing, rejected]);
    assert.equal(closed, true);
  } finally { cleanup.release(); await manager.close(); }
});

test("取消广播中的重入关闭返回同一个回收屏障", async () => {
  const scheduler = new ChildExecutionScheduler(1), entered = gate(), cleanup = gate();
  let nested: Promise<void> | undefined;
  const operation = scheduler.run({
    signal: new AbortController().signal,
    execute: async signal => {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => { nested = scheduler.close(); resolve(); }, { once: true }));
      return "已知结果";
    },
    cleanup: async () => { entered.release(); await cleanup.promise; },
  });
  const closing = scheduler.close();
  try {
    assert.equal(nested, closing);
    assert.equal(scheduler.close(), closing);
    await entered.promise;
    cleanup.release();
    await closing;
    const outcome = await operation;
    assert.ok(outcome.result.ok && outcome.result.value === "已知结果");
  } finally { cleanup.release(); await closing; }
});

test("关闭后拒绝新执行，调用方仍可等待该次拒绝的资源清理", async () => {
  const scheduler = new ChildExecutionScheduler(1), cleanup = gate();
  const closing = scheduler.close(); await closing;
  let acquired = 0, executed = 0, cleaned = 0, settled = false;
  const operation = scheduler.run({
    signal: new AbortController().signal,
    acquire: async () => { acquired++; },
    execute: async () => { executed++; },
    cleanup: async () => { cleaned++; await cleanup.promise; },
  }).then(outcome => { settled = true; return outcome; });
  try {
    await flush();
    assert.equal(settled, false);
    assert.equal(scheduler.close(), closing);
    assert.equal(acquired, 0); assert.equal(executed, 0); assert.equal(cleaned, 1);
    cleanup.release();
    const outcome = await operation;
    assert.equal(outcome.result.ok, false); assert.equal(outcome.started, false);
  } finally { cleanup.release(); await operation; }
});

test("40个固定种子覆盖重入接纳、并发调整、取消和清理失败，FIFO与资源不变量保持", async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const scheduler = new ChildExecutionScheduler(3);
    let concurrency = 3, active = 0, shutdown = false;
    const ready: number[] = [], started: number[] = [], cleaned = new Set<number>();
    const operations: Promise<ExecutionOutcome<number>>[] = [], controllers: AbortController[] = [], violations: string[] = [];
    const submit = (id: number, nested = false) => {
      const controller = new AbortController(); controllers.push(controller);
      let held = false;
      operations.push(scheduler.run({
        signal: controller.signal,
        acquire: (seed + id) % 3 === 0 ? async signal => { await Promise.resolve(); signal.throwIfAborted(); } : undefined,
        onQueued: () => {
          ready.push(id);
          if (!nested && id % 10 === 0) submit(100 + id, true);
          if ((seed + id) % 7 === 0) { concurrency = 1 + ((seed + id) % 4); scheduler.configure(concurrency); }
          if ((seed + id) % 11 === 0) controller.abort();
        },
        onStart: () => { if ((seed + id) % 13 === 0) controller.abort(); },
        execute: async signal => {
          if (shutdown) violations.push(`id=${id} 关闭后启动`);
          if (active >= concurrency) violations.push(`id=${id} 超发`);
          started.push(id); held = true; active++;
          await Promise.resolve(); await Promise.resolve();
          signal.throwIfAborted();
          return id;
        },
        cleanup: async () => {
          if (cleaned.has(id)) violations.push(`id=${id} 重复清理`);
          cleaned.add(id); await Promise.resolve();
          if (held) active--;
          if ((seed + id) % 17 === 0) throw new Error("受控清理失败");
        },
      }));
    };
    for (let id = 0; id < 32; id++) submit(id);
    for (let i = seed % 5; i < controllers.length; i += 6) controllers[i].abort();
    await Promise.resolve();
    shutdown = true;
    const closing = scheduler.close();
    const results = await Promise.all(operations);
    await closing;
    assert.deepEqual(violations, [], `seed=${seed}`);
    assert.equal(active, 0, `seed=${seed}`);
    assert.equal(cleaned.size, operations.length, `seed=${seed}`);
    const startedIds = new Set(started);
    assert.deepEqual(started, ready.filter(id => startedIds.has(id)), `seed=${seed} FIFO逆序`);
    assert.equal(results.filter(result => result.started).length, started.length);
  }
});
