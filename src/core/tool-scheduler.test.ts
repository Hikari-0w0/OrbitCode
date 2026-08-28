import assert from "node:assert/strict";
import test from "node:test";

import {
  scheduleToolCalls,
  type ToolScheduleEvent,
} from "@/core/tool-scheduler";
import { createModeToolPolicy } from "@/tools/mode-policy";
import { defineTool, successfulToolResult, ToolRegistry } from "@/tools/registry";
import { integerSchema, objectSchema, stringSchema } from "@/tools/schema";
import type { ToolMutability, ToolName, WorkspaceBoundary } from "@/tools/types";
import { createWorkspaceBoundary } from "@/tools/workspace";

type Interval = {
  readonly label: string;
  readonly mutability: ToolMutability;
  readonly startedAt: number;
  endedAt?: number;
};

let workspace: WorkspaceBoundary | undefined;
test.before(async () => {
  workspace = await createWorkspaceBoundary(process.cwd());
});

test("连续只读调用并发，副作用调用串行且结果恢复原序", async () => {
  const intervals: Interval[] = [];
  const registry = registryWithIntervals(intervals);
  const events = await collect(scheduleToolCalls({
    calls: [
      call("r1", "read_file", 40),
      call("r2", "find_files", 10),
      call("w1", "write_file", 5),
      call("r3", "search_code", 30),
      call("r4", "read_file", 5),
      call("c1", "run_command", 5),
    ],
    access: createModeToolPolicy(registry, "do"),
    workspace: requireWorkspace(),
    signal: new AbortController().signal,
  }));

  const r1 = requireInterval(intervals, "r1");
  const r2 = requireInterval(intervals, "r2");
  const w1 = requireInterval(intervals, "w1");
  const r3 = requireInterval(intervals, "r3");
  const r4 = requireInterval(intervals, "r4");
  const c1 = requireInterval(intervals, "c1");
  assert.equal(overlaps(r1, r2), true);
  assert.equal(overlaps(r3, r4), true);
  for (const other of [r1, r2, r3, r4, c1]) {
    assert.equal(overlaps(w1, other), false);
  }
  for (const other of [r1, r2, r3, r4, w1]) {
    assert.equal(overlaps(c1, other), false);
  }

  const completed = events.at(-1);
  assert.equal(completed?.type, "batch-completed");
  if (completed?.type !== "batch-completed") return;
  assert.deepEqual(
    completed.orderedResults.map((result) => result.call.id),
    ["r1", "r2", "w1", "r3", "r4", "c1"],
  );
  assert.deepEqual(
    events.filter((event) => event.type === "result").map((event) => event.call.id),
    ["r2", "r1", "w1", "r4", "r3", "c1"],
  );
});

test("非法 JSON、未知和模式拒绝不启动底层工具", async () => {
  const intervals: Interval[] = [];
  const events = await collect(scheduleToolCalls({
    calls: [
      { id: "bad", name: "read_file", argumentsJson: "{" },
      { id: "unknown", name: "invented", argumentsJson: "{}" },
      call("denied", "write_file", 1),
    ],
    access: createModeToolPolicy(registryWithIntervals(intervals), "plan"),
    workspace: requireWorkspace(),
    signal: new AbortController().signal,
  }));

  assert.equal(events.some((event) => event.type === "started"), false);
  assert.deepEqual(
    events.filter((event) => event.type === "result").map((event) =>
      event.result.ok ? undefined : event.result.error.kind,
    ),
    ["invalid-arguments", "unknown-tool", "permission-denied"],
  );
  assert.equal(intervals.length, 0);
});

test("取消后等待当前工具收敛且不启动后续副作用调用", async () => {
  const intervals: Interval[] = [];
  const controller = new AbortController();
  const iterator = scheduleToolCalls({
    calls: [call("read", "read_file", 100), call("write", "write_file", 1)],
    access: createModeToolPolicy(registryWithIntervals(intervals), "do"),
    workspace: requireWorkspace(),
    signal: controller.signal,
  })[Symbol.asyncIterator]();

  const started = await iterator.next();
  assert.equal(started.value?.type, "started");
  controller.abort();
  const remaining: ToolScheduleEvent[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    remaining.push(next.value);
  }

  assert.equal(intervals.some((interval) => interval.label === "write"), false);
  assert.equal(remaining.at(-1)?.type, "batch-completed");
});

test("只读并发不超过八个且单个失败不影响同批收敛", async () => {
  let active = 0;
  let peak = 0;
  const registry = new ToolRegistry([
    defineTool({
      name: "read_file",
      description: "并发上限测试工具",
      inputSchema: objectSchema({
        label: stringSchema({ minLength: 1 }),
        delayMs: integerSchema({ minimum: 0, maximum: 1_000 }),
      }),
      mutability: "read-only",
      async execute(input, context) {
        active += 1;
        peak = Math.max(peak, active);
        try {
          await waitForDelay(input.delayMs, context.signal);
          if (input.label === "r3") throw new Error("测试失败");
          return successfulToolResult({ label: input.label });
        } finally {
          active -= 1;
        }
      },
    }),
  ]);
  const events = await collect(scheduleToolCalls({
    calls: Array.from({ length: 10 }, (_, index) =>
      call(`r${index}`, "read_file", 20),
    ),
    access: createModeToolPolicy(registry, "do"),
    workspace: requireWorkspace(),
    signal: new AbortController().signal,
  }));
  const results = events.filter((event) => event.type === "result");

  assert.equal(peak, 8);
  assert.equal(active, 0);
  assert.equal(results.length, 10);
  assert.equal(results.filter((event) => event.result.ok).length, 9);
  assert.equal(
    results.some(
      (event) => !event.result.ok && event.result.error.kind === "execution-failed",
    ),
    true,
  );
  const completed = events.at(-1);
  assert.equal(completed?.type, "batch-completed");
  if (completed?.type === "batch-completed") {
    assert.deepEqual(
      completed.orderedResults.map((result) => result.call.id),
      Array.from({ length: 10 }, (_, index) => `r${index}`),
    );
  }
});

function registryWithIntervals(intervals: Interval[]): ToolRegistry {
  return new ToolRegistry([
    intervalTool("read_file", "read-only", intervals),
    intervalTool("find_files", "read-only", intervals),
    intervalTool("search_code", "read-only", intervals),
    intervalTool("write_file", "workspace-write", intervals),
    intervalTool("run_command", "command", intervals),
  ]);
}

function intervalTool(
  name: ToolName,
  mutability: ToolMutability,
  intervals: Interval[],
) {
  return defineTool({
    name,
    description: "调度测试工具",
    inputSchema: objectSchema({
      label: stringSchema({ minLength: 1 }),
      delayMs: integerSchema({ minimum: 0, maximum: 1_000 }),
    }),
    mutability,
    async execute(input, context) {
      const interval: Interval = {
        label: input.label,
        mutability,
        startedAt: Date.now(),
      };
      intervals.push(interval);
      await waitForDelay(input.delayMs, context.signal);
      interval.endedAt = Date.now();
      return successfulToolResult(
        { label: input.label },
        mutability === "read-only" ? "none" : "applied",
      );
    },
  });
}

function call(id: string, name: ToolName, delayMs: number) {
  return {
    id,
    name,
    argumentsJson: JSON.stringify({ label: id, delayMs }),
  };
}

function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, delayMs);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

function requireWorkspace(): WorkspaceBoundary {
  if (!workspace) throw new Error("测试工作区尚未初始化。");
  return workspace;
}

function requireInterval(intervals: readonly Interval[], label: string): Interval {
  const interval = intervals.find((candidate) => candidate.label === label);
  if (!interval || interval.endedAt === undefined) {
    throw new Error(`缺少工具时间区间：${label}`);
  }
  return interval;
}

function overlaps(left: Interval, right: Interval): boolean {
  if (left.endedAt === undefined || right.endedAt === undefined) return false;
  return left.startedAt < right.endedAt && right.startedAt < left.endedAt;
}

async function collect<T>(source: AsyncIterable<T>): Promise<readonly T[]> {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}
