import http from "node:http";
import path from "node:path";
import { mkdir, appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
const args = process.argv.slice(2), value = (key: string) => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
const port = Number(args.includes("--port") ? value("--port") : "0"), scenario = value("--scenario") || "happy", evidenceDir = value("--evidence-dir");
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
    throw new Error("替身端口无效。");
const server = http.createServer(async (request, response) => {
    try {
        let source = "";
        for await (const chunk of request) {
            source += chunk.toString();
            if (source.length > 1000000)
                throw new Error("请求过大。");
        }
        const raw: unknown = JSON.parse(source);
        if (!record(raw) || !Array.isArray(raw.messages))
            throw new Error("请求无效。");
        const messages = raw.messages.filter(record), system = messages.filter(x => x.role === "system").map(x => String(x.content)).join("\n");
        if (evidenceDir) {
            await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
            await appendFile(path.join(evidenceDir, "requests.jsonl"), JSON.stringify({ at: new Date().toISOString(), scenario, messages, tool_choice: raw.tool_choice, tools: raw.tools }) + "\n", { mode: 0o600 });
        }
        const extraction = system.includes("你是长期笔记提取器"), summary = system.includes("taskGoals");
        let text = "", tool: {
            name: string;
            arguments: string;
        } | undefined;
        if (extraction) {
            const last = messages.at(-1), items: unknown = JSON.parse(String(last?.content));
            const user = Array.isArray(items) ? items.find(x => record(x) && x.kind === "user-stated") : undefined;
            text = record(user) && typeof user.messageId === "string" ? JSON.stringify([{ category: "preference", scope: String(user.content).includes("所有项目") ? "user" : "project", title: "语言偏好", description: "使用中文回复", body: "使用中文回复；来自用户明确偏好。", evidence: [{ kind: "user-stated", messageId: user.messageId }] }]) : "[]";
        }
        else if (summary) {
            text = JSON.stringify({ analysisDraft: "只摘要已观察历史", summary: { taskGoals: ["继续测试"], completedWork: [], keyDecisions: [], fileChanges: [], toolResults: [], errors: [], nextSteps: ["核实当前文件"] } });
        }
        else {
            const userIndex = messages.findLastIndex(x => x.role === "user"), user = String(messages[userIndex]?.content), after = messages.slice(userIndex + 1), hasTool = after.some(x => x.role === "tool");
            const selectedScenario = ["max-iterations", "command-timeout", "tool-failure", "invalid-arguments"].find(name => user.includes(name)) ?? scenario;
            if (user.includes("中断进程") && hasTool)
                await new Promise<void>(resolve => { const timer = setTimeout(resolve, 120000); response.once("close", () => { clearTimeout(timer); resolve(); }); });
            if (selectedScenario === "max-iterations" || !hasTool) {
                if (user.includes("中断进程"))
                    tool = { name: "write_file", arguments: JSON.stringify({ path: "effect.txt", content: "中断前真实工具副作用。" }) };
                else if (selectedScenario === "command-timeout")
                    tool = { name: "run_command", arguments: JSON.stringify({ command: "sleep 2", timeout_ms: 100 }) };
                else if (selectedScenario === "tool-failure")
                    tool = { name: "run_command", arguments: JSON.stringify({ command: "exit 1", timeout_ms: 1000 }) };
                else if (selectedScenario === "invalid-arguments")
                    tool = { name: "read_file", arguments: JSON.stringify({ path: 123 }) };
                else if (user.includes("读取记忆") && /memory:\/\/[a-f0-9]+/.test(system))
                    tool = { name: "read_memory", arguments: JSON.stringify({ reference: /memory:\/\/[a-f0-9]+/.exec(system)?.[0], offset: 0, limit: 8000 }) };
                else
                    tool = { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) };
            }
            else
                text = "## 已完成检查\n\n已读取实际工具结果。\n\n- 保留现有功能\n- 使用隔离测试数据\n\n```ts\nconst ready = true;\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 文件读取 | 完成 |";
        }
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        if (tool)
            response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${randomUUID()}`, type: "function", function: tool }] }, finish_reason: null }] })}\n\n`);
        else {
            for (let offset = 0; offset < text.length; offset += 20) {
                if (response.destroyed)
                    return;
                response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text.slice(offset, offset + 20) }, finish_reason: null }] })}\n\n`);
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\n`);
        response.end("data: [DONE]\n\n");
    }
    catch {
        response.writeHead(400);
        response.end("fixture error");
    }
});
server.listen(port, "127.0.0.1", () => process.stdout.write(`本地模型替身 ${port} ${scenario}\n`));
for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => server.close(() => process.exit(0)));
