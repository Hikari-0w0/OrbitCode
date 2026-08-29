import assert from "node:assert/strict";
import test from "node:test";

import { compactToolResults } from "@/core/context/lightweight-compaction";
import { approximateTextTokens } from "@/core/context/token-estimator";
import { renderContextPayload } from "@/core/context/types";
import type {
  ContextChunk,
  ContextPolicyConfig,
  ContextStore,
  ManagedContextMessage,
  StoredContextReference,
} from "@/core/context/types";

test("超过单结果阈值的内容会原子卸载且保持用户原文", async () => {
  const store = new MemoryContextStore();
  const messages: ManagedContextMessage[] = [
    { kind: "user", content: "原始用户消息" },
    {
      kind: "assistant-tool-call",
      content: null,
      toolCalls: [
        { id: "a", name: "read_file", argumentsJson: "{}" },
        { id: "b", name: "read_file", argumentsJson: "{}" },
      ],
    },
    { kind: "tool-result", toolCallId: "a", payload: { storage: "inline", content: "a".repeat(80) } },
    { kind: "tool-result", toolCallId: "b", payload: { storage: "inline", content: "b".repeat(40) } },
  ];
  const result = await compactToolResults({
    messages,
    sessionId: "session",
    config: config({ singleToolResultTokens: 9, toolResultGroupTokens: 300 }),
    store,
    signal: new AbortController().signal,
  });
  assert.equal(result.messages[0]?.kind, "user");
  assert.equal(result.messages[0]?.content, "原始用户消息");
  assert.equal(result.createdReferences.length, 2);
  assert.equal(store.contents[0], "a".repeat(80));
  assert.equal(store.contents[1], "b".repeat(40));
});

test("同批总量超过阈值时按体积稳定降序卸载", async () => {
  const store = new MemoryContextStore();
  const calls = ["a", "b", "c"].map((id) => ({
    id,
    name: "read_file",
    argumentsJson: "{}",
  }));
  const result = await compactToolResults({
    messages: [
      { kind: "assistant-tool-call", content: null, toolCalls: calls },
      { kind: "tool-result", toolCallId: "a", payload: { storage: "inline", content: "a".repeat(6_000) } },
      { kind: "tool-result", toolCallId: "b", payload: { storage: "inline", content: "b".repeat(4_000) } },
      { kind: "tool-result", toolCallId: "c", payload: { storage: "inline", content: "c".repeat(2_000) } },
    ],
    sessionId: "session",
    config: config({
      singleToolResultTokens: 2_000,
      toolResultGroupTokens: 1_800,
      previewChars: 20,
    }),
    store,
    signal: new AbortController().signal,
  });
  assert.deepEqual(store.contents, ["a".repeat(6_000)]);
  assert.equal(result.createdReferences.length, 1);
});

test("大量已卸载结果会继续收窄预览直至批次回到预算内", async () => {
  const store = new MemoryContextStore();
  const calls = Array.from({ length: 8 }, (_, index) => ({
    id: `call-${index}`,
    name: "read_file",
    argumentsJson: "{}",
  }));
  const messages: ManagedContextMessage[] = [
    { kind: "assistant-tool-call", content: null, toolCalls: calls },
    ...calls.map((call) => ({
      kind: "tool-result" as const,
      toolCallId: call.id,
      payload: { storage: "inline" as const, content: "x".repeat(2_000) },
    })),
  ];
  const result = await compactToolResults({
    messages,
    sessionId: "session",
    config: config({
      singleToolResultTokens: 100,
      toolResultGroupTokens: 1_000,
      previewChars: 1_000,
    }),
    store,
    signal: new AbortController().signal,
  });
  const total = result.messages.reduce((tokens, message) =>
    message.kind === "tool-result"
      ? tokens + approximateTextTokens(renderContextPayload(message.payload))
      : tokens, 0);
  assert.ok(total <= 1_000);
  assert.ok(result.messages.some((message) =>
    message.kind === "tool-result" &&
    message.payload.storage === "offloaded" &&
    message.payload.preview.length === 0));
});

class MemoryContextStore implements ContextStore {
  readonly contents: string[] = [];

  async write(input: { readonly content: string }): Promise<StoredContextReference> {
    this.contents.push(input.content);
    return { reference: `context://v1/00000000-0000-4000-8000-${String(this.contents.length).padStart(12, "0")}`, byteLength: Buffer.byteLength(input.content) };
  }
  async read(): Promise<ContextChunk> { throw new Error("unused"); }
  async deleteReference(): Promise<void> {}
  async deleteSession(): Promise<void> {}
}

function config(overrides: Partial<ContextPolicyConfig> = {}): ContextPolicyConfig {
  return {
    windowTokens: 100_000,
    singleToolResultTokens: 8_000,
    toolResultGroupTokens: 12_000,
    recentMessagesTokens: 10_000,
    automaticReserveTokens: 13_000,
    manualReserveTokens: 3_000,
    previewChars: 20,
    ...overrides,
  };
}
