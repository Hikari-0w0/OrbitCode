import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { MessageList, type VisibleMessage } from "@/components/message-list";

test("Token 用量按 Provider 能力展示缓存数量、命中状态或未报告", () => {
  const messages: readonly VisibleMessage[] = [
    {
      id: "tokens",
      role: "assistant",
      content: "数量",
      state: "complete",
      cumulativeUsage: {
        availability: "reported",
        promptTokens: 1_000,
        completionTokens: 50,
        totalTokens: 1_050,
        promptCache: { availability: "tokens", cachedTokens: 250 },
      },
    },
    {
      id: "status",
      role: "assistant",
      content: "状态",
      state: "complete",
      cumulativeUsage: {
        availability: "reported",
        promptTokens: 10,
        completionTokens: 2,
        totalTokens: 12,
        promptCache: { availability: "status", hit: true },
      },
    },
    {
      id: "unavailable",
      role: "assistant",
      content: "未知",
      state: "complete",
      cumulativeUsage: {
        availability: "reported",
        promptTokens: 10,
        completionTokens: 2,
        totalTokens: 12,
        promptCache: { availability: "unavailable" },
      },
    },
  ];
  const markup = renderToStaticMarkup(
    <MessageList
      messages={messages}
      onSuggestion={() => undefined}
      planActionDisabled={false}
      onExecutePlan={() => undefined}
    />,
  );

  assert.match(markup, /缓存：250 Token（25%）/);
  assert.match(markup, /缓存：命中/);
  assert.match(markup, /缓存：模型未报告/);
  assert.doesNotMatch(markup, /<script/u);
});

test("助手文字和工具卡按实际发生顺序展示", () => {
  const markup = renderToStaticMarkup(
    <MessageList
      messages={[{
        id: "timeline",
        role: "assistant",
        content: "先读取。读取完成。",
        state: "complete",
        parts: [
          { type: "text", iteration: 1, content: "先读取。" },
          { type: "tool", iteration: 1, callId: "read-1" },
          { type: "text", iteration: 2, content: "读取完成。" },
        ],
        toolExecutions: [{
          iteration: 1,
          sequence: 0,
          callId: "read-1",
          name: "read_file",
          argumentsJson: "{}",
          state: "succeeded",
        }],
      }]}
      onSuggestion={() => undefined}
      planActionDisabled={false}
      onExecutePlan={() => undefined}
    />,
  );

  assert.ok(markup.indexOf("先读取。") < markup.indexOf("read_file"));
  assert.ok(markup.indexOf("read_file") < markup.indexOf("读取完成。"));
});
