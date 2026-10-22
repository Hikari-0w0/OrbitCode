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

for (const readTool of ["read_context", "agent"] as const) test(`${readTool} 分页按预算返回资源游标，连续读取无二次卸载且不遗漏Unicode`, async () => {
  const store = new MemoryContextStore();
  const content = '原文😀\\"\n'.repeat(2000);
  const characters = Array.from(content);
  let offset = 0, reconstructed = "", calls = 0;
  while (offset < characters.length) {
    const serialized = JSON.stringify({ ok: true, output: { ...(readTool === "read_context" ? {reference:"context://v1/original"} : {taskId:"child",source:"child-model-reply"}), content: characters.slice(offset).join(""), offset, nextOffset: null, totalCharacters: characters.length, hasMore: false }, evidence_call_id: "actual-evidence" });
    const result = await compactToolResults({ messages: [{ kind: "assistant-tool-call", content: null, toolCalls: [{ id: "read", name: readTool, argumentsJson: "{}" }] }, { kind: "tool-result", toolCallId: "read", payload: { storage: "inline", content: serialized } }], sessionId: "session", config: config({ singleToolResultTokens: 1200, toolResultGroupTokens: 2000 }), store, signal: new AbortController().signal });
    assert.equal(result.createdReferences.length, 0);
    const message = result.messages[1];
    assert.equal(message.kind, "tool-result");
    if (message.kind !== "tool-result" || message.payload.storage !== "inline") throw new Error("读取出口不应再次卸载");
    assert.ok(approximateTextTokens(message.payload.content) <= 1200);
    const payload = JSON.parse(message.payload.content);
    if(readTool==="read_context")assert.equal(payload.output.reference, "context://v1/original");else{assert.equal(payload.output.taskId,"child");assert.equal(payload.output.source,"child-model-reply");}
    assert.equal(payload.evidence_call_id, "actual-evidence");
    reconstructed += payload.output.content;
    assert.equal(payload.output.offset, offset);
    const next = payload.output.nextOffset ?? characters.length;
    assert.ok(next > offset);
    offset = next;
    assert.ok(++calls < 100);
  }
  assert.equal(reconstructed, content);
  assert.deepEqual(store.contents, []);
});

test("并行read_context共享批次预算，预算不足明确停止而不制造引用链", async () => {
  const messages: ManagedContextMessage[] = [{ kind: "assistant-tool-call", content: null, toolCalls: ["a", "b"].map(id => ({ id, name: "read_context", argumentsJson: "{}" })) }, ...["a", "b"].map(id => ({ kind: "tool-result" as const, toolCallId: id, payload: { storage: "inline" as const, content: JSON.stringify({ ok: true, output: { reference: `context://v1/${id}`, content: "long".repeat(5000), offset: 0, nextOffset: null, totalCharacters: 20000, hasMore: false } }) } }))];
  const store = new MemoryContextStore();
  const result = await compactToolResults({ messages, sessionId: "s", config: config({ singleToolResultTokens: 1200, toolResultGroupTokens: 1000 }), store, signal: new AbortController().signal });
  assert.equal(result.createdReferences.length, 0);
  const tokens = result.messages.reduce((total, message) => total + (message.kind === "tool-result" ? approximateTextTokens(renderContextPayload(message.payload)) : 0), 0);
  assert.ok(tokens <= 1000);
  await assert.rejects(compactToolResults({ messages, sessionId: "s", config: config({ singleToolResultTokens: 1, toolResultGroupTokens: 2 }), store, signal: new AbortController().signal }), /预算不足/);
  assert.deepEqual(store.contents, []);
});

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
