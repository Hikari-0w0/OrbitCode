import assert from "node:assert/strict";
import test from "node:test";

import { compareEvalConditions, summarizeEvalReport } from "@/evals/report";
import type { EvalReport } from "@/evals/runner";

test("报告保留失败分母、人工不确定项与缺失用量", () => {
  const report: EvalReport = { schemaVersion: 1, fixtureVersion: 1, createdAt: "2026-01-01T00:00:00Z", providerId: "test",
    codeFingerprint: "code-a", providerFingerprint: "provider-a", codeChangedDuringRun: false,
    sourceSettingsRevision: 1, maxIterations: 4, timeoutMs: 1000, cases: ["E1", "E2"], repeat: 1,
    runs: [
      { caseId: "E1", repeat: 1, executionId: "a", runId: "b", outcome: "completed", exitCode: 0,
        acceptance: { status: "indeterminate", reason: "人工核对" }, durationMs: 100, evidenceDirectory: "/tmp/a",
        stopReason: "final-response", verification: null, persistence: null, toolCalls: 1, usage: null },
      { caseId: "E2", repeat: 1, executionId: "c", runId: null, outcome: "failed", exitCode: 1,
        acceptance: { status: "failed", reason: "外部测试失败" }, durationMs: 150, evidenceDirectory: "/tmp/b",
        stopReason: null, verification: null, persistence: null, toolCalls: null, usage: null, evidenceGap: "日志缺失" },
    ] };
  const summary = summarizeEvalReport(report);
  assert.match(summary, /\| E1 \| 1 \| 1 \| 0 \| 0 \| 0 \| 1 \|/);
  assert.match(summary, /\| E2 \| 1 \| 0 \| 0 \| 1 \| 0 \| 0 \|/);
  assert.match(summary, /未知/);
  assert.match(summary, /日志缺失/);
  assert.deepEqual(compareEvalConditions(report, { ...report, codeFingerprint: "candidate-code" }), []);
  assert.deepEqual(compareEvalConditions(report, { ...report, fixtureVersion: 2 }), ["用例或验收版本不同"]);
  assert.deepEqual(compareEvalConditions(report, { ...report, providerFingerprint: "provider-b" }), ["模型配置不同"]);
});
