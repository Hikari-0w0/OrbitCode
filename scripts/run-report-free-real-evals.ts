import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadProviderContext, resolveRuntimeProvider } from "@/runtime/config";
import { realSubAgentFixture, scrubCredential } from "./evals/sub-agent-real-fixture";
import { realWebSubAgentFixture } from "./evals/sub-agent-web-fixture";

const repair = "先用run_command执行node check.mjs观察原始失败，再读取calc.mjs和check.mjs，修复calc.mjs：ratio为除法且除零抛错，cents返回Math.round(price*qty*100)。不得改check.mjs。修复后重复同一命令复验，保留原始退出码。完成必要检查后直接说明事实、失败历史和未验证范围。";
const initialFiles = { "calc.mjs": "export function ratio(a,b){return a*b;}\nexport function cents(price,qty){return Math.round(price)*qty*100;}\n", "check.mjs": "import assert from 'node:assert/strict';import{ratio,cents}from './calc.mjs';assert.equal(ratio(12,3),4);assert.throws(()=>ratio(1,0));assert.equal(cents(1.25,3),375);" };

async function main(): Promise<void> {
  const args = process.argv.slice(2), option = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (!args.includes("--allow-real-model")) throw new Error("需要显式允许真实模型。");
  const requestedRoot = option("root"), selected = option("case") ?? "all", repeat = Number(option("repeat") ?? "1"), transport = option("transport") ?? "cli";
  const names = ["direct", "delegated", "legacy-skill", "legacy-role", "legacy-history"];
  const cases = selected === "all" ? names : names.filter(name => name === selected);
  if (!requestedRoot || !cases.length || !["cli", "web"].includes(transport) || !Number.isSafeInteger(repeat) || repeat < 1 || repeat > 10) throw new Error("参数无效。");
  if (transport === "web" && cases.some(name => name !== "direct" && name !== "delegated")) throw new Error("Web入口本轮支持direct/delegated，历史注入仅用于CLI夹具。");
  const base = path.resolve(requestedRoot);
  await mkdir(path.dirname(base), { recursive: true }); await mkdir(base, { mode: 0o700 });
  const context = await loadProviderContext(), source = resolveRuntimeProvider(context, option("provider") ?? context.defaultProviderId ?? context.providers[0].name);
  await writeFile(path.join(base, "metadata.json"), JSON.stringify({ startedAt: new Date().toISOString(), model: source.model, origin: new URL(source.baseUrl).origin, cases, repeat, transport }, null, 2));
  const results: { name: string; status: "passed" | "failed"; root?: string; error?: string }[] = [];
  for (let round = 1; round <= repeat; round++) for (const name of cases) {
    const sample = `${transport}-${name}-${round}`, result: typeof results[number] = { name: sample, status: "failed" };
    console.log(JSON.stringify({ event: "start", sample }));
    const heartbeat = setInterval(() => console.log(JSON.stringify({ event: "running", sample })), 30000);
    let fixture: Awaited<ReturnType<typeof realSubAgentFixture>> | undefined;
    try {
      const legacy = { ".orbitcode/skills/legacy/SKILL.md": "---\nname: legacy\ndescription: 旧工具列表兼容\nallowed-tools: [read_file, edit_file, run_command, report_completion]\nmode: shared\n---\n" + repair, ".orbitcode/agents/legacy.md": "---\nname: legacy\ndescription: 旧角色工具列表兼容\nallowed-tools: [read_file, edit_file, run_command, report_completion]\ndisallowed-tools: [agent]\nmodel: inherit\nmax-iterations: 16\npermission-mode: permissive\n---\n" + repair };
      fixture = transport === "web" ? await realWebSubAgentFixture(base, sample, source, initialFiles, { serverMode: "start" }) : await realSubAgentFixture(base, sample, source, { ...initialFiles, ...legacy });
      result.root = fixture.root;
      if (name === "legacy-history") await fixture.seedHistory([{ kind: "user", content: "旧阶段已完成，以下只作为历史记录。" }, { kind: "assistant-tool-call", content: null, toolCalls: [{ id: "legacy-report", name: "report_completion", argumentsJson: '{"checks":[],"blockers":[]}' }] }, { kind: "tool-result", toolCallId: "legacy-report", payload: { storage: "inline", content: '{"ok":true,"output":{"status":"verified","checks":[],"blockers":[]},"sideEffect":"none"}' } }, { kind: "assistant", content: "旧阶段完成。新阶段只使用当前提供的工具。" }]);
      const delegated = name === "delegated" || name === "legacy-role";
      const prompt = delegated ? `使用agent创建一个defined后台子任务，role=${name === "legacy-role" ? "legacy" : "builder"}，子prompt=${repair} 父不要修改文件，wait至终态后根据工具事实总结。` : name === "legacy-skill" ? "先实际调用load_skill加载legacy并执行其指令，不委派。" : repair;
      await fixture.run(prompt);
      const tasks = await fixture.settle();
      await fixture.save("tasks.json", tasks);
      assert.equal(tasks.length, delegated ? 1 : 0);
      if (delegated) { assert.equal(tasks[0].state.status, "terminal"); if (tasks[0].state.status !== "terminal") throw new Error("未终止"); assert.equal(tasks[0].state.result.stopReason, "final-response"); assert.equal(tasks[0].state.result.handoff?.completionReports, undefined); }
      assert.equal(await readFile(path.join(fixture.workspace, "check.mjs"), "utf8"), initialFiles["check.mjs"]);
      const independent = await fixture.independent("import assert from 'node:assert/strict';import{ratio,cents}from './calc.mjs';for(const[a,b]of [[12,3],[-9,3],[0,5],[1,4]])assert.equal(ratio(a,b),a/b);assert.throws(()=>ratio(1,0));for(const[p,q]of [[1.25,3],[0.99,7],[10.005,2]])assert.equal(cents(p,q),Math.round(p*q*100));");
      assert.equal(independent.exitCode, 0);
      const checkpoint = await fixture.checkpoint(), parentRuns = await fixture.log.findAllForConversation(checkpoint.summary.id), childRuns = delegated ? await fixture.log.findAllForConversation(tasks[0].id) : [];
      const runs = [...parentRuns, ...childRuns];
      assert.ok(!runs.flatMap(run => run.tools).some(tool => tool.name === "report_completion"));
      const work = (delegated ? childRuns : parentRuns).flatMap(run => run.tools).filter(tool => tool.name === "run_command");
      assert.ok(work.length >= 2 && work[0].status === "failed" && work.at(-1)?.status === "succeeded");
      if (name === "legacy-skill") assert.ok(fixture.calls.some(item => item.call.name === "load_skill"));
      await fixture.save("assessment.json", { independent, runs, finalReply: checkpoint.context.messages.findLast(message => message.kind === "assistant")?.content, reportToolCalls: 0 });
      result.status = "passed";
    } catch (error) { result.error = scrubCredential(error instanceof Error ? error.message : "评测失败", source); }
    finally { try { if (fixture) await fixture.close(); } catch { result.status = "failed"; result.error = "清理或证据保存失败。"; } clearInterval(heartbeat); results.push(result); await writeFile(path.join(base, "results.json"), JSON.stringify(results, null, 2)); console.log(JSON.stringify({ event: "finished", ...result })); }
  }
  let filesScanned = 0, credentialMatches = 0;
  const scan = async (directory: string): Promise<void> => { for (const entry of await readdir(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) await scan(file); else if (entry.isFile()) { filesScanned++; if (source.apiKey && (await readFile(file)).includes(Buffer.from(source.apiKey))) credentialMatches++; } } };
  await scan(base); await writeFile(path.join(base, "summary.json"), JSON.stringify({ results, filesScanned, credentialMatches }, null, 2));
  if (credentialMatches || results.some(result => result.status === "failed")) process.exitCode = 1;
}
void main().catch(() => { console.error("评测启动失败；检查参数、现有配置和新的隔离目录。未输出原始异常或凭据。"); process.exitCode = 1; });
