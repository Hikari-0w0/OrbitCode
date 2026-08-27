import assert from "node:assert/strict";
import test from "node:test";

import type { SingleToolAgentSession } from "@/core/single-tool-agent";
import { parseWebChatEvents, readWebStream } from "@/web/chat-contract";
import { streamAgentResponse } from "@/web/chat-handler";

test("Web 流消费者取消会中止 Agent 并释放响应流", async () => {
  let observedAbort = false;
  let resolveAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  const agent: SingleToolAgentSession = {
    getHistory() {
      return [];
    },
    async *streamTurn(_input, signal) {
      yield { type: "tool-started", callId: "call_cancel", name: "run_command" };
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          observedAbort = true;
          resolveAbort?.();
          resolve();
          return;
        }
        signal.addEventListener("abort", () => {
          observedAbort = true;
          resolveAbort?.();
          resolve();
        }, { once: true });
      });
      yield { type: "cancelled", sideEffect: "possible" };
    },
  };
  const response = streamAgentResponse({
    request: new Request("http://localhost/api/chat", { method: "POST" }),
    agent,
    input: "长命令",
  });
  assert.ok(response.body);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value).includes("tool-started"), true);
  await reader.cancel();
  await aborted;
  assert.equal(observedAbort, true);
});

test("Agent 未知异常被收敛为安全失败 SSE", async () => {
  const agent: SingleToolAgentSession = {
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
  });
  assert.ok(response.body);
  const events = [];
  for await (const event of parseWebChatEvents(readWebStream(response.body))) {
    events.push(event);
  }
  assert.deepEqual(events, [{
    type: "failed",
    message: "Agent 执行发生未知错误，请重试。",
    sideEffect: "none",
  }]);
  assert.equal(JSON.stringify(events).includes("internal-secret"), false);
});
