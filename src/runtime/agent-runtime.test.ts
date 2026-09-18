import assert from "node:assert/strict";
import test from "node:test";
import { runAgentTurn } from "@/runtime/run-agent-turn";
import type { AgentEvent } from "@/core/agent-events";

test("消费者提前关闭仍执行保存和清理，保留可能副作用", async () => {
  let saved: readonly AgentEvent[] = [];
  let closed = false;
  const stream = runAgentTurn({
    agent: { getHistory: () => [], async *streamTurn() {
      yield { type: "tool-started", iteration: 1, callId: "c", name: "run_command", sequence: 0 };
      yield { type: "text-delta", iteration: 1, text: "等待" };
    } }, input: "任务", mode: "do", modeTurn: 1, signal: new AbortController().signal,
    persistTurn: async (events) => { saved = events; return { status: "saved", revision: 1 }; },
    onFinished() { closed = true; },
  });
  for await (const event of stream) { assert.equal(event.type, "agent"); break; }
  assert.equal(closed, true);
  const terminal = saved.at(-1);
  assert.equal(terminal?.type, "stopped");
  assert.ok(terminal?.type === "stopped"); assert.equal(terminal.sideEffect, "possible");
});

test("清理和日志失败不丢失唯一终止结果", async () => {
  const events = [];
  for await (const event of runAgentTurn({
    agent: { getHistory: () => [], async *streamTurn() {
      yield { type: "stopped", reason: "final-response", iterations: 1, durationMs: 1, sideEffect: "none" };
    } }, input: "任务", mode: "do", modeTurn: 1, signal: new AbortController().signal,
    onFinished() { throw new Error("cleanup"); },
    persistTurn: async () => ({ status: "saved", revision: 1 }),
    runLog: { sink: { async append() { throw new Error("disk"); } }, source: "cli", conversationId: "id", providerId: "p", workspaceId: "w", revisionBefore: 0 },
  })) events.push(event);
  assert.equal(events.filter((event) => event.type === "warning").length, 2);
  assert.equal(events.filter((event) => event.type === "finished").length, 1);
});
