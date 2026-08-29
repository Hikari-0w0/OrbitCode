import assert from "node:assert/strict";
import test from "node:test";

import { ContextManager } from "@/core/context/context-manager";
import type {
  ContextChunk,
  ContextPolicyConfig,
  ContextStore,
  StoredContextReference,
} from "@/core/context/types";
import type {
  ChatProvider,
  ModelStreamEvent,
  PlainConversationMessage,
} from "@/models/provider";

test("手动重量压缩保留用户原文、近期消息并写入边界", async () => {
  const provider = new ScriptedSummaryProvider([[text(validSummary()), done()]]);
  const history = longHistory();
  const manager = new ContextManager({
    sessionId: "session",
    config: policy(),
    store: new MemoryStore(),
    provider,
    initialHistory: history,
  });
  const report = await manager.compressManually(new AbortController().signal);
  assert.equal(report.status, "succeeded");
  const snapshot = manager.snapshot();
  const usersBefore = history.filter((message) => message.role === "user");
  const usersAfter = snapshot.messages.filter((message) => message.kind === "user");
  assert.deepEqual(
    usersAfter.map((message) => message.content),
    usersBefore.map((message) => message.content),
  );
  assert.equal(snapshot.messages.filter((message) => message.kind === "summary").length, 1);
  assert.equal(snapshot.messages.filter((message) => message.kind === "boundary").length, 1);
});

test("连续三次摘要协议失败打开熔断，手动成功可恢复", async () => {
  const failure = [
    {
      type: "tool-call" as const,
      call: { id: "x", name: "read_file", argumentsJson: "{}" },
    },
    { type: "done" as const, finishReason: "tool-call" as const },
  ];
  const provider = new ScriptedSummaryProvider([
    failure,
    failure,
    failure,
    [text(validSummary()), done()],
  ]);
  const manager = new ContextManager({
    sessionId: "session",
    config: policy(),
    store: new MemoryStore(),
    provider,
    initialHistory: longHistory(),
  });
  const first = await manager.compressManually(new AbortController().signal);
  const second = await manager.compressManually(new AbortController().signal);
  const third = await manager.compressManually(new AbortController().signal);
  assert.equal(first.status, "failed");
  assert.equal(second.status, "failed");
  assert.equal(third.status, "circuit-open");
  assert.equal(manager.snapshot().consecutiveSummaryFailures, 3);

  const recovered = await manager.compressManually(new AbortController().signal);
  assert.equal(recovered.status, "succeeded");
  assert.equal(manager.snapshot().consecutiveSummaryFailures, 0);
});

test("失败轮次回滚新增消息和 usage 锚点", async () => {
  const provider = new ScriptedSummaryProvider([]);
  const manager = new ContextManager({
    sessionId: "session",
    config: policy(),
    store: new MemoryStore(),
    provider,
    initialHistory: [{ role: "user", content: "旧问题" }, { role: "assistant", content: "旧回答" }],
  });
  manager.beginTurn("新问题");
  const envelope = { systemMessages: [], tools: [] } as const;
  await manager.prepareForModel(envelope, new AbortController().signal);
  manager.recordAgentUsage(100, envelope);
  manager.appendFinal("未提交回答");
  await manager.rollbackTurn();
  assert.deepEqual(manager.getPlainHistory(), [
    { role: "user", content: "旧问题" },
    { role: "assistant", content: "旧回答" },
  ]);
  assert.equal(manager.snapshot().messages.length, 2);
});

class ScriptedSummaryProvider implements ChatProvider {
  constructor(private readonly scripts: Array<readonly ModelStreamEvent[]>) {}
  stream(): AsyncIterable<ModelStreamEvent> {
    const script = this.scripts.shift();
    if (!script) throw new Error("missing script");
    return events(...script);
  }
}

class MemoryStore implements ContextStore {
  async write(input: { readonly content: string }): Promise<StoredContextReference> {
    return { reference: "context://v1/00000000-0000-4000-8000-000000000001", byteLength: input.content.length };
  }
  async read(): Promise<ContextChunk> { throw new Error("unused"); }
  async deleteReference(): Promise<void> {}
  async deleteSession(): Promise<void> {}
}

function longHistory(): readonly PlainConversationMessage[] {
  return Array.from({ length: 20 }, (_, index): PlainConversationMessage =>
    index % 2 === 0
      ? { role: "user", content: `用户原文-${index}` }
      : { role: "assistant", content: `助手工作-${index}-` + "x".repeat(1000) },
  );
}

function policy(): ContextPolicyConfig {
  return {
    windowTokens: 100_000,
    singleToolResultTokens: 8_000,
    toolResultGroupTokens: 12_000,
    recentMessagesTokens: 100,
    automaticReserveTokens: 13_000,
    manualReserveTokens: 3_000,
    previewChars: 100,
  };
}

function validSummary(): string {
  return JSON.stringify({
    analysisDraft: "分析旧历史",
    summary: {
      taskGoals: ["保持任务目标"],
      completedWork: ["完成旧工作"],
      keyDecisions: [],
      fileChanges: [],
      toolResults: [],
      errors: [],
      nextSteps: ["继续"],
    },
  });
}

function text(value: string): ModelStreamEvent {
  return { type: "text-delta", text: value };
}

function done(): ModelStreamEvent {
  return { type: "done", finishReason: "stop" };
}

async function* events(...items: readonly ModelStreamEvent[]) {
  yield* items;
}
