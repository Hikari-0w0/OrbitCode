import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadProviderContext, resolveRuntimeProvider } from "@/runtime/config";
import { realSubAgentFixture, scrubCredential } from "./evals/sub-agent-real-fixture";
import { realWebSubAgentFixture } from "./evals/sub-agent-web-fixture";
import { assertTaskTiming } from "./evals/assert-task-timing";

const scenarios = ["present", "absent", "defined-isolation"] as const;
async function main() {
  const args = process.argv.slice(2), option = (key: string) => args.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
  const root = option("root"), transport = option("transport") ?? "cli", repeat = Number(option("repeat") ?? 2);
  if (!args.includes("--allow-real-model") || !root || !["cli", "web"].includes(transport) || !Number.isSafeInteger(repeat) || repeat < 1 || repeat > 5) throw new Error("需要真实模型授权、新输出目录、合法transport和repeat（1–5）。");
  const base = path.resolve(root);
  await mkdir(path.dirname(base), { recursive: true }); await mkdir(base, { mode: 0o700 });
  const context = await loadProviderContext(), source = resolveRuntimeProvider(context, option("provider") ?? context.defaultProviderId ?? context.providers[0].name);
  const marker = "RELIABILITY_NEEDLE_😀_740", absent = "RELIABILITY_ABSENT_123";
  const corpus = "头😀".repeat(17000) + marker + "尾字".repeat(18000);
  await writeFile(path.join(base, "metadata.json"), JSON.stringify({ model: source.model, transport, repeat, scenarios, corpusSha256: createHash("sha256").update(corpus).digest("hex"), scriptSha256: createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex"), acceptance: "固定隔离正文；实际工具参数、独立原文、任务类型、父子工具范围和子交付分别核验；非严格性能A/B。" }, null, 2));
  const results: { name: string; root?: string; status: "passed" | "failed"; error?: string }[] = [];
  for (let round = 1; round <= repeat; round++) for (const scenario of scenarios) {
    const result: typeof results[number] = { name: `${transport}-${scenario}-${round}`, status: "failed" };
    let fixture: Awaited<ReturnType<typeof realSubAgentFixture>> | Awaited<ReturnType<typeof realWebSubAgentFixture>> | undefined;
    const heartbeat = setInterval(() => console.log(JSON.stringify({ event: "running", name: result.name })), 30000);
    console.log(JSON.stringify({ event: "start", name: result.name }));
    try {
      fixture = transport === "web" ? await realWebSubAgentFixture(base, result.name, source, { "large.txt": corpus }, { serverMode: "start", offload: true }) : await realSubAgentFixture(base, result.name, source, { "large.txt": corpus }, true);
      result.root = fixture.root;
      await fixture.run("只用read_file读取large.txt，不搜索不写文件。读取完成后只回复ACK，正文由工具结果保留供下轮使用。", "collaborate");
      const before = await fixture.checkpoint();
      assert.ok(before.context.messages.some(message => message.kind === "tool-result" && message.payload.storage === "offloaded"), "实际发生卸载");
      const prompt = scenario === "defined-isolation"
        ? "实际创建1个defined后台子任务role=reader。子prompt仅为：不使用任何工具，不猜测，检查你的历史是否包含RELIABILITY_NEEDLE_开头的完整标记；有则原样输出，否则只输出UNKNOWN。父只能创建、等待和汇总，不在子prompt传递标记值或文件内容。"
        : `实际创建1个fork后台子任务role=reader。子prompt为：只从继承历史提供的context://引用检索，不重新读取工作区文件、不运行命令；实际调用read_context query=${scenario === "present" ? "RELIABILITY_NEEDLE_" : absent}，offset=0，limit=1000，以运行时全文搜索结果回答；回报精确matchCount、complete及searchedFrom/searchedUntil；有匹配时引用完整标记，无匹配时只说明该字面量在该引用无匹配。父只委派、等待和汇总，不代做检索，不在子prompt传递完整标记值。`;
      await fixture.run(prompt, "delegate-only", scenario === "defined-isolation" ? "defined" : "fork");
      const tasks = await fixture.settle();
      assert.equal(tasks.length, 1); const task = tasks[0];
      assertTaskTiming(task);
      assert.equal(task.kind, scenario === "defined-isolation" ? "defined" : "fork");
      assert.equal(task.admission?.version, 1);
      assert.equal(task.admission?.provider.model, source.model);
      assert.equal(task.admission?.delivery.acceptance, "independent-verification");
      assert.ok(task.admission?.tools.includes("read_context"));
      assert.ok(!task.admission?.tools.includes("agent"));
      assert.equal(task.preparedContext?.sourceSha256, task.admission?.context.sha256);
      if (scenario === "defined-isolation") {
        assert.equal(task.admission?.context.policy, "none");
        assert.equal(task.preparedContext?.messages, 0);
        assert.equal(task.preparedContext?.copiedReferences, 0);
      } else {
        assert.equal(task.admission?.context.policy, "admission-snapshot");
        assert.ok((task.admission?.context.offloadedReferences ?? 0) >= 1);
        assert.equal(task.preparedContext?.messages, task.admission?.context.messages);
        assert.ok((task.preparedContext?.copiedBytes ?? 0) >= Buffer.byteLength(corpus));
        assert.ok(task.preparedContext?.references.some(reference => reference.source !== reference.destination && /^[a-f0-9]{64}$/.test(reference.sha256)));
      }
      assert.equal(task.state.status, "terminal");
      if (task.state.status !== "terminal") throw new Error("没有子任务终态");
      assert.equal(task.state.result.stopReason, "final-response");
      let reply = task.state.result.finalReply ?? "";
      if (task.state.result.replyTruncated) { reply = ""; let offset = 0; for (;;) { const page = await fixture.readReply(task.id, offset); reply += page.content; if (page.nextOffset === null) break; offset = page.nextOffset; } }
      const childRuns = await fixture.log.findAllForConversation(task.id);
      assert.equal(childRuns.length, 1);
      if (scenario === "defined-isolation") { assert.equal(childRuns[0].tools.length, 0); assert.equal(reply.trim(), "UNKNOWN"); }
      else {
        assert.ok(childRuns[0].tools.some(tool => tool.name === "read_context" && tool.status === "succeeded"));
        assert.ok(childRuns[0].tools.every(tool => tool.name === "read_context"));
        const expectedQuery = scenario === "present" ? "RELIABILITY_NEEDLE_" : absent;
        const evidence = task.state.result.handoff?.reads?.contextSearches?.find(search => search.query === expectedQuery);
        assert.ok(evidence, "运行时事实交接证明全文搜索已执行");
        assert.equal(evidence.complete, true);
        assert.equal(evidence.matchCount, scenario === "present" ? 1 : 0);
        assert.ok(evidence.totalCharacters >= Array.from(corpus).length);
        assert.ok(childRuns[0].tools.some(tool => tool.callId === evidence.callId && tool.status === "succeeded"));
        const disk = await readFile(path.join(fixture.workspace, "large.txt"), "utf8");
        assert.equal(disk, corpus);
        if (scenario === "present") { assert.equal(disk.split("RELIABILITY_NEEDLE_").length - 1, 1); assert.ok(reply.includes(marker)); }
        else { assert.equal(disk.includes(absent), false); assert.match(reply, /0|无匹配|不存在/); }
        // CLI记录实际模型调用，确保搜索能力被使用，而非只靠回复猜测；Web另保留原生工具事件供复核。
        if (transport === "cli") assert.ok(fixture.calls.some(item => item.child && item.call.name === "read_context" && JSON.parse(item.call.argumentsJson).query === (scenario === "present" ? "RELIABILITY_NEEDLE_" : absent)));
      }
      const checkpoint = await fixture.checkpoint();
      const runs = await fixture.log.findAllForConversation(checkpoint.summary.id), latest = runs.at(-1);
      assert.ok(latest); assert.ok(latest.tools.every(tool => tool.name === "agent"));
      assert.equal(checkpoint.lastTurn?.parentExecution?.delegationKind, task.kind);
      await fixture.save("assessment.json", { scenario, task, reply, childRuns, parentRun: latest, note: "自动断言不等于证明任意语义检索；搜索只匹配已知字面量。" });
      result.status = "passed";
    } catch (error) { result.error = scrubCredential(error instanceof Error ? error.message : "验收失败", source); }
    finally {
      if (fixture) try { await fixture.close(); } catch { result.status = "failed"; result.error = "清理失败"; }
      clearInterval(heartbeat); results.push(result);
      await writeFile(path.join(base, "results.json"), JSON.stringify(results, null, 2)); console.log(JSON.stringify(result));
    }
  }
  let credentialMatches = 0;
  const scan = async (directory: string): Promise<void> => { for (const entry of await readdir(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) await scan(file); else if (entry.isFile() && source.apiKey && (await readFile(file)).includes(Buffer.from(source.apiKey))) credentialMatches++; } };
  await scan(base);
  await writeFile(path.join(base, "summary.json"), JSON.stringify({ results, credentialMatches }, null, 2));
  if (credentialMatches || results.some(result => result.status !== "passed")) process.exitCode = 1;
}
void main().catch(() => { console.error("可靠性评测未完成；未输出原始异常或凭据。"); process.exitCode = 1; });
