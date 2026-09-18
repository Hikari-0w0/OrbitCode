import { startOpenAIMockServer, textDelta, DONE_EVENT, toolCallDelta, TOOL_FINISH_EVENT, TRANSPORT_DONE_EVENT } from "./openai-mock";

async function main() {
  const server = await startOpenAIMockServer((request) => {
    const body = request.body;
    if (!body || typeof body !== "object" || !("messages" in body) || !Array.isArray(body.messages)) return { status: 400 };
    if ("tool_choice" in body && body.tool_choice === "none") return { chunks: [{ data: textDelta(JSON.stringify({ analysisDraft: "安全测试摘要", summary: { taskGoals: ["验证 CLI"], completedWork: [], keyDecisions: [], fileChanges: [], toolResults: [], errors: [], nextSteps: [] } })) + DONE_EVENT }] };
    const messages = body.messages;
    const lastUserIndex = messages.findLastIndex((m) => m.role === "user");
    const prompt = String(messages[lastUserIndex]?.content ?? "");
    const results = messages.slice(lastUserIndex + 1).filter((m) => m.role === "tool");
    const tool = (name: string, argumentsJson: string) => ({ chunks: [{ data: toolCallDelta({ id: `call_${Date.now()}_${results.length}`, name, argumentsJson }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT }] });
    if (prompt.includes("最大轮数")) return tool("read_file", '{"path":"fixture.txt"}');
    if (results.length === 0) {
      if (prompt.includes("无效参数")) return tool("read_file", '{"path":42}');
      if (prompt.includes("失败命令")) return tool("run_command", '{"command":"false","timeout_ms":1000}');
      if (prompt.includes("超时命令")) return tool("run_command", '{"command":"sleep 2","timeout_ms":100}');
      if (prompt.includes("写入") || prompt.includes("按照上述计划")) return tool("write_file", '{"path":"fixture.txt","content":"CLI-WEB-PARITY\\n"}');
      if (prompt.includes("读取")) return tool("read_file", '{"path":"fixture.txt"}');
      if (prompt.includes("取消测试")) return { chunks: [{ data: textDelta("正在等待取消") }, { data: DONE_EVENT, delayMs: 20000 }] };
    }
    return { chunks: [{ data: textDelta("测试回复：已处理请求与工具结果。") }, { data: DONE_EVENT, delayMs: 50 }] };
  });
  process.stdout.write(`${server.baseUrl}\n`);
  const close = () => { void server.close().then(() => process.exit(0)); };
  process.on("SIGTERM", close); process.on("SIGINT", close);
}
void main();
