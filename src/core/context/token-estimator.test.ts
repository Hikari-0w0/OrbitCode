import assert from "node:assert/strict";
import test from "node:test";

import {
  TokenEstimator,
  approximateTextTokens,
} from "@/core/context/token-estimator";

test("usage 锚点只对后续内容计算近似增量", () => {
  const estimator = new TokenEstimator();
  const initial = [{ role: "user", content: "hello" }] as const;
  const before = estimator.estimate(initial, []);
  assert.equal(before.source, "approximation");

  estimator.recordUsage(100, initial, []);
  const anchored = estimator.estimate(initial, []);
  assert.deepEqual(anchored, {
    source: "usage-anchor",
    tokens: 100,
    anchorPromptTokens: 100,
    estimatedDeltaTokens: 0,
  });

  const after = estimator.estimate(
    [...initial, { role: "assistant", content: "新增内容" }],
    [],
  );
  assert.equal(after.source, "usage-anchor");
  assert.ok(after.tokens > 100);
});

test("字符与 UTF-8 字节估算对中英文都给出正数", () => {
  assert.equal(approximateTextTokens(""), 0);
  assert.equal(approximateTextTokens("abcd"), 1);
  assert.ok(approximateTextTokens("上下文管理") >= 3);
});
