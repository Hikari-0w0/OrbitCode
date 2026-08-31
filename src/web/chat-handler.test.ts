import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession } from "@/core/agent-loop";
import type { AgentRunLogEntry } from "@/lib/local-agent-run-log";
import { parseWebChatEvents, readWebStream } from "@/web/chat-contract";
import { streamAgentResponse } from "@/web/chat-handler";

test("Web 流消费者取消会中止 Agent 并释放响应流", async () => {
  let observedAbort = false;
  let loggedEntry: AgentRunLogEntry | undefined;
  let resolveAbort: (() => void) | undefined;
  let resolveLogged: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  const logged = new Promise<void>((resolve) => {
    resolveLogged = resolve;
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
        durationMs: 250,
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
    runLog: {
      sink: {
        append: async (entry) => {
          loggedEntry = entry;
          resolveLogged?.();
        },
      },
      conversationId: "conversation-cancel",
      revisionBefore: 2,
      providerId: "deepseek",
      workspaceId: "project",
      createRunId: () => "run-cancel",
      now: (() => {
        const values = [1_000, 1_450];
        return () => values.shift() ?? 1_450;
      })(),
    },
  });
  assert.ok(response.body);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value).includes("tool-started"), true);
  await reader.cancel();
  await aborted;
  await logged;
  assert.equal(observedAbort, true);
  assert.equal(loggedEntry?.stopReason, "cancelled");
  assert.equal(loggedEntry?.durationMs, 250);
  assert.equal(loggedEntry?.revisionBefore, 2);
  assert.deepEqual(loggedEntry?.persistence, { status: "not-attempted" });
  assert.deepEqual(loggedEntry?.tools, [{
    name: "run_command",
    status: "unfinished",
  }]);
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
    durationMs: events[0]?.type === "stopped" ? events[0].durationMs : -1,
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
        durationMs: 500,
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

test("停止 SSE 在终态持久化完成后发出并携带修订号", async () => {
  const order: string[] = [];
  const agent: AgentSession = {
    getHistory: () => [],
    async *streamTurn() {
      yield { type: "text-delta", iteration: 1, text: "完成" } as const;
      order.push("agent-committed");
      yield {
        type: "stopped",
        reason: "final-response",
        iterations: 1,
        durationMs: 20,
        sideEffect: "none",
        finalMessage: { role: "assistant", content: "完成" },
      } as const;
    },
  };
  const response = streamAgentResponse({
    request: new Request("http://localhost/api/chat", { method: "POST" }),
    agent,
    input: "执行",
    mode: "do",
    modeTurn: 1,
    persistTurn: async (events) => {
      assert.equal(events.at(-1)?.type, "stopped");
      order.push("saved");
      return { status: "saved", revision: 3 };
    },
  });
  assert.ok(response.body);
  const events = [];
  for await (const event of parseWebChatEvents(readWebStream(response.body))) {
    if (event.type === "stopped") order.push("sse-stopped");
    events.push(event);
  }
  assert.deepEqual(order, ["agent-committed", "saved", "sse-stopped"]);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "stopped");
  if (terminal?.type === "stopped") {
    assert.deepEqual(terminal.persistence, { status: "saved", revision: 3 });
  }
});

test("终态保存失败仍只发送一个可重试停止事件", async () => {
  const agent: AgentSession = {
    getHistory: () => [],
    async *streamTurn() {
      yield {
        type: "stopped",
        reason: "cancelled",
        iterations: 1,
        durationMs: 30,
        sideEffect: "possible",
        detail: "已取消。",
      } as const;
    },
  };
  const response = streamAgentResponse({
    request: new Request("http://localhost/api/chat", { method: "POST" }),
    agent,
    input: "运行",
    mode: "do",
    modeTurn: 1,
    persistTurn: async () => { throw new Error("本地磁盘暂时不可写，请重试保存。"); },
  });
  assert.ok(response.body);
  const events = [];
  for await (const event of parseWebChatEvents(readWebStream(response.body))) events.push(event);
  assert.equal(events.filter((event) => event.type === "stopped").length, 1);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "stopped");
  if (terminal?.type === "stopped") {
    assert.deepEqual(terminal.persistence, {
      status: "failed",
      detail: "本地磁盘暂时不可写，请重试保存。",
    });
  }
});

test("Web Agent 运行聚合为不含正文和工具载荷的本地日志摘要", async () => {
  const entries: AgentRunLogEntry[] = [];
  const agent: AgentSession = {
    getHistory() {
      return [];
    },
    async *streamTurn() {
      yield {
        type: "text-delta",
        iteration: 1,
        text: "不得写入日志的模型正文",
      } as const;
      yield {
        type: "tool-call",
        iteration: 1,
        sequence: 0,
        call: {
          id: "call-secret",
          name: "read_file",
          argumentsJson: '{"path":"secret.ts"}',
        },
      } as const;
      yield {
        type: "tool-result",
        iteration: 1,
        sequence: 0,
        callId: "call-secret",
        name: "read_file",
        result: {
          ok: true,
          output: { content: "不得写入日志的工具输出" },
          sideEffect: "none",
          meta: { durationMs: 25, truncated: false, truncatedFields: [] },
        },
      } as const;
      yield {
        type: "token-usage",
        iteration: 1,
        usage: {
          availability: "reported",
          promptTokens: 80,
          completionTokens: 20,
          totalTokens: 100,
          promptCache: { availability: "unavailable" },
        },
        cumulative: {
          availability: "reported",
          promptTokens: 80,
          completionTokens: 20,
          totalTokens: 100,
          promptCache: { availability: "unavailable" },
        },
      } as const;
      yield {
        type: "stopped",
        reason: "final-response",
        iterations: 1,
        durationMs: 1_250,
        sideEffect: "none",
        finalMessage: { role: "assistant", content: "不得写入日志的模型正文" },
      } as const;
    },
  };
  const times = [
    Date.parse("2026-08-30T01:00:00.000Z"),
    Date.parse("2026-08-30T01:00:00.100Z"),
    Date.parse("2026-08-30T01:00:01.250Z"),
  ];
  const response = streamAgentResponse({
    request: new Request("http://localhost/api/chat", { method: "POST" }),
    agent,
    input: "不得写入日志的用户输入",
    mode: "do",
    modeTurn: 3,
    runLog: {
      sink: { append: async (entry) => { entries.push(entry); } },
      conversationId: "conversation-1",
      revisionBefore: 4,
      providerId: "deepseek",
      workspaceId: "project",
      createRunId: () => "run-1",
      now: () => times.shift() ?? 0,
    },
    persistTurn: async () => ({ status: "saved", revision: 5 }),
  });
  assert.ok(response.body);
  for await (const event of parseWebChatEvents(readWebStream(response.body))) {
    assert.ok(event.type.length > 0);
  }

  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    runId: "run-1",
    source: "web",
    conversationId: "conversation-1",
    revisionBefore: 4,
    persistence: { status: "saved", revisionAfter: 5 },
    providerId: "deepseek",
    workspaceId: "project",
    mode: "do",
    modeTurn: 3,
    startedAt: "2026-08-30T01:00:00.000Z",
    finishedAt: "2026-08-30T01:00:01.250Z",
    durationMs: 1_250,
    firstModelOutputMs: 100,
    stopReason: "final-response",
    iterations: 1,
    sideEffect: "none",
    inputChars: 11,
    outputChars: 11,
    usage: {
      availability: "reported",
      promptTokens: 80,
      completionTokens: 20,
      totalTokens: 100,
    },
    tools: [{ name: "read_file", status: "succeeded", durationMs: 25 }],
  });
  assert.equal(JSON.stringify(entries).includes("不得写入日志"), false);
  assert.equal(JSON.stringify(entries).includes("secret.ts"), false);
});
