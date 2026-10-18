import assert from "node:assert/strict";
import test from "node:test";

import { CompletionTracker } from "@/core/completion-tracker";
import { successfulToolResult } from "@/tools/registry";
import { createReportCompletionTool } from "@/tools/report-completion";
import { createWorkspaceBoundary } from "@/tools/workspace";

test("完成报告工具严格校验字段并返回运行时评估", async () => {
  const tracker = new CompletionTracker();
  tracker.record({
    call: { id: "test-1", name: "run_command", argumentsJson: "{}" },
    result: successfulToolResult({}),
    iteration: 1,
    sequence: 0,
    mutability: "command",
  });
  const tool = createReportCompletionTool(tracker);
  assert.equal(tool.prepareUnknown({
    status: "complete",
    checks: [],
    blockers: [],
    extra: true,
  }).kind, "failure");
  const workspace = await createWorkspaceBoundary(process.cwd());
  const result = await tool.execute({
    status: "complete",
    checks: [{
      criterion: "测试通过",
      status: "passed",
      evidence_call_ids: ["test-1"],
    }],
    blockers: [],
  }, {
    workspace,
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 1_000,
  });
  assert.equal(result.ok, true);
  if (
    !result.ok ||
    result.output === null ||
    typeof result.output !== "object" ||
    Array.isArray(result.output)
  ) assert.fail("完成报告应返回对象");
  assert.equal("status" in result.output ? result.output.status : undefined, "verified");
});

test("模型无需提交汇总状态，旧 complete 不能覆盖 not-run", async () => {
  const tracker = new CompletionTracker();
  const tool = createReportCompletionTool(tracker);
  const workspace = await createWorkspaceBoundary(process.cwd());
  for (const status of [undefined, "complete"] as const) {
    const input = {
      ...(status === undefined ? {} : { status }),
      checks: [{ criterion: "浏览器交互", status: "not-run" as const, evidence_call_ids: [] }],
      blockers: [],
    };
    assert.equal(tool.prepareUnknown(input).kind, "ready");
    const result = await tool.execute(input, {
      workspace, signal: new AbortController().signal, deadlineMs: Date.now() + 1_000,
    });
    assert.equal(result.ok, true);
    assert.equal(tracker.assessment().status, "partial");
  }
});
