import assert from "node:assert/strict";
import test from "node:test";

import { parseSummaryEnvelope } from "@/core/context/summary-parser";

const VALID = {
  analysisDraft: "先梳理事实。",
  summary: {
    taskGoals: ["实现上下文管理"],
    completedWork: [],
    keyDecisions: [],
    fileChanges: [],
    toolResults: [],
    errors: [],
    nextSteps: ["继续开发"],
  },
};

test("严格解析七节摘要并丢弃分析草稿", () => {
  const summary = parseSummaryEnvelope(JSON.stringify(VALID));
  assert.equal("analysisDraft" in summary, false);
  assert.deepEqual(summary.taskGoals, ["实现上下文管理"]);
});

test("拒绝未知字段、缺失章节和 Markdown 包裹", () => {
  assert.throws(() => parseSummaryEnvelope(`\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\``));
  assert.throws(() => parseSummaryEnvelope(JSON.stringify({ ...VALID, extra: true })));
  const invalid = structuredClone(VALID);
  delete (invalid.summary as Partial<typeof VALID.summary>).errors;
  assert.throws(() => parseSummaryEnvelope(JSON.stringify(invalid)));
});
