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
        durationMs: 65_400,
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
  assert.match(markup, /总用时：1 分 5 秒/u);
});

test("纯换行时间线片段不会撑开连续工具卡", () => {
  const tools = [8, 9, 10].map((iteration) => ({
    iteration,
    sequence: 0,
    callId: `write-${iteration}`,
    name: "write_file",
    argumentsJson: "{}",
    state: "succeeded" as const,
  }));
  const markup = renderToStaticMarkup(
    <MessageList
      messages={[{
        id: "blank-parts",
        role: "assistant",
        content: "\n\n\n\n\n",
        state: "complete",
        parts: [
          { type: "tool", iteration: 8, callId: "write-8" },
          { type: "text", iteration: 9, content: "\n\n\n\n\n\n\n" },
          { type: "tool", iteration: 9, callId: "write-9" },
          { type: "text", iteration: 10, content: "\n\n\n" },
          { type: "tool", iteration: 10, callId: "write-10" },
        ],
        toolExecutions: tools,
      }]}
      onSuggestion={() => undefined}
      planActionDisabled={false}
      onExecutePlan={() => undefined}
    />,
  );

  assert.equal((markup.match(/class="toolCard /g) ?? []).length, 3);
  assert.equal((markup.match(/class="messageText"/g) ?? []).length, 0);
  assert.ok(markup.indexOf("第 8 轮") < markup.indexOf("第 9 轮"));
  assert.ok(markup.indexOf("第 9 轮") < markup.indexOf("第 10 轮"));
});

test("无限迭代模式显示无穷上限", () => {
  const markup = renderToStaticMarkup(
    <MessageList
      messages={[{
        id: "unlimited",
        role: "assistant",
        content: "",
        state: "streaming",
        progress: {
          type: "progress",
          iteration: 33,
          maxIterations: "unlimited",
          phase: "model",
        },
      }]}
      onSuggestion={() => undefined}
      planActionDisabled={false}
      onExecutePlan={() => undefined}
    />,
  );

  assert.match(markup, /迭代 33\/∞/u);
});

test("运行中进度条位于最新输出下方并显示总用时", () => {
  const markup = renderToStaticMarkup(
    <MessageList
      messages={[{
        id: "running",
        role: "assistant",
        content: "正在检查最新改动。",
        state: "streaming",
        progress: {
          type: "progress",
          iteration: 2,
          maxIterations: 20,
          phase: "tools",
          completedTools: 1,
          totalTools: 2,
        },
      }]}
      currentRunStartedAtMs={Date.now() - 12_300}
      onSuggestion={() => undefined}
      planActionDisabled={false}
      onExecutePlan={() => undefined}
    />,
  );

  assert.ok(markup.indexOf("正在检查最新改动。") < markup.indexOf("Agent 当前进度"));
  assert.match(markup, /总用时：/u);
});

test("模型工具参数进度显示累计字符与耗时", () => {
  const markup = renderToStaticMarkup(
    <MessageList
      messages={[{
        id: "tool-arguments-progress",
        role: "assistant",
        content: "",
        state: "streaming",
        progress: {
          type: "progress",
          iteration: 2,
          maxIterations: 20,
          phase: "model",
          model: {
            stage: "streaming-tool-arguments",
            elapsedMs: 12_300,
            attempt: 1,
            toolName: "write_files",
            toolArgumentsChars: 19_368,
          },
        },
      }]}
      onSuggestion={() => undefined}
      planActionDisabled={false}
      onExecutePlan={() => undefined}
    />,
  );

  assert.match(markup, /生成 write_files 参数 19,368 字符 · 12\.3s/u);
});
