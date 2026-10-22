import test from "node:test";
import assert from "node:assert/strict";
import { startTaskPolling } from "./task-polling";

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("任务轮询等待慢请求结束，手动刷新合并，空闲与活跃分别调度", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let complete!: (result: { active: boolean }) => void;
  const poller = startTaskPolling({
    load: () => { calls++; return new Promise(resolve => { complete = resolve; }); },
    isVisible: () => true, onVisibilityChange: () => () => undefined, onError: () => assert.fail("不应失败"),
  });
  assert.equal(calls, 1);
  t.mock.timers.tick(60_000);
  poller.refresh(); poller.refresh();
  assert.equal(calls, 1);
  complete({ active: false }); await flush();
  t.mock.timers.tick(0); assert.equal(calls, 2);
  complete({ active: false }); await flush();
  t.mock.timers.tick(14_999); assert.equal(calls, 2);
  t.mock.timers.tick(1); assert.equal(calls, 3);
  complete({ active: true }); await flush();
  t.mock.timers.tick(1_499); assert.equal(calls, 3);
  t.mock.timers.tick(1); assert.equal(calls, 4);
  poller.stop(); complete({ active: false }); await flush();
  t.mock.timers.tick(60_000); assert.equal(calls, 4);
});

test("隐藏页面取消在途读取，恢复可见后刷新，卸载清理监听器", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let visible = false, listener: () => void = () => undefined, unsubscribed = false, calls = 0;
  let currentSignal: AbortSignal | undefined;
  let complete!: (result: { active: boolean }) => void;
  const poller = startTaskPolling({
    load: signal => { calls++; currentSignal = signal; return new Promise(resolve => { complete = resolve; }); },
    isVisible: () => visible,
    onVisibilityChange: next => { listener = next; return () => { unsubscribed = true; }; },
    onError: () => assert.fail("取消不应显示错误"),
  });
  assert.equal(calls, 0);
  visible = true; listener(); assert.equal(calls, 1);
  visible = false; listener(); assert.equal(currentSignal?.aborted, true);
  complete({ active: true }); await flush(); t.mock.timers.tick(60_000); assert.equal(calls, 1);
  visible = true; listener(); assert.equal(calls, 2);
  poller.stop(); assert.equal(currentSignal?.aborted, true); assert.equal(unsubscribed, true);
  complete({ active: false }); await flush();
});
