import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { ContextCompressionControl } from "@/components/context-compression-control";

test("手动压缩控件展示估算来源、前后数值与 aria-live", () => {
  const markup = renderToStaticMarkup(
    <ContextCompressionControl
      state={{
        status: "succeeded",
        trigger: "manual",
        before: {
          source: "usage-anchor",
          tokens: 18_000,
          anchorPromptTokens: 17_000,
          estimatedDeltaTokens: 1_000,
        },
        after: { source: "approximation", tokens: 6_000 },
      }}
      disabled={false}
      onCompress={() => undefined}
    />,
  );
  assert.match(markup, /aria-live="polite"/);
  assert.match(markup, /18,000 Token（usage 锚点估算）/);
  assert.match(markup, /6,000 Token（字符近似）/);
});

test("熔断状态仍保留可手动恢复按钮并显示失败原因", () => {
  const markup = renderToStaticMarkup(
    <ContextCompressionControl
      state={{
        status: "circuit-open",
        trigger: "manual",
        before: { source: "approximation", tokens: 19_000 },
        failure: { kind: "summary-protocol", message: "摘要响应不完整。" },
        consecutiveSummaryFailures: 3,
      }}
      disabled={false}
      onCompress={() => undefined}
    />,
  );
  assert.doesNotMatch(markup, /disabled=""/);
  assert.match(markup, /自动压缩已熔断/);
  assert.match(markup, /摘要响应不完整/);
});
