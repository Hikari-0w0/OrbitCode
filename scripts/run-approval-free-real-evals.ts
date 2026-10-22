import assert from "node:assert/strict";
import { mkdir, readFile, access, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProviderContext, resolveRuntimeProvider } from "@/runtime/config";
import { realSubAgentFixture, scrubCredential } from "./evals/sub-agent-real-fixture";
import { realWebSubAgentFixture } from "./evals/sub-agent-web-fixture";
import { configureMcpFixture } from "../tests/helpers/mcp-fixture";
import { LocalSettingsStore } from "@/lib/local-settings-store";
import { parseMcpServerConfig } from "@/runtime/mcp-config";
import { isObject } from "@/mcp/messages";
import { parse } from "yaml";
import { mcpToolName } from "@/tools/mcp-tool";

const scenarios = ["cli-parent", "web-child-front", "web-child-background", "web-deny", "cli-skill", "web-mcp"] as const;
export async function runApprovalFreeRealEvals() {
  const args = process.argv.slice(2), option = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const requested = option("root"), selected = option("cases")?.split(",") ?? [...scenarios];
  if (!args.includes("--allow-real-model") || !requested || !selected.length || selected.some(name => !scenarios.some(scenario => scenario === name))) throw new Error("需要真实模型授权、新输出目录及有效cases。");
  const base = path.resolve(requested);
  await mkdir(path.dirname(base), { recursive: true }); await mkdir(base, { mode: 0o700 });
  const context = await loadProviderContext(), source = resolveRuntimeProvider(context, option("provider") ?? context.defaultProviderId ?? context.providers[0].name);
  const results: { name: string; root: string; status: string; error: string }[] = [];
  const cartTask = "创建cart.mjs，以ESM导出calculateTotal(items)，价格乘数量求和，空数组返回0，拒绝负价格和非正整数数量。创建cart.test.mjs，用node:test覆盖这些要求。实际执行node --test cart.test.mjs。只创建这两个文件，不安装依赖。";
  for (const scenario of selected) {
    const files: Readonly<Record<string, string>> = scenario === "web-deny" ? { ".orbitcode/permissions.yaml": 'rules:\n  "write_file(blocked.txt)": deny\n' }
      : scenario === "cli-skill" ? { ".orbitcode/skills/worker/SKILL.md": "---\nname: worker\ndescription: 无审批独立执行验收\nmode: isolated\nhistory: {kind: none}\nallowed-tools: [write_file, run_command]\n---\n实际调用write_file创建skill.txt，内容严格为SKILL_DIRECT_20261022，然后调用run_command执行node --version。完成后根据真实工具结果回复，不委派。" }
        : {};
    const f = scenario.startsWith("web-")
      ? await realWebSubAgentFixture(base, scenario, source, files, { serverMode: "start", permissionMode: "default" })
      : await realSubAgentFixture(base, scenario, source, files, false, {}, { permissionMode: "default" });
    const result = { name: scenario, root: f.root, status: "failed", error: "" };
    let mcp: Awaited<ReturnType<typeof configureMcpFixture>> | undefined;
    try {
      if (scenario === "web-mcp") {
        mcp = await configureMcpFixture(f.workspace, "stdio");
        // Web以托管配置为准；旧YAML夹具必须显式导入本轮独立数据目录。
        const raw: unknown = parse(await readFile(path.join(f.workspace, ".orbitcode/mcp.yaml"), "utf8"));
        if (!isObject(raw) || !isObject(raw.mcpServers)) throw new Error("本地MCP夹具配置无效");
        const store = new LocalSettingsStore(path.join(f.root, "data")), current = await store.load();
        if (!current) throw new Error("评测托管配置缺失");
        const { revision, ...settings } = current;
        await store.save(revision, { ...settings, mcpServers: [{ name: "demo", scope: "workspace", workspaceId: "eval", enabled: true, config: parseMcpServerConfig(raw.mcpServers.demo) }] });
        const start = { operation: "start", task: { kind: "fork", background: true, prompt: `只调用一次工具${mcpToolName("demo", "echo")}，参数为{"text":"MCP_DIRECT_20261022"}，返回真实结果。不要探索文件或通过其他工具替代。` } };
        await f.run(`实际调用agent，创建参数严格为：${JSON.stringify(start)}。必须background=true；task中禁止添加role字段，角色白名单会过滤MCP工具。父只使用agent委派、等待和汇总，不代调用。`, "delegate-only", "fork");
      } else if (scenario === "cli-skill") await f.run("/skill run worker");
      else if (scenario === "cli-parent") await f.run(cartTask + " 主Agent直接执行，不创建子任务或加载Skill。");
      else {
        const prompt = scenario === "web-deny" ? "只调用一次write_file创建blocked.txt，内容为NO_WRITE；若被拒绝立即回复，不换工具、不重试。" : cartTask;
        await f.run(`只创建1个defined子任务，role=general，background=${scenario !== "web-child-front"}。子任务：${prompt} 父只委派、等待与汇总，不代做。`, "delegate-only", "defined");
      }
      const tasks = await f.settle(); await f.save("tasks.json", tasks);
      const cp = await f.checkpoint(), parents = await f.log.findAllForConversation(cp.summary.id);
      const children = await Promise.all(tasks.map(task => f.log.findAllForConversation(task.id)));
      await f.save("runs.json", { parents, children });
      assert.ok(parents.length > 0);
      assert.ok([...parents, ...children.flat()].flatMap(run => run.tools).every(tool => !tool.authorization), "运行中没有审批请求或决定");
      if (scenario === "cli-parent" || scenario === "cli-skill") assert.equal(tasks.length, 0);
      else {
        assert.equal(tasks.length, 1); assert.ok(parents.flatMap(run => run.tools).every(tool => tool.name === "agent"));
        assert.equal(tasks[0].admission?.permissions.parentMode, "default");
        if (scenario !== "web-mcp") { assert.equal(tasks[0].role, "general"); assert.equal(tasks[0].admission?.permissions.roleMode, "default"); }
        if (tasks[0].state.status !== "terminal") throw new Error("子任务未结束");
        assert.equal(tasks[0].state.result.cleanup, "complete");
        if (scenario === "web-deny") {
          assert.ok(tasks[0].state.result.failures.some(failure => failure.kind === "permission-denied"));
          await assert.rejects(access(path.join(f.workspace, "blocked.txt")));
        } else { assert.equal(tasks[0].state.result.stopReason, "final-response"); assert.equal(tasks[0].state.result.failureCount, 0); }
      }
      if (scenario === "cli-parent" || scenario === "web-child-front" || scenario === "web-child-background") {
        const check = await f.independent("import assert from 'node:assert/strict';import{spawnSync}from'node:child_process';import{calculateTotal}from'./cart.mjs';assert.equal(calculateTotal([{price:4,quantity:3},{price:2,quantity:2}]),16);assert.equal(calculateTotal([]),0);assert.throws(()=>calculateTotal([{price:-1,quantity:1}]));for(const quantity of [0,-1,1.5])assert.throws(()=>calculateTotal([{price:1,quantity}]));const r=spawnSync(process.execPath,['--test','cart.test.mjs'],{encoding:'utf8'});process.stdout.write(r.stdout);process.stderr.write(r.stderr);assert.equal(r.status,0);");
        assert.equal(check.exitCode, 0);
      }
      if (scenario === "cli-skill") {
        assert.equal(await readFile(path.join(f.workspace, "skill.txt"), "utf8"), "SKILL_DIRECT_20261022");
        assert.ok(f.calls.some(trace => trace.call.name === "write_file"));
        assert.ok(f.calls.some(trace => trace.call.name === "run_command"));
        assert.ok(cp.displayMessages.some(message => message.toolExecutions?.some(tool => tool.name.includes("Skill worker") && tool.result.ok)));
      }
      if (scenario === "web-mcp") {
        assert.ok(mcp);
        assert.ok(tasks[0].admission?.tools.some(name => name.startsWith("mcp__")), "子任务实际发现MCP工具");
        const methods = (await readFile(mcp.callLog, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line).method);
        assert.equal(methods.filter(method => method === "initialize").length, 1);
        assert.equal(methods.filter(method => method === "tools/call").length, 1);
        await f.save("mcp-methods.json", methods);
      }
      if ("conversationId" in f) {
        const events: { type: string }[] = JSON.parse(await readFile(path.join(f.root, "web-events.json"), "utf8"));
        assert.ok(events.every(event => !event.type.includes("permission-requested") && !event.type.includes("permission-resolved")));
      }
      result.status = "passed";
    } catch (error) { result.error = scrubCredential(error instanceof Error ? error.message : "评测失败", source); }
    finally {
      await f.close(); await mcp?.close();
      results.push(result); await writeFile(path.join(base, "results.json"), JSON.stringify(results, null, 2));
      console.log(JSON.stringify(result));
    }
  }
  if (results.some(result => result.status !== "passed")) process.exitCode = 1;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) void runApprovalFreeRealEvals().catch(() => { console.error("无审批真实评测未完成，未输出配置或凭据。"); process.exitCode = 1; });
