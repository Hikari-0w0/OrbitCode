import assert from "node:assert/strict";
import test from "node:test";
import type { ChatProvider } from "./provider";
import { isModelUsageSummary, ModelUsageTracker } from "./usage-tracker";

test("按用途分别统计模型用量，缺失用量与失败请求保持可辨识", async () => {
  const tracker = new ModelUsageTracker();
  const provider: ChatProvider = { async *stream() {
    yield { type: "usage", usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15, promptCache: { availability: "unavailable" } } };
    yield { type: "done", finishReason: "stop" };
  } };
  const options = { signal: new AbortController().signal, toolChoice: "none" } as const;
  for await (const event of tracker.wrap(provider, "summary").stream([], options)) void event;
  for await (const event of tracker.wrap({ async *stream() { yield { type: "done", finishReason: "stop" }; } }, "agent").stream([], options)) void event;
  await assert.rejects(async () => {
    for await (const event of tracker.wrap({ async *stream() { throw new Error("合成失败"); } }, "agent").stream([], options)) void event;
  });
  const summary = tracker.snapshot();
  assert.ok(isModelUsageSummary(summary));
  assert.deepEqual(summary.categories.map(({ purpose, requests, reportedRequests, failedRequests, totalTokens }) => ({ purpose, requests, reportedRequests, failedRequests, totalTokens })), [
    { purpose: "summary", requests: 1, reportedRequests: 1, failedRequests: 0, totalTokens: 15 },
    { purpose: "agent", requests: 2, reportedRequests: 0, failedRequests: 1, totalTokens: 0 },
  ]);
  assert.equal(isModelUsageSummary({ scope: "self", categories: [{ ...summary.categories[0], reportedRequests: 2 }] }), false);
});
