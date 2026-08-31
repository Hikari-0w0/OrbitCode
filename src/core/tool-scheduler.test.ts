import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  scheduleToolCalls,
  type ToolScheduleEvent,
} from "@/core/tool-scheduler";
import { createModeToolPolicy } from "@/tools/mode-policy";
import { PermissionGateway } from "@/tools/permission-gateway";
import { defineTool, successfulToolResult, ToolRegistry } from "@/tools/registry";
import { integerSchema, objectSchema, stringSchema } from "@/tools/schema";
import type { ToolMutability, ToolName, WorkspaceBoundary } from "@/tools/types";
import { createWorkspaceBoundary } from "@/tools/workspace";
import { writeFilesTool } from "@/tools/write-files";
import { PermissionSessionManager } from "@/web/permission-session-manager";

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
      permission: testSchedulerPermission(),
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

test("多个 ask 按 sequence 逐项等待，只有获准调用在 started 后执行", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(path.join(tmpdir(), "orbitcode-scheduler-permission-")),
  );
  const manager = new PermissionSessionManager();
  let executions = 0;
  try {
    const permissionWorkspace = await createWorkspaceBoundary(root);
    const registry = permissionWriteRegistry(() => executions++);
    const session = manager.createSession();
    const turn = manager.beginTurn(session.id, {
      workspace: { id: "test", name: "Test" },
      providerId: "test-provider",
    });
    const iterator = scheduleToolCalls({
      calls: [permissionCall("first", "first.txt"), permissionCall("second", "second.txt")],
      access: createModeToolPolicy(registry, "do"),
      workspace: permissionWorkspace,
      signal: new AbortController().signal,
      permissionGateway: new PermissionGateway({
        agentMode: "do",
        permissionMode: "default",
        workspace: permissionWorkspace,
        broker: turn.broker,
        loadRules: async () => [],
      }),
    })[Symbol.asyncIterator]();

    const firstRequest = await iterator.next();
    assert.equal(firstRequest.value?.type, "permission-requested");
    assert.equal(executions, 0);
    if (firstRequest.value?.type !== "permission-requested") return;
    manager.resolveDecision(
      session.id,
      firstRequest.value.prompt.requestId,
      "allow-once",
    );

    const middle: ToolScheduleEvent[] = [];
    let secondRequest: Extract<ToolScheduleEvent, { type: "permission-requested" }> | undefined;
    while (!secondRequest) {
      const next = await iterator.next();
      assert.equal(next.done, false);
      if (next.value?.type === "permission-requested") secondRequest = next.value;
      else if (next.value) middle.push(next.value);
    }
    assert.equal(executions, 1);
    assert.deepEqual(middle.map((event) => event.type), [
      "permission-resolved",
      "started",
      "result",
    ]);
    manager.resolveDecision(session.id, secondRequest.prompt.requestId, "deny");

    const remaining: ToolScheduleEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(next.value);
    }
    assert.equal(executions, 1);
    assert.deepEqual(remaining.map((event) => event.type), [
      "permission-resolved",
      "result",
      "batch-completed",
    ]);
    const denied = remaining.find((event) => event.type === "result");
    assert.equal(
      denied?.type === "result" && !denied.result.ok
        ? denied.result.error.kind
        : undefined,
      "user-denied",
    );
  } finally {
    await import("node:fs/promises").then(({ rm }) =>
      rm(root, { recursive: true, force: true }),
    );
  }
});

test("等待授权时取消不会发出 started 或执行工具", async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(path.join(tmpdir(), "orbitcode-scheduler-cancel-")),
  );
  const manager = new PermissionSessionManager();
  let executions = 0;
  try {
    const permissionWorkspace = await createWorkspaceBoundary(root);
    const registry = permissionWriteRegistry(() => executions++);
    const session = manager.createSession();
    const turn = manager.beginTurn(session.id, {
      workspace: { id: "test", name: "Test" },
      providerId: "test-provider",
    });
    const controller = new AbortController();
    const iterator = scheduleToolCalls({
      calls: [permissionCall("cancel", "cancel.txt")],
      access: createModeToolPolicy(registry, "do"),
      workspace: permissionWorkspace,
      signal: controller.signal,
      permissionGateway: new PermissionGateway({
        agentMode: "do",
        permissionMode: "default",
        workspace: permissionWorkspace,
        broker: turn.broker,
        loadRules: async () => [],
      }),
    })[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, "permission-requested");
    controller.abort();
    const remaining: ToolScheduleEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(next.value);
    }
    assert.equal(remaining.some((event) => event.type === "started"), false);
    assert.equal(executions, 0);
    assert.equal(
      remaining.some(
        (event) => event.type === "permission-resolved" && event.status === "cancelled",
      ),
      true,
    );
  } finally {
    await import("node:fs/promises").then(({ rm }) =>
      rm(root, { recursive: true, force: true }),
    );
  }
});

test("批量写入逐路径授权，任一目标拒绝时整批不执行", async () => {
  const { mkdtemp, rm, stat } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-scheduler-multi-target-"));
  const manager = new PermissionSessionManager();
  try {
    const permissionWorkspace = await createWorkspaceBoundary(root);
    const session = manager.createSession();
    const turn = manager.beginTurn(session.id, {
      workspace: { id: "test", name: "Test" },
      providerId: "test-provider",
    });
    const iterator = scheduleToolCalls({
      calls: [{
        id: "batch",
        name: "write_files",
        argumentsJson: JSON.stringify({
          files: [
            { path: "first.txt", content: "first" },
            { path: "second.txt", content: "second" },
          ],
        }),
      }],
      access: createModeToolPolicy(new ToolRegistry([writeFilesTool]), "do"),
      workspace: permissionWorkspace,
      signal: new AbortController().signal,
      permissionGateway: new PermissionGateway({
        agentMode: "do",
        permissionMode: "default",
        workspace: permissionWorkspace,
        broker: turn.broker,
        loadRules: async () => [],
      }),
    })[Symbol.asyncIterator]();

    const firstRequest = await iterator.next();
    assert.equal(firstRequest.value?.type, "permission-requested");
    if (firstRequest.value?.type !== "permission-requested") return;
    manager.resolveDecision(session.id, firstRequest.value.prompt.requestId, "allow-once");

    assert.equal((await iterator.next()).value?.type, "permission-resolved");
    const secondRequest = await iterator.next();
    assert.equal(secondRequest.value?.type, "permission-requested");
    if (secondRequest.value?.type !== "permission-requested") return;
    manager.resolveDecision(session.id, secondRequest.value.prompt.requestId, "deny");

    const remaining = await collect({
      [Symbol.asyncIterator]: () => iterator,
    });
    assert.equal(remaining.some((event) => event.type === "started"), false);
    assert.equal(
      remaining.some((event) =>
        event.type === "result" &&
        !event.result.ok &&
        event.result.error.kind === "user-denied"
      ),
      true,
    );
    await assert.rejects(stat(path.join(root, "first.txt")), /ENOENT/);
    await assert.rejects(stat(path.join(root, "second.txt")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
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

function permissionWriteRegistry(onExecute: () => void): ToolRegistry {
  return new ToolRegistry([
    defineTool({
      name: "write_file",
      description: "权限调度测试工具",
      inputSchema: objectSchema({ path: stringSchema({ minLength: 1 }) }),
      mutability: "workspace-write",
      permission: {
        targetKind: "path",
        resolve: (input) => ({
          kind: "path",
          requestedPath: input.path,
          resolution: "write-target",
        }),
      },
      async execute() {
        onExecute();
        return successfulToolResult({ written: true }, "applied");
      },
    }),
  ]);
}

function permissionCall(id: string, targetPath: string) {
  return {
    id,
    name: "write_file" as const,
    argumentsJson: JSON.stringify({ path: targetPath }),
  };
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
    permission: testSchedulerPermission(),
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

function testSchedulerPermission() {
  return {
    targetKind: "path" as const,
    resolve(input: { readonly label: string; readonly delayMs: number }) {
      return {
        kind: "path" as const,
        requestedPath: input.label,
        resolution: "existing-file" as const,
      };
    },
  };
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
