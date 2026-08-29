import assert from "node:assert/strict";
import test from "node:test";

import { compactOlderHistory } from "@/core/context/heavy-compaction";
import { TokenEstimator } from "@/core/context/token-estimator";
import { ToolFreeSummaryGenerator } from "@/core/context/tool-free-summary-generator";
import {
  CONTEXT_BOUNDARY_MESSAGE,
  type ContextPolicyConfig,
  type ManagedContextMessage,
} from "@/core/context/types";
import type { ChatProvider, ModelStreamEvent } from "@/models/provider";

test("重量压缩保留旧用户原文、至少五条近期原文和唯一边界", async () => {
  const messages: ManagedContextMessage[] = Array.from(
    { length: 16 },
    (_, index): ManagedContextMessage => index % 2 === 0
      ? { kind: "user", content: `用户原文-${index}` }
      : { kind: "assistant", content: `助手工作-${index}-${"x".repeat(800)}` },
  );
  messages.splice(8, 0,
    {
      kind: "summary",
      summary: {
        taskGoals: ["旧摘要目标"],
        completedWork: [],
        keyDecisions: [],
        fileChanges: [],
        toolResults: [],
        errors: [],
        nextSteps: [],
      },
    },
    { kind: "boundary", content: CONTEXT_BOUNDARY_MESSAGE },
  );
  const provider = new SummaryProvider();
  const result = await compactOlderHistory({
    messages,
    envelope: { systemMessages: [], tools: [] },
    config: policy(),
    estimator: new TokenEstimator(),
    generator: new ToolFreeSummaryGenerator(provider),
    trigger: "manual",
    signal: new AbortController().signal,
  });

  assert.ok(result.after.tokens < result.before.tokens);
  assert.equal(result.messages.filter((message) => message.kind === "summary").length, 1);
  assert.equal(result.messages.filter((message) => message.kind === "boundary").length, 1);
  assert.deepEqual(
    result.messages
      .filter((message) => message.kind === "user")
      .map((message) => message.content),
    messages
      .filter((message) => message.kind === "user")
      .map((message) => message.content),
  );
  assert.ok(provider.summaryInput.includes("旧摘要目标"));
  assert.ok(result.messages.slice(-5).every(
    (message) => message.kind !== "summary" && message.kind !== "boundary",
  ));
});

class SummaryProvider implements ChatProvider {
  summaryInput = "";

  async *stream(messages: Parameters<ChatProvider["stream"]>[0]): AsyncIterable<ModelStreamEvent> {
    this.summaryInput = JSON.stringify(messages);
    yield {
      type: "text-delta",
      text: JSON.stringify({
        analysisDraft: "先归纳已有事实",
        summary: {
          taskGoals: ["继续当前任务"],
          completedWork: ["已整理旧历史"],
          keyDecisions: [],
          fileChanges: [],
          toolResults: [],
          errors: [],
          nextSteps: ["重新读取所需文件"],
        },
      }),
    };
    yield { type: "done", finishReason: "stop" };
  }
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
