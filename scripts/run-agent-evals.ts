import { randomUUID } from "node:crypto";
import path from "node:path";

import { CASE_IDS, type CaseId } from "@/evals/fixtures";
import { runAgentEvals } from "@/evals/runner";

const HELP = `用法：npm run eval:agent -- --provider <id> --cases E1,E2 --repeat <次数> --timeout-ms <每次毫秒> --max-iterations <轮数> [--output <目录>]
真实评测会调用所选托管模型；结果与隔离工作区保存在忽略的 tmp/agent-evals 下。\n`;

async function main(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && argv[0] === "--help") { process.stdout.write(HELP); return; }
  const values = new Map<string, string>();
  const names = new Set(["--provider", "--cases", "--repeat", "--timeout-ms", "--max-iterations", "--output"]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!names.has(name) || !value || value.startsWith("--") || values.has(name)) throw new Error(`参数无效或重复：${name}`);
    values.set(name, value);
  }
  for (const name of ["--provider", "--cases", "--repeat", "--timeout-ms", "--max-iterations"])
    if (!values.has(name)) throw new Error(`缺少必填参数 ${name}；真实评测不会启动。`);
  const cases = values.get("--cases")!.split(",");
  if (!cases.length || cases.some((item) => !CASE_IDS.includes(item as CaseId)) || new Set(cases).size !== cases.length) throw new Error("--cases 包含无效或重复用例。");
  const number = (name: string) => {
    const value = values.get(name)!;
    if (!/^[1-9]\d*$/.test(value)) throw new Error(`${name} 必须是正整数。`);
    return Number(value);
  };
  const repeat = number("--repeat");
  const timeoutMs = number("--timeout-ms");
  const maxIterations = number("--max-iterations");
  const projectRoot = process.cwd();
  const outputDirectory = values.get("--output") ?? path.join(projectRoot, "tmp/agent-evals", `${Date.now()}-${randomUUID()}`);
  process.stderr.write(`计划运行 ${cases.length * repeat} 次；单次 ${timeoutMs} ms / ${maxIterations} 轮，外层时限上界约 ${Math.ceil((cases.length * repeat * (timeoutMs + 5_000)) / 60_000)} 分钟。\n`);
  const report = await runAgentEvals({ projectRoot, providerId: values.get("--provider")!, cases: cases as CaseId[], repeat,
    timeoutMs, maxIterations, outputDirectory });
  process.stdout.write(`${JSON.stringify({ report: path.join(outputDirectory, "report.json"), runs: report.runs.map((run) => ({
    caseId: run.caseId, repeat: run.repeat, executionId: run.executionId, runId: run.runId,
    outcome: run.outcome, acceptance: run.acceptance.status,
  })) })}\n`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "评测启动失败。"}\n`);
  process.exitCode = 2;
});
