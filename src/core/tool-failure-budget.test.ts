import assert from "node:assert/strict";
import test from "node:test";

import { ToolFailureBudget } from "@/core/tool-failure-budget";
import type { ModelToolCall } from "@/models/provider";
import { successfulToolResult, } from "@/tools/registry";
import { toolFailure } from "@/tools/types";

function call(argumentsJson = '{"path":"a"}'): ModelToolCall {
  return { id: crypto.randomUUID(), name: "write_file", argumentsJson };
}

test("精确重复失败先要求切换方案，达到预算后停止", () => {
  const budget = new ToolFailureBudget();
  const repeated = call();
  const failure = toolFailure("invalid-arguments", "参数无效", {
    retryable: true,
    issues: [{ path: "content", message: "缺少字段" }],
  });

  assert.equal(budget.observe(repeated, failure).action, "continue");
  assert.equal(budget.observe(repeated, failure).action, "switch");
  assert.equal(budget.observe(repeated, failure).action, "switch");
  assert.equal(budget.observe(repeated, failure).action, "stop");
});

test("参数轻微变化仍受同工具同类预算约束", () => {
  const budget = new ToolFailureBudget();
  const failure = toolFailure("command-failed", "命令失败", { retryable: true });
  const actions = Array.from({ length: 5 }, (_, index) =>
    budget.observe(call(`{"attempt":${index}}`), failure).action
  );
  assert.deepEqual(actions, ["continue", "continue", "switch", "switch", "stop"]);
});

test("成功替代方案解除对应工具熔断且不记录参数原文", () => {
  const budget = new ToolFailureBudget();
  const failure = toolFailure("invalid-arguments", "参数无效", { retryable: true });
  const sensitive = call('{"content":"never-log-this"}');
  budget.observe(sensitive, failure);
  assert.equal(budget.observe(sensitive, failure).action, "switch");
  assert.equal(
    budget.observe(call('{"content":"fixed"}'), successfulToolResult({})).action,
    "continue",
  );
  assert.equal(budget.observe(sensitive, failure).action, "continue");
  assert.equal(JSON.stringify(budget).includes("never-log-this"), false);
});

test("用户拒绝、取消和未知工具不消耗失败预算", () => {
  const budget = new ToolFailureBudget();
  const repeated = call();
  for (const kind of ["user-denied", "cancelled", "unknown-tool"] as const) {
    for (let count = 0; count < 8; count += 1) {
      assert.equal(budget.observe(repeated, toolFailure(kind, "忽略")).action, "continue");
    }
  }
});
