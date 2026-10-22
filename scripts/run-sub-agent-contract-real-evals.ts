import {fileURLToPath} from "node:url";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadProviderContext, resolveRuntimeProvider } from "@/runtime/config";
import { realSubAgentFixture, scrubCredential } from "./evals/sub-agent-real-fixture";
import { realWebSubAgentFixture } from "./evals/sub-agent-web-fixture";

async function main() {
  const args = process.argv.slice(2), option = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const requestedRoot = option("root"), transport = option("transport") ?? "cli",offload=args.includes("--small-results");
  if (!args.includes("--allow-real-model") || !requestedRoot || !["cli", "web"].includes(transport)) throw new Error("需要真实模型授权、新输出目录及合法 transport。");
  const base = path.resolve(requestedRoot);
  await mkdir(path.dirname(base), { recursive: true }); await mkdir(base, { mode: 0o700 });
  const context = await loadProviderContext(), source = resolveRuntimeProvider(context, option("provider") ?? context.defaultProviderId ?? context.providers[0].name);
  const fixture = transport === "web" ? await realWebSubAgentFixture(base, "reply", source, {}, { serverMode: "start",offload }) : await realSubAgentFixture(base, "reply", source,{},offload);
  const result = { name: `${transport}-complete-reply`, status: "failed", root: fixture.root, error: "" };
  const heartbeat = setInterval(() => console.log(JSON.stringify({ event: "running", name: result.name })), 30000);
  try {
    const marker = "CHILD_ARTIFACT_END_20261020";
    await fixture.run(`实际用agent创建1个defined后台子任务role=reader。子prompt：这是长交付验收，不调用任何文件或命令工具，直接输出1至120的编号列表；每行固定文本为“本条记录用于验证子任务长回复的正文保存与分页读取能力”，编号不同；120条之后最后一行只写${marker}。父只委派、等待和读取子结果，不代写列表。子完成后必须实际调用agent operation=result分页读取该ID的正文，offset从0开始，limit=4000；按返回nextOffset继续直到hasMore=false，然后简短报告你实际读取到的结尾标记。不要只依据自动投递的摘要猜测尾部。`, "delegate-only");
    const tasks = await fixture.settle(); await fixture.save("tasks.json", tasks);
    assert.equal(tasks.length, 1);
    if (tasks[0].state.status !== "terminal") throw new Error("子任务未结束。");
    const child = tasks[0].state.result;
    assert.equal(child.stopReason, "final-response"); assert.equal(child.replyTruncated, true);
    assert.equal(child.replyStorage?.status, "saved");
    let fullReply = "", offset = 0;
    for (;;) { const page = await fixture.readReply(tasks[0].id, offset); fullReply += page.content; if (page.nextOffset === null) break; offset = page.nextOffset; }
    assert.ok(fullReply.trimEnd().endsWith(marker));
    if (child.replyStorage?.status !== "saved") throw new Error("正文未保存。");
    assert.equal(createHash("sha256").update(fullReply).digest("hex"), child.replyStorage.sha256);
    const checkpoint = await fixture.checkpoint(), parentRuns = await fixture.log.findAllForConversation(checkpoint.summary.id);
    assert.equal(checkpoint.lastTurn?.parentExecution?.mode, "delegate-only");
    assert.ok(parentRuns.flatMap(run => run.tools).every(tool => tool.name === "agent"));
    assert.ok(checkpoint.context.messages.some(message => message.kind === "assistant-tool-call" && message.toolCalls.some(call => call.name === "agent" && JSON.parse(call.argumentsJson).operation === "result")), "父实际调用正文读取工具");
    assert.ok(checkpoint.context.messages.some(message => message.kind === "tool-result" && message.payload.storage === "inline" && message.payload.content.includes("child-model-reply") && message.payload.content.includes(marker)), "父实际收到包含尾部标记的正文页");
    assert.ok(checkpoint.context.messages.findLast(message => message.kind === "assistant")?.content.includes(marker));
    await fixture.save("assessment.json", { child, fullReply, parentRuns, parentFinal: checkpoint.context.messages.findLast(message => message.kind === "assistant") });
    result.status = "passed";
  } catch (error) { result.error = scrubCredential(String(error), source); }
  finally { clearInterval(heartbeat); try { await fixture.close(); } catch { result.status = "failed"; result.error += " 清理失败"; } await writeFile(path.join(base, "results.json"), JSON.stringify([result], null, 2)); console.log(JSON.stringify(result)); }
  await writeFile(path.join(base,"metadata.json"),JSON.stringify({model:source.model,transport,offload,scriptHash:createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex")},null,2));
  if (result.status !== "passed") process.exitCode = 1;
}
void main().catch(() => { console.error("子结果契约评测未完成，未输出原始异常或凭据。"); process.exitCode = 1; });
