import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadProviderContext, resolveRuntimeProvider } from "@/runtime/config";
import { realSubAgentFixture, scrubCredential } from "./evals/sub-agent-real-fixture";
import { assertTaskTiming } from "./evals/assert-task-timing";

async function main() {
  if (!process.argv.includes("--allow-real-model")) throw new Error("必须显式授权真实模型。");
  const root = process.argv.find(value => value.startsWith("--root="))?.slice(7);
  if (!root) throw new Error("需要新的证据目录。");
  const base = path.resolve(root); await mkdir(base, { mode: 0o700 });
  const configuration = await loadProviderContext(), source = resolveRuntimeProvider(configuration, configuration.defaultProviderId ?? configuration.providers[0].name);
  const results: { name: string; status: "passed" | "failed"; root?: string; error?: string }[] = [];
  for (const [name, limit] of [["parent-budget", 1], ["shared-budget", 3]] as const) {
    const result: typeof results[number] = { name, status: "failed" };
    let fixture: Awaited<ReturnType<typeof realSubAgentFixture>> | undefined;
    const heartbeat = setInterval(() => console.log(JSON.stringify({ event: "running", name })), 30000);
    try {
      fixture = await realSubAgentFixture(base, name, source, { "evidence.txt": "REAL_BUDGET_EVIDENCE_20261021" }, false, { groupRequests: limit }); result.root = fixture.root;
      await fixture.run(name === "parent-budget" ? "只用read_file读取evidence.txt，再根据真实结果报告原文；不修改文件，不使用其他工具。"
        : "实际只创建1个defined后台子任务role=reader。子任务先调用read_file读取evidence.txt，再报告真实原文。父只创建、等待、汇总，不代做文件读取，不创建额外任务。", name === "parent-budget" ? "collaborate" : "delegate-only", name === "parent-budget" ? undefined : "defined");
      const tasks = await fixture.settle(), usage = await fixture.usage(), checkpoint = await fixture.checkpoint();
      tasks.forEach(assertTaskTiming);
      await fixture.save("budget-assessment.json", { tasks, usage, checkpoint, model: source.model });
      assert.equal(usage.requestBudgets.length, 1); const budget = usage.requestBudgets[0];
      assert.equal(budget.limit, limit); assert.equal(budget.admittedAttempts, limit); assert.ok(budget.rejectedRequests > 0); assert.equal(budget.inFlight, 0);
      const requests = (await readdir(fixture.root)).filter(file => /^request-\d+\.json$/.test(file));
      assert.ok(requests.length <= limit); assert.ok(budget.reportedRequests + budget.missingUsageRequests === budget.logicalRequests);
      if (name === "parent-budget") {
        assert.equal(tasks.length, 0); assert.equal(checkpoint.summary.lastStopReason, "model-error");
        assert.ok(fixture.calls.some(call => call.call.name === "read_file"));
      } else {
        assert.equal(tasks.length, 1); assert.equal(tasks[0].admission?.requestBudget.id, budget.id);
        assert.ok(tasks[0].state.status === "terminal" && tasks[0].state.result.cleanup === "complete");
        assert.ok(checkpoint.summary.lastStopReason === "model-error" || tasks[0].state.status === "terminal" && tasks[0].state.result.stopReason === "model-error");
      }
      const independent = await fixture.independent("import assert from 'node:assert/strict';import{readFileSync}from 'node:fs';assert.equal(readFileSync('evidence.txt','utf8'),'REAL_BUDGET_EVIDENCE_20261021');");
      assert.equal(independent.exitCode, 0); result.status = "passed";
    } catch (error) { result.error = scrubCredential(String(error), source); }
    finally {
      if (fixture) try { await fixture.close(); } catch { result.status = "failed"; result.error = "清理失败"; }
      clearInterval(heartbeat); results.push(result); await writeFile(path.join(base, "results.json"), JSON.stringify(results, null, 2)); console.log(JSON.stringify(result));
    }
  }
  if (results.some(result => result.status === "failed")) process.exitCode = 1;
}
void main().catch(() => { console.error("预算评测未完成，未输出原始异常或凭据。"); process.exitCode = 1; });
