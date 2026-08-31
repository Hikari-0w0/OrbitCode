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

test("持久化快照恢复完整工具协议、中断边界和压缩失败计数", async () => {
  const provider = new ScriptedSummaryProvider([]);
  const initialState = {
    messages: [
      { kind: "user" as const, content: "检查文件" },
      {
        kind: "assistant-tool-call" as const,
        content: null,
        reasoningContent: "内部推理协议",
        toolCalls: [{ id: "read-1", name: "read_file", argumentsJson: "{}" }],
      },
      {
        kind: "tool-result" as const,
        toolCallId: "read-1",
        payload: { storage: "inline" as const, content: "文件内容" },
      },
      {
        kind: "interruption" as const,
        reason: "max-iterations" as const,
        detail: "达到上限",
        sideEffect: "none" as const,
      },
    ],
    consecutiveSummaryFailures: 2,
  };
  const manager = new ContextManager({
    sessionId: "conversation-1",
    config: policy(),
    store: new MemoryStore(),
    provider,
    initialState,
  });
  assert.deepEqual(manager.persistentSnapshot(), initialState);
  assert.equal(manager.getModelHistory()[1]?.role, "assistant");
  assert.equal(manager.getModelHistory()[2]?.role, "tool");

  manager.beginTurn("继续");
  assert.throws(() => manager.persistentSnapshot(), /结束前不能/);
  await manager.rollbackTurn();
  assert.deepEqual(manager.persistentSnapshot(), initialState);
});

test("运行阶段压缩创建的引用在轮次回滚时清理", async () => {
  const store = new MemoryStore();
  const messages = Array.from({ length: 3 }, (_, index) => {
    const id = `write-${index}`;
    return [
      {
        kind: "assistant-tool-call" as const,
        content: null,
        toolCalls: [{
          id,
          name: "write_file",
          argumentsJson: JSON.stringify({ content: "x".repeat(500) }),
        }],
      },
      {
        kind: "tool-result" as const,
        toolCallId: id,
        payload: {
          storage: "inline" as const,
          content: JSON.stringify({ ok: true, output: { path: `file-${index}` } }),
        },
      },
    ];
  }).flat();
  const initialState = { messages, consecutiveSummaryFailures: 0 };
  const manager = new ContextManager({
    sessionId: "session",
    config: {
      ...policy(),
      operationalCompactionTokens: 1,
      recentToolExchanges: 1,
    },
    store,
    provider: new ScriptedSummaryProvider([]),
    initialState,
  });

  manager.beginTurn("继续");
  await manager.prepareForModel(
    { systemMessages: [], tools: [] },
    new AbortController().signal,
  );
  assert.equal(store.references.length, 2);
  await manager.rollbackTurn();
  assert.deepEqual(store.deleted, store.references);
  assert.deepEqual(manager.persistentSnapshot(), initialState);
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
  readonly references: string[] = [];
  readonly deleted: string[] = [];

  async write(input: { readonly content: string }): Promise<StoredContextReference> {
    const reference = `context://v1/00000000-0000-4000-8000-${String(this.references.length + 1).padStart(12, "0")}`;
    this.references.push(reference);
    return { reference, byteLength: input.content.length };
  }
  async read(): Promise<ContextChunk> { throw new Error("unused"); }
  async deleteReference(input: { readonly reference: string }): Promise<void> {
    this.deleted.push(input.reference);
  }
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
