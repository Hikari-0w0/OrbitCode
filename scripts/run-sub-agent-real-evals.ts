import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadProviderContext, resolveRuntimeProvider } from "@/runtime/config";
import { realSubAgentFixture, scrubCredential } from "./evals/sub-agent-real-fixture";
import { requirements, acceptance } from "./evals/sub-agent-code-contract";

type Fixture = Awaited<ReturnType<typeof realSubAgentFixture>>;
type Result = { name: string; root?: string; status: "passed" | "failed"; error?: string };
const delegate = (kind: "defined" | "fork", prompt: string, role = "reader") => `这是一项已授权的委派验收，请严格执行：只用统一 agent 工具 operation=start 创建 1 个 ${kind} 子任务${kind === "defined" ? `，role=${role}` : ""}，background=true。子任务 prompt 为：${prompt}。你不要代替子 Agent 做本地工具操作。创建后使用 agent wait 等待该 ID（每次 timeoutMs=30000，可重复等待），直到完成后依据结构化结果给出简短事实；禁止把模型最终文本当成通过。`;

async function fork(f: Fixture): Promise<void> {
  const marker = `FICTIONAL_PARENT_${randomUUID().slice(0, 8)}`;
  await f.run(`本轮只回复 ACK，不使用任何工具。记住这个虚构测试标记供后续会话使用：${marker}`);
  await f.run(delegate("fork", "不要读取任何文件，直接报告在继承的会话历史里是否有 FICTIONAL_PARENT_ 开头的标记。能看到则原样写出；看不到仅回复 UNKNOWN。") + " 重要：子 prompt 不得包含该标记的实际值，也不要把父历史手工概括进子 prompt。");
  const tasks = await f.settle();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].kind, "fork");
  assert.equal(tasks[0].state.status, "terminal");
  if (tasks[0].state.status !== "terminal") throw new Error("没有终态");
  assert.equal(tasks[0].state.result.stopReason, "final-response");
  assert.ok(tasks[0].state.result.finalReply?.includes(marker), "原始Fork检索正确返回历史标记");
  const start = f.calls.find(item => !item.child && item.call.name === "agent" && JSON.parse(item.call.argumentsJson).operation === "start");
  assert.ok(start && !start.call.argumentsJson.includes(marker), "父未把答案直接传给子任务");
}

async function offload(f: Fixture): Promise<void> {
  await f.run("先read_file读取large.txt，然后创建一个fork后台子Agent，子prompt=从继承的上下文工具结果中定位并报告 CONTEXT_MIGRATION_PROOF_ 开头的完整标记，优先用read_context读取迁移后的引用，禁止重新read_file或run_command。子prompt不可包含标记完整值。父等待其完成，不代替子查找标记。");
  const tasks = await f.settle();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].kind, "fork");
  assert.ok(f.calls.some(item => item.child && item.call.name === "read_context"));
  assert.ok(!f.calls.some(item => item.child && ["read_file", "run_command"].includes(item.call.name)), "子只通过迁移引用检索");
  assert.equal(tasks[0].state.status, "terminal");
  if (tasks[0].state.status !== "terminal") throw new Error("没有终态");
  assert.ok(tasks[0].state.result.finalReply?.includes("CONTEXT_MIGRATION_PROOF_740"));
  assert.equal(tasks[0].state.result.stopReason, "final-response");
}

async function collaboration(f: Fixture): Promise<void> {
  await f.run("读取 requirements.md，然后必须用 agent 创建3个独立定义式子任务，均background=true：builder A实现pricing.mjs，builder B实现stock.mjs，reader C审阅requirements.md提出边界检查建议（不改文件）。先创建全部3个再等待。每个builder把完整契约放进其子prompt，因为定义式空历史。父不能实现或修改两个子模块，只负责index.mjs转导出、等待子结果、最后run_command node check.mjs做真实集成验证。对子结果失败或未验证如实说明，不用模型声明替代测试。");
  const tasks = await f.settle();
  const independent = await f.independent(acceptance);
  await f.save("collaboration-assessment.json", { artifactPassed: independent.exitCode === 0, parentCalls: f.calls.filter(item => !item.child), tasks });
  assert.equal(independent.exitCode, 0, "独立23项契约断言通过");
  assert.equal(tasks.length, 3);
  assert.ok(tasks.every(task => task.state.status === "terminal" && task.state.result.stopReason === "final-response"), "三个子任务均正常终止");
  const parentWrites = f.calls.filter(item => !item.child && ["write_file", "write_files", "edit_file"].includes(item.call.name));
  assert.ok(parentWrites.every(item => {
    const input: { path?: string; files?: { path: string }[] } = JSON.parse(item.call.argumentsJson);
    const paths = input.files?.map(file => file.path) ?? [input.path ?? ""];
    return paths.every(file => !["pricing.mjs", "stock.mjs"].includes(path.posix.normalize(file)));
  }), "父未用文件工具改动明确禁止接管的子模块；命令副作用须结合哈希另行复核");
}

async function repair(f: Fixture): Promise<void> {
  await f.run(delegate("defined", "必须先run_command执行 node check.mjs 原样观察失败，再读取并修复calc.mjs：ratio为除法且除零抛错，cents返回Math.round(price*qty*100)；不得改check.mjs。修复后同一命令复验，记录原始退出码和工具证据。", "builder"));
  const tasks = await f.settle();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].state.status, "terminal");
  if (tasks[0].state.status !== "terminal") throw new Error("没有终态");
  const handoff = tasks[0].state.result.handoff;
  assert.ok(handoff && handoff.commandCalls.failed > 0 && handoff.commandCalls.succeeded > 0, "运行时交接保留失败及恢复");
  assert.equal(handoff.commandCalls.results[0].exitCode, 1);
  assert.equal(handoff.commandCalls.results.at(-1)?.exitCode, 0);
  assert.ok(handoff.fileWrites.paths.includes("calc.mjs"));
  const result = await f.independent("import assert from 'node:assert/strict';import{ratio,cents}from './calc.mjs';for(const[a,b]of [[12,3],[-9,3],[0,5],[1,4]])assert.equal(ratio(a,b),a/b);assert.throws(()=>ratio(1,0));for(const[p,q]of [[1.25,3],[0.99,7],[10.005,2]])assert.equal(cents(p,q),Math.round(p*q*100));");
  assert.equal(result.exitCode, 0);
  const original = "import assert from 'node:assert/strict';import {ratio,cents} from './calc.mjs';assert.equal(ratio(12,3),4);assert.throws(()=>ratio(1,0));assert.equal(cents(1.25,3),375);console.log('VISIBLE_FIXED');";
  assert.equal(await readFile(path.join(f.workspace, "check.mjs"), "utf8"), original, "验收脚本未被修改");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const option = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (!args.includes("--allow-real-model")) throw new Error("必须显式提供 --allow-real-model。");
  const requestedRoot = option("root");
  if (!requestedRoot) throw new Error("必须提供 --root=<新的隔离目录>；不覆盖已有结果。");
  const suite = option("suite") ?? "all", repeat = Number(option("repeat") ?? "1");
  const selected = suite === "all" ? ["fork", "offload", "collaboration", "repair"] : [suite];
  if (!selected.every(item => ["fork", "offload", "collaboration", "repair"].includes(item)) || !Number.isSafeInteger(repeat) || repeat < 1 || repeat > 10) throw new Error("suite 或 repeat 无效。");
  const base = path.resolve(requestedRoot);
  await mkdir(path.dirname(base), { recursive: true });
  await mkdir(base, { mode: 0o700 });
  const context = await loadProviderContext();
  const source = resolveRuntimeProvider(context, option("provider") ?? context.defaultProviderId ?? context.providers[0].name);
  const results: Result[] = [];
  const hashes: Record<string, string> = {};
  for (const file of ["src/runtime/agents/child-instructions.ts", "src/runtime/child-execution/handoff.ts", "src/core/context/context-read-payload.ts", "src/runtime/child-execution/runner.ts", "src/runtime/child-result-delivery.ts", "src/tools/read-context.ts", "src/core/system-prompt/action-execution.ts"]) hashes[file] = createHash("sha256").update(await readFile(file)).digest("hex");
  await writeFile(path.join(base, "metadata.json"), JSON.stringify({ startedAt: new Date().toISOString(), hashes, model: source.model, origin: new URL(source.baseUrl).origin, suite, repeat, parentIterations: 24, childIterations: 20, maxOutputTokens: 8192, baseline: "sub-agents-real-20261019 原任务/原预算；本轮使用新的实现提示与交接" }, null, 2));
  for (let round = 1; round <= repeat; round++) for (const name of selected) {
    const sample = `${name}-${round}`;
    console.log(JSON.stringify({ event: "start", sample }));
    const heartbeat = setInterval(() => console.log(JSON.stringify({ event: "running", sample })), 30000);
    let f: Fixture | undefined;
    const result: Result = { name: sample, status: "failed" };
    try {
      const files: Record<string, string> = name === "offload" ? { "large.txt": Array.from({ length: 900 }, (_, i) => `row-${i}: ${"payload".repeat(10)}${i === 740 ? " CONTEXT_MIGRATION_PROOF_740" : ""}`).join("\n") } : name === "repair" ? { "calc.mjs": "export function ratio(a,b){return a*b;}\nexport function cents(price,qty){return Math.round(price)*qty*100;}\n", "check.mjs": "import assert from 'node:assert/strict';import {ratio,cents} from './calc.mjs';assert.equal(ratio(12,3),4);assert.throws(()=>ratio(1,0));assert.equal(cents(1.25,3),375);console.log('VISIBLE_FIXED');" } : name === "collaboration" ? { "requirements.md": requirements, "check.mjs": "import {quote,Stock} from './index.mjs';import assert from 'node:assert/strict';assert.equal(quote([{sku:'A',quantity:2,unitCents:100}]).totalCents,200);assert.equal(new Stock({A:3}).reserve('one','A',2),true);console.log('VISIBLE_PASS');" } : {};
      f = await realSubAgentFixture(base, sample, source, files, name === "offload");
      result.root = f.root;
      await ({ fork, offload, collaboration, repair }[name] ?? fork)(f);
      result.status = "passed";
    } catch (error) { result.error = scrubCredential(error instanceof Error ? error.message : "评测失败", source); }
    finally {
      try { if (f) { await f.save("tasks.json", await f.tasks()); await f.close(); } }
      catch (error) { result.status = "failed"; result.error = `${result.error ?? ""} 清理/证据失败：${scrubCredential(String(error), source)}`; }
      clearInterval(heartbeat);
      results.push(result);
      await writeFile(path.join(base, "results.json"), JSON.stringify(results, null, 2));
      console.log(JSON.stringify({ event: "finished", ...result }));
    }
  }
  let credentialMatches = 0, filesScanned = 0;
  const scan = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await scan(file);
      else if (entry.isFile()) { filesScanned++; if (source.apiKey && (await readFile(file)).includes(Buffer.from(source.apiKey))) credentialMatches++; }
    }
  };
  await scan(base);
  await writeFile(path.join(base, "summary.json"), JSON.stringify({ results, credentialMatches, filesScanned, hashes, finishedAt: new Date().toISOString() }, null, 2));
  if (credentialMatches || results.some(result => result.status !== "passed")) process.exitCode = 1;
}

void main().catch(() => { console.error("评测启动失败；检查显式参数、现有模型配置和隔离目录。未输出凭据或原始异常。"); process.exitCode = 1; });
