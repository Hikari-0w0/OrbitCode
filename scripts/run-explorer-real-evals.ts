import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadProviderContext, resolveRuntimeProvider } from "@/runtime/config";
import { realSubAgentFixture, scrubCredential } from "./evals/sub-agent-real-fixture";
import { realWebSubAgentFixture } from "./evals/sub-agent-web-fixture";

const original = "请实际调用 agent 工具，创建 defined 子任务，角色 explorer。\n让它查找当前项目的 Agent 主循环入口，读取相关源码，说明执行流程并引用文件路径。\n主 Agent 不要自己完成这次源码探索，等待子任务结果后再总结。";
async function main() {
  const args = process.argv.slice(2), option = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (!args.includes("--allow-real-model") || !option("root")) throw new Error("需要新目录与真实模型授权。");
  const transport = option("transport") ?? "cli", repeat = Number(option("repeat") ?? 1), cases = (option("cases") ?? "defined,fork,recovery,budget").split(",");
  const parentMode=option("parent-mode");
  if(parentMode!==undefined&&parentMode!=="collaborate"&&parentMode!=="delegate-only")throw new Error("父级分工参数无效。");
  if (!["cli", "web"].includes(transport) || !Number.isSafeInteger(repeat) || repeat < 1 || repeat > 5 || !cases.every(name => ["defined", "fork", "recovery", "budget"].includes(name)) || transport === "web" && cases.some(name => name !== "defined")) throw new Error("参数无效；Web本批只测试defined。");
  const requestedRoot = option("root");
  if (!requestedRoot) throw new Error("缺少目录。");
  const base = path.resolve(requestedRoot);
  await mkdir(path.dirname(base), { recursive: true }); await mkdir(base, { mode: 0o700 });
  const context = await loadProviderContext(), source = resolveRuntimeProvider(context, option("provider") ?? context.defaultProviderId ?? context.providers[0].name);
  const files: Record<string, string> = {}, hashes: Record<string, string> = {};
  const collect = async (directory: string): Promise<void> => { for (const entry of await readdir(directory, { withFileTypes: true })) { const file = path.posix.join(directory, entry.name); if (entry.isDirectory()) await collect(file); else if (entry.isFile() && /\.(?:ts|tsx|md)$/.test(file)) files[file] = await readFile(file, "utf8"); } };
  await collect("src");
  for (const file of ["README.md", "package.json"]) files[file] = await readFile(file, "utf8");
  // 只读源码副本不带用户配置、密钥、生成目录或历史评测；保留内置角色的实际约束。
  const explorer = await readFile("agents/explorer.md", "utf8");
  files[".orbitcode/agents/explorer.md"] = explorer;
  files[".orbitcode/agents/limited.md"] = explorer.replace("name: explorer", "name: limited").replace("max-iterations: 16", "max-iterations: 4");
  for (const [file, content] of Object.entries(files)) hashes[file] = createHash("sha256").update(content).digest("hex");
  await writeFile(path.join(base, "metadata.json"), JSON.stringify({ model: source.model, transport, cases, repeat, sourceHashes: hashes, note: "当前源码隔离副本；未复制tmp/node_modules/.next/用户配置，不冒充原工作区完整初态或严格性能A/B。" }, null, 2));
  const results: { name: string; status: "passed" | "failed"; root?: string; error?: string }[] = [];
  for (let round = 1; round <= repeat; round++) for (const name of cases) {
    const result: typeof results[number] = { name: `${transport}-${name}-${round}`, status: "failed" };
    console.log(JSON.stringify({ event: "start", name: result.name }));
    const heartbeat = setInterval(() => console.log(JSON.stringify({ event: "running", name: result.name })), 30000);
    let f: Awaited<ReturnType<typeof realSubAgentFixture>> | Awaited<ReturnType<typeof realWebSubAgentFixture>> | undefined;
    try {
      f = transport === "cli" ? await realSubAgentFixture(base, result.name, source, files) : await realWebSubAgentFixture(base, result.name, source, files, { serverMode: "start" });
      result.root = f.root;
      const prompt = name === "defined" ? original : name === "fork" ? original.replace("defined 子任务，角色 explorer", "fork 子任务，角色 explorer")
        : name === "recovery" ? "实际创建defined子任务，角色explorer，父不得代做。子任务：先故意用search_code的path=src/core/agent-loop.ts、query=AgentLoop复现文件当目录错误，只错这一次。根据工具错误纠正搜索参数，定位AgentLoop及其调用入口，读源码并引用路径说明流程。父等待终态后总结真实事实。"
          : "实际创建defined后台子任务，角色limited，父不代做。子任务：读取src/core/agent-loop.ts与src/runtime/agent-session-factory.ts，解释二者调用关系；只有4轮预算，优先获取证据并及时总结，未完成也交代范围。父等待终态后依据事实总结。";
      await f.run(prompt,parentMode);
      const tasks = await f.settle(); await f.save("tasks.json", tasks);
      assert.equal(tasks.length, 1); const task = tasks[0];
      assert.equal(task.kind, name === "fork" ? "fork" : "defined");
      if (task.state.status !== "terminal") throw new Error("子任务未结束");
      const child = task.state.result, reads = child.handoff?.reads;
      let completeReply=child.finalReply??"";
      if(child.replyTruncated&&child.replyStorage?.status==="saved") {
        completeReply="";let offset=0;
        for(;;){const page=await f.readReply(task.id,offset);completeReply+=page.content;if(page.nextOffset===null)break;offset=page.nextOffset;}
        assert.equal(Buffer.byteLength(completeReply),child.replyStorage.byteLength,"完整正文与持久化描述长度一致");
        assert.equal(createHash("sha256").update(completeReply).digest("hex"),child.replyStorage.sha256,"完整正文与持久化哈希一致");
      }
      assert.ok(reads);
      assert.ok(reads.files.some(file => file.path === "src/core/agent-loop.ts"), "工具确认读过主循环");
      assert.ok(reads.files.some(file => file.path.startsWith("src/runtime/")), "工具确认读过调用方");
      assert.equal(child.sideEffect, "none"); assert.equal(child.handoff?.fileWrites.paths.length, 0);
      const parentCheckpoint = await f.checkpoint();
      const parentLogs = await f.log.findAllForConversation(parentCheckpoint.summary.id);
      assert.ok(parentLogs.length > 0);
      assert.ok(!parentLogs.flatMap(run => run.tools).some(tool => ["read_file", "search_code", "find_files"].includes(tool.name)), "父未代做探索");
      if (name === "budget") assert.ok(["final-response", "max-iterations"].includes(child.stopReason));
      else {
        assert.equal(child.stopReason, "final-response");
        assert.ok(child.finalReply);
        assert.ok(completeReply.includes("src/core/agent-loop.ts") && completeReply.includes("AgentLoop"), "最终交付引用真实入口");
        assert.ok(completeReply.includes("src/runtime/"), "最终交付包含调用方来源");
      }
      if (name === "recovery") assert.ok(child.failures.some(failure => failure.targetFailureReason === "not-directory"));
      const logs = await f.log.findAllForConversation(task.id);
      assert.equal(logs.length, 1);
      if (name === "recovery") assert.ok(logs[0].tools.some(tool => tool.targetFailureReason === "not-directory" && tool.iteration));
      for (const item of reads.files) {
        assert.ok(Object.hasOwn(files, item.path) || ["AGENTS.md", "evidence.txt"].includes(item.path), "引用来自源码副本或夹具显式指令文件");
        const sourceContent: string = await readFile(path.join(f.workspace, item.path), "utf8");
        if (Object.hasOwn(files, item.path)) assert.equal(sourceContent, files[item.path], "已读源码未修改");
      }
      const checkpoint = await f.checkpoint();
      await f.save("assessment.json", { child, completeReply, childLog: logs[0], parentFinal: checkpoint.context.messages.findLast(message => message.kind === "assistant"), note: "断言覆盖入口、调用方、工具读取、角色边界及终止；截断摘要须通过实际分页读取恢复正文并核验哈希，来源断言不放宽。流程文字仍须人工审阅，不等于自动证明架构解释完整正确。" });
      assert.ok(!logs[0].tools.some(tool => tool.name === "report_completion"));
      result.status = "passed";
    } catch (error) { result.error = scrubCredential(error instanceof Error ? error.message : "评测失败", source); }
    finally { try { if (f) await f.close(); } catch { result.status = "failed"; result.error = "清理失败"; } clearInterval(heartbeat); results.push(result); await writeFile(path.join(base, "results.json"), JSON.stringify(results, null, 2)); console.log(JSON.stringify({ event: "finished", ...result })); }
  }
  let filesScanned = 0, credentialMatches = 0;
  const scan = async (dir: string): Promise<void> => { for (const entry of await readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await scan(file); else if (entry.isFile()) { filesScanned++; if (source.apiKey && (await readFile(file)).includes(Buffer.from(source.apiKey))) credentialMatches++; } } };
  await scan(base); await writeFile(path.join(base, "summary.json"), JSON.stringify({ results, filesScanned, credentialMatches }, null, 2));
  if (credentialMatches || results.some(result => result.status !== "passed")) process.exitCode = 1;
}
void main().catch(() => { console.error("评测启动失败；未输出原始异常或凭据。"); process.exitCode = 1; });
