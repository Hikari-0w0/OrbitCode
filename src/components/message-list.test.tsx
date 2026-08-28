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
