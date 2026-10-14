import type { EvalReport } from "@/evals/runner";

export function summarizeEvalReport(report: EvalReport): string {
  const lines = [
    `# Agent 评测摘要`,
    "",
    `模型：${report.providerId}；设置版本：${report.sourceSettingsRevision}；Fixture 版本：${report.fixtureVersion}`,
    `代码摘要：${report.codeFingerprint}；模型配置摘要：${report.providerFingerprint}`,
    `用例：${report.cases.join("、")}；每例 ${report.repeat} 次；单次上限 ${report.timeoutMs} ms / ${report.maxIterations} 轮。`,
    "",
    "| 用例 | 次数 | 执行完成 | 外部通过 | 外部失败 | 授权阻塞 | 待人工/证据不足 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const id of report.cases) {
    const items = report.runs.filter((run) => run.caseId === id);
    lines.push(`| ${id} | ${items.length} | ${items.filter((run) => run.outcome === "completed").length} | ${items.filter((run) => run.acceptance.status === "passed").length} | ${items.filter((run) => run.acceptance.status === "failed").length} | ${items.filter((run) => run.acceptance.status === "blocked").length} | ${items.filter((run) => run.acceptance.status === "indeterminate").length} |`);
  }
  lines.push("", "执行结果与外部验收独立统计；E1 的自动事实核对不能代替人工评分。缺失 usage 不计为零。", "", "| 用例/重复 | executionId | runId | 执行 | 验收 | 耗时 ms | 工具数 | Token 用量 | 验收依据 | 证据缺口 |", "| --- | --- | --- | --- | --- | ---: | ---: | --- | --- | --- |");
  for (const run of report.runs) {
    const usage = run.usage?.availability === "reported" ? String(run.usage.totalTokens) : "未知";
    lines.push(`| ${run.caseId}/${run.repeat} | ${run.executionId ?? "缺失"} | ${run.runId ?? "缺失"} | ${run.outcome} | ${run.acceptance.status} | ${run.durationMs} | ${run.toolCalls ?? "未知"} | ${usage} | ${run.acceptance.reason} | ${run.evidenceGap ?? "无"} |`);
  }
  return `${lines.join("\n")}\n`;
}

export function compareEvalConditions(before: EvalReport, after: EvalReport): readonly string[] {
  const differences: string[] = [];
  if (before.codeChangedDuringRun || after.codeChangedDuringRun) differences.push("执行过程中代码发生变化");
  if (before.fixtureVersion !== after.fixtureVersion) differences.push("用例或验收版本不同");
  if (before.providerFingerprint !== after.providerFingerprint) differences.push("模型配置不同");
  if (before.maxIterations !== after.maxIterations || before.timeoutMs !== after.timeoutMs) differences.push("执行预算不同");
  if (before.repeat !== after.repeat || [...before.cases].sort().join(",") !== [...after.cases].sort().join(",")) differences.push("用例或重复次数不同");
  return differences;
}
