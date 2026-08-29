import assert from "node:assert/strict";
import test from "node:test";

import type { PermissionApprovalRequest } from "@/core/permissions/approval";
import type { PermissionSubject } from "@/core/permissions/types";
import {
  PermissionSessionError,
  PermissionSessionManager,
  type PermissionSessionBinding,
} from "@/web/permission-session-manager";

const binding: PermissionSessionBinding = {
  workspace: { id: "project", name: "OrbitCode" },
  providerId: "openai-compatible",
};

const writeSubject: PermissionSubject = {
  kind: "path",
  toolName: "write_file",
  toolKind: "write",
  requestedPath: "src/new.ts",
  canonicalRelativePath: "src/new.ts",
};

test("创建、绑定并限制单一活动 Agent 轮次", () => {
  const harness = createHarness();
  const created = harness.manager.createSession();
  assert.equal(created.mode, "default");
  assert.equal(created.binding, undefined);

  const turn = harness.manager.beginTurn(created.id, binding);
  assert.equal(harness.manager.getSession(created.id).activeTurn, true);
  assert.throws(
    () => harness.manager.beginTurn(created.id, binding),
    hasKind("turn-active"),
  );
  assert.throws(
    () =>
      harness.manager.bindSession(created.id, {
        ...binding,
        workspace: { id: "other", name: "Other" },
      }),
    hasKind("binding-mismatch"),
  );

  harness.manager.finishTurn(created.id, turn.id);
  assert.equal(harness.manager.getSession(created.id).activeTurn, false);
  assert.equal(harness.manager.setMode(created.id, "strict").mode, "strict");
});

test("授权请求只解析一次且四种决定产生正确作用域", async () => {
  for (const [decision, expected] of [
    ["allow-once", { kind: "allowed", scope: "once" }],
    ["allow-session", { kind: "allowed", scope: "session" }],
    ["allow-permanent", { kind: "allowed", scope: "permanent" }],
    ["deny", { kind: "denied" }],
  ] as const) {
    const harness = createHarness();
    const session = harness.manager.createSession();
    const turn = harness.manager.beginTurn(session.id, binding);
    const handle = turn.broker.request(approvalRequest(), new AbortController().signal);
    assert.deepEqual(handle.prompt.workspace, binding.workspace);
    assert.equal(handle.prompt.toolName, "write_file");
    assert.equal(handle.prompt.persistentLayer, "local");

    assert.deepEqual(
      harness.manager.resolveDecision(session.id, handle.prompt.requestId, decision),
      expected,
    );
    assert.deepEqual(await handle.outcome, expected);
    assert.throws(
      () =>
        harness.manager.resolveDecision(
          session.id,
          handle.prompt.requestId,
          decision,
        ),
      hasKind("unknown-request"),
    );
  }
});

test("会话允许仅复用同 Workspace、工具与规范目标", async () => {
  const harness = createHarness();
  const session = harness.manager.createSession();
  const turn = harness.manager.beginTurn(session.id, binding);
  const first = turn.broker.request(
    approvalRequest(),
    new AbortController().signal,
  );
  harness.manager.resolveDecision(
    session.id,
    first.prompt.requestId,
    "allow-session",
  );
  await first.outcome;

  assert.equal(turn.broker.hasSessionGrant(writeSubject), true);
  assert.equal(
    turn.broker.hasSessionGrant({
      ...writeSubject,
      canonicalRelativePath: "src/other.ts",
    }),
    false,
  );
  assert.equal(
    turn.broker.hasSessionGrant({ ...writeSubject, toolName: "edit_file" }),
    false,
  );

  harness.manager.finishTurn(session.id, turn.id);
  const nextTurn = harness.manager.beginTurn(session.id, binding);
  assert.equal(nextTurn.broker.hasSessionGrant(writeSubject), true);
  harness.manager.closeSession(session.id);
  assert.throws(
    () => nextTurn.broker.hasSessionGrant(writeSubject),
    hasKind("unknown-session"),
  );
});

test("跨会话决定不影响原等待项", async () => {
  const harness = createHarness();
  const first = harness.manager.createSession();
  const second = harness.manager.createSession();
  const turn = harness.manager.beginTurn(first.id, binding);
  const handle = turn.broker.request(approvalRequest(), new AbortController().signal);

  assert.throws(
    () =>
      harness.manager.resolveDecision(
        second.id,
        handle.prompt.requestId,
        "allow-once",
      ),
    hasKind("unknown-request"),
  );
  assert.equal(harness.manager.getSession(first.id).pendingRequestId, handle.prompt.requestId);
  harness.manager.resolveDecision(first.id, handle.prompt.requestId, "deny");
  assert.deepEqual(await handle.outcome, { kind: "denied" });
});

test("AbortSignal、结束轮次和关闭会话取消等待并清理计时器", async () => {
  for (const action of ["abort", "finish", "close"] as const) {
    const harness = createHarness();
    const session = harness.manager.createSession();
    const turn = harness.manager.beginTurn(session.id, binding);
    const controller = new AbortController();
    const handle = turn.broker.request(approvalRequest(), controller.signal);

    if (action === "abort") controller.abort();
    if (action === "finish") harness.manager.finishTurn(session.id, turn.id);
    if (action === "close") harness.manager.closeSession(session.id);

    assert.deepEqual(await handle.outcome, { kind: "cancelled" });
    assert.equal(harness.clock.activeTimers("approval"), 0);
    if (action !== "close") {
      assert.throws(
        () =>
          harness.manager.resolveDecision(
            session.id,
            handle.prompt.requestId,
            "allow-once",
          ),
        hasKind("unknown-request"),
      );
    }
  }
});

test("等待 5 分钟过期，迟到决定无效", async () => {
  const harness = createHarness();
  const session = harness.manager.createSession();
  const turn = harness.manager.beginTurn(session.id, binding);
  const handle = turn.broker.request(approvalRequest(), new AbortController().signal);

  harness.clock.advance(5_000);
  assert.deepEqual(await handle.outcome, { kind: "expired" });
  assert.throws(
    () =>
      harness.manager.resolveDecision(
        session.id,
        handle.prompt.requestId,
        "allow-once",
      ),
    hasKind("unknown-request"),
  );
});

test("会话空闲 TTL 终止等待并清除会话授权", async () => {
  const harness = createHarness({ approvalTtlMs: 60_000, sessionIdleTtlMs: 3_000 });
  const session = harness.manager.createSession();
  const turn = harness.manager.beginTurn(session.id, binding);
  const handle = turn.broker.request(approvalRequest(), new AbortController().signal);

  harness.clock.advance(3_000);
  assert.deepEqual(await handle.outcome, { kind: "cancelled" });
  assert.throws(() => harness.manager.getSession(session.id), hasKind("unknown-session"));
  assert.equal(harness.clock.activeTimers(), 0);
});

test("预先取消的请求不注册等待项，也不残留监听器或计时器", async () => {
  const harness = createHarness();
  const session = harness.manager.createSession();
  const turn = harness.manager.beginTurn(session.id, binding);
  const controller = new AbortController();
  controller.abort();
  const before = harness.clock.activeTimers();
  const handle = turn.broker.request(approvalRequest(), controller.signal);

  assert.deepEqual(await handle.outcome, { kind: "cancelled" });
  assert.equal(harness.manager.getSession(session.id).pendingRequestId, undefined);
  assert.equal(harness.clock.activeTimers(), before);
});

function approvalRequest(): PermissionApprovalRequest {
  return {
    toolCallId: "call-1",
    subject: writeSubject,
    fingerprint: "sha256:verified-parameters",
    reason: {
      source: "mode",
      mode: "default",
      risk: "medium",
      message: "默认模式下写入操作需要确认。",
    },
    summary: { path: "src/new.ts", bytes: 12 },
  };
}

function hasKind(kind: PermissionSessionError["kind"]) {
  return (error: unknown) =>
    error instanceof PermissionSessionError && error.kind === kind;
}

function createHarness(
  options: { readonly approvalTtlMs?: number; readonly sessionIdleTtlMs?: number } = {},
) {
  let nextId = 0;
  const clock = new FakeClock();
  const manager = new PermissionSessionManager({
    now: () => clock.now,
    createId: () => `id-${++nextId}`,
    schedule: (callback, delayMs) => clock.schedule(callback, delayMs),
    cancelScheduled: (handle) => clock.cancel(handle),
    approvalTtlMs: options.approvalTtlMs ?? 5_000,
    sessionIdleTtlMs: options.sessionIdleTtlMs ?? 30_000,
  });
  return { manager, clock };
}

type FakeTimer = {
  readonly id: number;
  readonly callback: () => void;
  readonly dueAt: number;
  readonly kind: "approval" | "idle";
};

class FakeClock {
  now = 0;
  #nextId = 0;
  readonly #timers = new Map<number, FakeTimer>();

  schedule(callback: () => void, delayMs: number): FakeTimer {
    const timer: FakeTimer = {
      id: ++this.#nextId,
      callback,
      dueAt: this.now + delayMs,
      kind: delayMs <= 5_000 ? "approval" : "idle",
    };
    this.#timers.set(timer.id, timer);
    return timer;
  }

  cancel(handle: unknown): void {
    if (isFakeTimer(handle)) this.#timers.delete(handle.id);
  }

  activeTimers(kind?: FakeTimer["kind"]): number {
    return [...this.#timers.values()].filter(
      (timer) => kind === undefined || timer.kind === kind,
    ).length;
  }

  advance(delayMs: number): void {
    const target = this.now + delayMs;
    while (true) {
      const next = [...this.#timers.values()]
        .filter((timer) => timer.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt)[0];
      if (!next) break;
      this.now = next.dueAt;
      this.#timers.delete(next.id);
      next.callback();
    }
    this.now = target;
  }
}

function isFakeTimer(value: unknown): value is FakeTimer {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "number"
  );
}
