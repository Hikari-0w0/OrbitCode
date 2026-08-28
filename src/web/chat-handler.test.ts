import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession } from "@/core/agent-loop";
import { parseWebChatEvents, readWebStream } from "@/web/chat-contract";
import { streamAgentResponse } from "@/web/chat-handler";

test("Web 流消费者取消会中止 Agent 并释放响应流", async () => {
  let observedAbort = false;
  let resolveAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  const agent: AgentSession = {
    getHistory() {
      return [];
    },
    async *streamTurn(options) {
      yield {
        type: "tool-started",
        iteration: 1,
        callId: "call_cancel",
        name: "run_command",
        sequence: 0,
      } as const;
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) {
          observedAbort = true;
          resolveAbort?.();
          resolve();
          return;
        }
        options.signal.addEventListener("abort", () => {
          observedAbort = true;
          resolveAbort?.();
          resolve();
        }, { once: true });
      });
      yield {
        type: "stopped",
        reason: "cancelled",
        iterations: 1,
        sideEffect: "possible",
        detail: "Agent 轮次已取消。",
      } as const;
    },
  };
  const response = streamAgentResponse({
    request: new Request("http://localhost/api/chat", { method: "POST" }),
    agent,
    input: "长命令",
    mode: "do",
    modeTurn: 1,
  });
  assert.ok(response.body);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value).includes("tool-started"), true);
  await reader.cancel();
  await aborted;
  assert.equal(observedAbort, true);
});

test("Agent 未知异常被收敛为安全停止 SSE", async () => {
  const agent: AgentSession = {
    getHistory() {
      return [];
    },
    async *streamTurn() {
      throw new Error("internal-secret");
    },
  };
  const response = streamAgentResponse({
    request: new Request("http://localhost/api/chat", { method: "POST" }),
    agent,
    input: "失败",
    mode: "do",
    modeTurn: 1,
  });
  assert.ok(response.body);
  const events = [];
  for await (const event of parseWebChatEvents(readWebStream(response.body))) {
    events.push(event);
  }
  assert.deepEqual(events, [{
    type: "stopped",
    reason: "agent-error",
    iterations: 0,
    sideEffect: "none",
    detail: "Agent 执行发生未知错误，请重试。",
  }]);
  assert.equal(JSON.stringify(events).includes("internal-secret"), false);
});

test("Agent 正常停止后不追加第二个终止事件", async () => {
  const agent: AgentSession = {
    getHistory() {
      return [];
    },
    async *streamTurn() {
      yield {
        type: "stopped",
        reason: "final-response",
        iterations: 1,
        sideEffect: "none",
        finalMessage: { role: "assistant", content: "完成" },
      } as const;
    },
  };
  const response = streamAgentResponse({
    request: new Request("http://localhost/api/chat", { method: "POST" }),
    agent,
    input: "完成",
    mode: "plan",
    modeTurn: 1,
  });
  assert.ok(response.body);
  const events = [];
  for await (const event of parseWebChatEvents(readWebStream(response.body))) {
    events.push(event);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "stopped");
});
