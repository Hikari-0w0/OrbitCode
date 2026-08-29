import assert from "node:assert/strict";
import test from "node:test";

import { ToolFreeSummaryGenerator } from "@/core/context/tool-free-summary-generator";
import type {
  ChatProvider,
  ConversationMessage,
  ModelStreamEvent,
} from "@/models/provider";

test("摘要调用由核心强制禁用工具", async () => {
  let received: Parameters<ChatProvider["stream"]>[1] | undefined;
  const provider: ChatProvider = {
    stream(_messages, options) {
      received = options;
      return events(
        { type: "reasoning-delta", text: "内部分析" },
        { type: "text-delta", text: validSummary() },
        { type: "done", finishReason: "stop" },
      );
    },
  };
  const result = await new ToolFreeSummaryGenerator(provider).generate(
    [{ kind: "assistant", content: "已完成" }],
    new AbortController().signal,
  );
  assert.equal(received?.toolChoice, "none");
  assert.equal(received?.tools, undefined);
  assert.deepEqual(result.completedWork, ["完成"]);
});

test("摘要模型仍返回工具调用时压缩失败", async () => {
  const provider: ChatProvider = {
    stream() {
      return events(
        {
          type: "tool-call",
          call: { id: "x", name: "read_file", argumentsJson: "{}" },
        },
        { type: "done", finishReason: "tool-call" },
      );
    },
  };
  await assert.rejects(
    new ToolFreeSummaryGenerator(provider).generate(
      [{ kind: "assistant", content: "旧历史" }],
      new AbortController().signal,
    ),
    /禁用工具/,
  );
});

async function* events(
  ...items: readonly ModelStreamEvent[]
): AsyncIterable<ModelStreamEvent> {
  yield* items;
}

function validSummary(): string {
  return JSON.stringify({
    analysisDraft: "分析",
    summary: {
      taskGoals: [],
      completedWork: ["完成"],
      keyDecisions: [],
      fileChanges: [],
      toolResults: [],
      errors: [],
      nextSteps: [],
    },
  });
}

void (null as ConversationMessage | null);
