import assert from "node:assert/strict";
import test from "node:test";

import { compactOperationalHistory } from "@/core/context/operational-compaction";
import type {
  ContextChunk,
  ContextPolicyConfig,
  ContextStore,
  ManagedContextMessage,
  StoredContextReference,
} from "@/core/context/types";

test("折叠较早成功交换并完整保留最近工作集", async () => {
  const store = new MemoryStore();
  const messages: ManagedContextMessage[] = [
    { kind: "user", content: "实现项目，保留这条原始目标" },
    ...Array.from({ length: 6 }, (_, index) => successfulExchange(index)).flat(),
  ];

  const result = await compactOperationalHistory({
    messages,
    sessionId: "session",
    config: policy({ recentToolExchanges: 2 }),
    store,
    signal: new AbortController().signal,
  });

  assert.equal(result.compactedExchanges, 4);
  assert.equal(result.createdReferences.length, 4);
  assert.ok(result.afterTokens < result.beforeTokens / 2);
  assert.deepEqual(result.messages[0], messages[0]);
  assert.deepEqual(result.messages.slice(-4), messages.slice(-4));
  assertProtocolComplete(result.messages);
  const stored = JSON.parse(store.contents[0] ?? "null") as {
    readonly kind: string;
    readonly messages: readonly ManagedContextMessage[];
  };
  assert.equal(stored.kind, "tool-exchange");
  assert.deepEqual(stored.messages, successfulExchange(0));
});

test("只折叠较早的重复失败，并保留最新失败与完成证据", async () => {
  const store = new MemoryStore();
  const completion = successfulExchange(90, "report_completion");
  const messages: ManagedContextMessage[] = [
    { kind: "user", content: "继续" },
    ...completion,
    ...failedExchange(1),
    ...failedExchange(2),
    ...failedExchange(3),
  ];

  const result = await compactOperationalHistory({
    messages,
    sessionId: "session",
    config: policy({ recentToolExchanges: 1 }),
    store,
    signal: new AbortController().signal,
  });

  assert.equal(result.compactedExchanges, 2);
  assert.deepEqual(result.messages.slice(1, 3), completion);
  assert.deepEqual(result.messages.slice(-2), failedExchange(3));
  assert.ok(result.messages.filter((message) => message.kind === "boundary")
    .every((message) => message.content.includes("status: repeated-failure")));
  assertProtocolComplete(result.messages);
});

test("引用写入中途失败时删除已创建引用并原样回滚", async () => {
  const store = new MemoryStore(2);
  const messages = Array.from({ length: 4 }, (_, index) => successfulExchange(index)).flat();

  const result = await compactOperationalHistory({
    messages,
    sessionId: "session",
    config: policy({ recentToolExchanges: 1 }),
    store,
    signal: new AbortController().signal,
  });

  assert.equal(result.rolledBack, true);
  assert.equal(result.compactedExchanges, 0);
  assert.deepEqual(result.messages, messages);
  assert.deepEqual(store.deleted, [store.references[0]]);
});

test("不完整工具协议不参与折叠", async () => {
  const messages: ManagedContextMessage[] = [
    {
      kind: "assistant-tool-call",
      content: null,
      toolCalls: [{ id: "missing", name: "write_file", argumentsJson: "{}" }],
    },
  ];
  const result = await compactOperationalHistory({
    messages,
    sessionId: "session",
    config: policy({ recentToolExchanges: 1 }),
    store: new MemoryStore(),
    signal: new AbortController().signal,
  });
  assert.equal(result.compactedExchanges, 0);
  assert.deepEqual(result.messages, messages);
});

class MemoryStore implements ContextStore {
  readonly contents: string[] = [];
  readonly references: string[] = [];
  readonly deleted: string[] = [];

  constructor(private readonly failAtWrite?: number) {}

  async write(input: { readonly content: string }): Promise<StoredContextReference> {
    const count = this.contents.length + 1;
    if (count === this.failAtWrite) throw new Error("injected storage failure");
    const reference = `context://v1/00000000-0000-4000-8000-${String(count).padStart(12, "0")}`;
    this.contents.push(input.content);
    this.references.push(reference);
    return { reference, byteLength: Buffer.byteLength(input.content) };
  }

  async read(): Promise<ContextChunk> { throw new Error("unused"); }
  async deleteReference(input: { readonly reference: string }): Promise<void> {
    this.deleted.push(input.reference);
  }
  async deleteSession(): Promise<void> {}
}

function successfulExchange(
  index: number,
  name = "write_file",
): readonly ManagedContextMessage[] {
  const id = `success-${index}`;
  return [
    {
      kind: "assistant-tool-call",
      content: null,
      toolCalls: [{ id, name, argumentsJson: JSON.stringify({ content: "x".repeat(1_000) }) }],
    },
    {
      kind: "tool-result",
      toolCallId: id,
      payload: {
        storage: "inline",
        content: JSON.stringify({ ok: true, output: { detail: "y".repeat(1_000) } }),
      },
    },
  ];
}

function failedExchange(index: number): readonly ManagedContextMessage[] {
  const id = `failure-${index}`;
  return [
    {
      kind: "assistant-tool-call",
      content: null,
      toolCalls: [{ id, name: "run_command", argumentsJson: "{\"command\":\"bad\"}" }],
    },
    {
      kind: "tool-result",
      toolCallId: id,
      payload: {
        storage: "inline",
        content: JSON.stringify({
          ok: false,
          error: {
            kind: "invalid-arguments",
            issues: [{ path: "$.command", message: "invalid" }],
          },
        }),
      },
    },
  ];
}

function policy(overrides: Partial<ContextPolicyConfig> = {}): ContextPolicyConfig {
  return {
    windowTokens: 100_000,
    singleToolResultTokens: 8_000,
    toolResultGroupTokens: 12_000,
    recentMessagesTokens: 10_000,
    automaticReserveTokens: 13_000,
    manualReserveTokens: 3_000,
    previewChars: 100,
    operationalCompactionTokens: 1,
    recentToolExchanges: 2,
    ...overrides,
  };
}

function assertProtocolComplete(messages: readonly ManagedContextMessage[]): void {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.kind === "tool-result") {
      assert.fail(`发现孤立工具结果：${message.toolCallId}`);
    }
    if (message?.kind !== "assistant-tool-call") continue;
    const results = messages.slice(index + 1, index + 1 + message.toolCalls.length);
    assert.deepEqual(
      results.map((result) => result.kind === "tool-result" ? result.toolCallId : undefined),
      message.toolCalls.map((call) => call.id),
    );
    index += results.length;
  }
}
