import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture";
import { configureMcpFixture } from "./helpers/mcp-fixture";
import { DONE_EVENT, TOOL_FINISH_EVENT, TRANSPORT_DONE_EVENT, textDelta, toolCallDelta } from "./helpers/openai-mock";
import { mcpToolName } from "@/tools/mcp-tool";
import { streamAgentResponse } from "@/web/chat-handler";
import { parseWebChatEvents, readWebStream, type WebChatEvent } from "@/web/chat-contract";

for (const transport of ["stdio", "http"] as const) {
  test(`Web 完整 MCP ${transport} 审批、执行、持久化与副作用闭环`, async () => {
    let requests = 0;
    const fixture = await runtimeFixture(() => ({ chunks: [{ data: ++requests === 1
      ? toolCallDelta({ id: "mcp_call_1", name: mcpToolName("demo", "echo"), argumentsJson: '{"text":"mcp-ok"}' }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT
      : textDelta("MCP_DONE") + DONE_EVENT }] }));
    const mcp = await configureMcpFixture(fixture.root, transport);
    const session = fixture.permissions.createSession();
    try {
      const checkpoint = await fixture.checkpoint();
      const input = { conversationId: checkpoint.summary.id, expectedRevision: checkpoint.summary.revision, permissionSessionId: session.id, input: "调用 demo echo", mode: "do" as const, modeTurn: 1, source: "web" as const, signal: new AbortController().signal };
      const prepared = await fixture.runtime.prepare(input);
      if (transport === "stdio") await assert.rejects(access(mcp.marker)); else assert.equal(mcp.methods.length, 0);
      const response = streamAgentResponse({ ...prepared, request: new Request("http://localhost/api/chat", { method: "POST" }) });
      assert.ok(response.body);
      const events: WebChatEvent[] = [];
      for await (const event of parseWebChatEvents(readWebStream(response.body))) {
        events.push(event);
        if (event.type === "runtime-permission-requested" || event.type === "permission-requested") {
          if (event.type === "runtime-permission-requested") assert.equal(requests, 0);
          fixture.permissions.resolveDecision(session.id, event.prompt.requestId, "allow-once");
        }
      }
      assert.ok(events.some((e) => e.type === "runtime-permission-requested"));
      assert.ok(events.some((e) => e.type === "permission-requested"));
      assert.ok(events.some((e) => e.type === "tool-result" && e.result.ok));
      const stopped = events.find((e) => e.type === "stopped");
      assert.equal(stopped?.reason, "final-response");
      assert.equal(stopped?.sideEffect, "possible");
      assert.equal(stopped?.persistence?.status, "saved");
      assert.equal(stopped?.verification?.status, "observed");
      assert.equal(events.filter((e) => e.type === "text-delta").length, 1);
      assert.equal(requests, 2);
      const saved = await fixture.store.load(checkpoint.summary.id);
      assert.ok(saved.displayMessages.at(-1)?.initialization?.some((i) => i.phase === "ready"));
      const runs = await fixture.log.findAllForConversation(checkpoint.summary.id);
      assert.equal(runs[0].schemaVersion, 5);
      assert.ok(runs[0].initialization?.length);
      assert.equal(runs[0].initialization?.length, 1);
      assert.deepEqual(runs[0].tools[0].mcp, { serverName: "demo", toolName: "echo" });
      if (transport === "stdio") assert.equal((await readFile(mcp.callLog, "utf8")).split('"tools/call"').length - 1, 1);
      else assert.equal(mcp.methods.filter((m) => m === "tools/call").length, 1);
    } finally { fixture.permissions.closeSession(session.id); await fixture.close(); await mcp.close(); }
  });
}

test("MCP 重复文本只向模型提供一份，持久化仍保留原始双份结果", async () => {
  let requests = 0;
  let modelMarkerCount = 0;
  const fixture = await runtimeFixture((request) => {
    requests += 1;
    if (requests === 2) {
      modelMarkerCount = JSON.stringify(request.body).split("UNIQUE_BODY_MARKER").length - 1;
    }
    return { chunks: [{ data: requests === 1
      ? toolCallDelta({ id: "dedupe", name: mcpToolName("demo", "echo"), argumentsJson: '{"text":"duplicate-structured"}' }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT
      : textDelta("已查到结果。") + DONE_EVENT }] };
  });
  const mcp = await configureMcpFixture(fixture.root, "stdio");
  const session = fixture.permissions.createSession();
  try {
    const checkpoint = await fixture.checkpoint();
    for await (const event of fixture.runtime.streamTurn({ conversationId: checkpoint.summary.id, expectedRevision: checkpoint.summary.revision,
      permissionSessionId: session.id, input: "查询结果", mode: "do", modeTurn: 1, source: "web", signal: new AbortController().signal })) {
      if (event.type === "initialization" && event.event.type === "runtime-permission-requested") fixture.permissions.resolveDecision(session.id, event.event.prompt.requestId, "allow-once");
      if (event.type === "agent" && event.event.type === "permission-requested") fixture.permissions.resolveDecision(session.id, event.event.prompt.requestId, "allow-once");
    }
    const saved = await fixture.store.load(checkpoint.summary.id);
    const raw = saved.displayMessages.at(-1)?.toolExecutions?.[0]?.result;
    assert.equal(JSON.stringify(raw).split("UNIQUE_BODY_MARKER").length - 1, 2);
    assert.equal(modelMarkerCount, 1);
    assert.equal(requests, 2);
  } finally { fixture.permissions.closeSession(session.id); await fixture.close(); await mcp.close(); }
});

test("拒绝启动和 Plan 都不启动 MCP，仍完成本地对话", async () => {
  const fixture = await runtimeFixture(() => ({ chunks: [{ data: textDelta("LOCAL_OK") + DONE_EVENT }] }));
  const mcp = await configureMcpFixture(fixture.root, "stdio");
  const session = fixture.permissions.createSession();
  try {
    for (const mode of ["do", "plan"] as const) {
      const c = await fixture.checkpoint();
      for await (const event of fixture.runtime.streamTurn({ conversationId: c.summary.id, expectedRevision: c.summary.revision, permissionSessionId: session.id, input: "本地对话", mode, modeTurn: c.modeTurn + 1, source: "cli", signal: new AbortController().signal })) {
        if (event.type === "initialization" && event.event.type === "runtime-permission-requested") fixture.permissions.resolveDecision(session.id, event.event.prompt.requestId, "deny");
        if (event.type === "finished") assert.equal(event.stopped.reason, "final-response");
      }
      await assert.rejects(access(mcp.marker));
    }
  } finally { fixture.permissions.closeSession(session.id); await fixture.close(); await mcp.close(); }
});

for (const transport of ["stdio", "http"] as const) {
  for (const scenario of ["invalid", "fail", "deny", "cancel", "deadline", "max"] as const) {
    test(`MCP ${transport} 异常闭环 ${scenario}`, async () => {
      let requests = 0;
      const fixture = await runtimeFixture(() => ({ chunks: [{ data: ++requests === 1 || scenario === "max"
        ? toolCallDelta({ id: `call_${requests}`, name: mcpToolName("demo", "echo"), argumentsJson: JSON.stringify(scenario === "invalid" ? { text: 1 } : { text: scenario === "cancel" || scenario === "deadline" ? "hang" : scenario }) }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT
        : textDelta("RECOVERED") + DONE_EVENT }] }), { iterations: scenario === "max" ? "2" : "4" });
      const mcp = await configureMcpFixture(fixture.root, transport);
      const session = fixture.permissions.createSession(); const controller = new AbortController();
      try {
        const c = await fixture.checkpoint();
        const prepared = await fixture.runtime.prepare({ conversationId: c.summary.id, expectedRevision: c.summary.revision, permissionSessionId: session.id, input: "error test", mode: "do", modeTurn: 1, source: "web", signal: controller.signal });
        const { runAgentTurn } = await import("@/runtime/run-agent-turn");
        const results = []; let reason: string | undefined;
        for await (const e of runAgentTurn({ ...prepared, signal: controller.signal, ...(scenario === "deadline" ? { maxRuntimeMs: 250 } : {}) })) {
          if (e.type === "initialization" && e.event.type === "runtime-permission-requested") fixture.permissions.resolveDecision(session.id, e.event.prompt.requestId, "allow-once");
          if (e.type === "agent" && e.event.type === "permission-requested") fixture.permissions.resolveDecision(session.id, e.event.prompt.requestId, scenario === "deny" ? "deny" : "allow-once");
          if (e.type === "agent" && e.event.type === "tool-started" && scenario === "cancel") setTimeout(() => controller.abort(), 30);
          if (e.type === "agent" && e.event.type === "tool-result") results.push(e.event.result);
          if (e.type === "finished") { reason = e.stopped.reason; assert.equal(e.persistence.status, "saved"); }
        }
        assert.equal(reason, scenario === "max" ? "max-iterations" : scenario === "cancel" ? "cancelled" : scenario === "deadline" ? "max-runtime" : "final-response");
        if (scenario === "invalid" || scenario === "deny" || scenario === "fail") assert.equal(results[0]?.ok, false);
        if (scenario === "invalid" || scenario === "deny") assert.equal(results[0]?.sideEffect, "none");
        if (scenario === "cancel" || scenario === "deadline") assert.equal(results[0]?.sideEffect, "possible");
        const count = transport === "stdio" ? (await readFile(mcp.callLog, "utf8")).split('"tools/call"').length - 1 : mcp.methods.filter(m => m === "tools/call").length;
        assert.equal(count, scenario === "invalid" || scenario === "deny" ? 0 : 1);
        if (scenario === "fail" && !results[0].ok) assert.equal(results[0].error.kind, "mcp-tool-error");
      } finally { fixture.permissions.closeSession(session.id); await fixture.close(); await mcp.close(); }
    });
  }
}

test("MCP 秘密在卸载前脱敏，完整上下文与导出保留安全结果和工具身份", async () => {
  let count = 0; let reference = ""; let exposedCompletionReport = false;
  const fixture = await runtimeFixture((request) => {
    count++;
    assert.ok(!JSON.stringify(request.body).includes("MCP_SYNTHETIC_SECRET_9821"));
    if (count === 1) return { chunks: [{ data: toolCallDelta({ id: "large", name: mcpToolName("demo", "echo"), argumentsJson: '{"text":"large-secret"}' }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT }] };
    if (count === 2) {
      reference = JSON.stringify(request.body).match(/context:\/\/v1\/[0-9a-f-]{36}/)?.[0] ?? "";
      return { chunks: [{ data: toolCallDelta({ id: "read-large", name: "read_context", argumentsJson: JSON.stringify({ reference, offset: 0, limit: 500 }) }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT }] };
    }
    exposedCompletionReport = JSON.stringify(request.body).includes('"name":"report_completion"');
    return { chunks: [{ data: textDelta("DONE") + DONE_EVENT }] };
  }, { context: "      single_tool_result_tokens: 100\n      tool_result_group_tokens: 1000\n" });
  const mcp = await configureMcpFixture(fixture.root, "stdio"); const session = fixture.permissions.createSession();
  try {
    const c = await fixture.checkpoint(); const visible = [];
    let verificationStatus: string | undefined;
    for await (const e of fixture.runtime.streamTurn({ conversationId: c.summary.id, expectedRevision: c.summary.revision, permissionSessionId: session.id, input: "large result", mode: "do", modeTurn: 1, source: "web", signal: new AbortController().signal })) {
      visible.push(e);
      if (e.type === "initialization" && e.event.type === "runtime-permission-requested") fixture.permissions.resolveDecision(session.id, e.event.prompt.requestId, "allow-once");
      if (e.type === "agent" && e.event.type === "permission-requested") fixture.permissions.resolveDecision(session.id, e.event.prompt.requestId, "allow-once");
      if (e.type === "finished") verificationStatus = e.stopped.verification?.status;
    }
    assert.equal(verificationStatus, "observed");
    assert.equal(exposedCompletionReport, false);
    assert.ok(reference);
    assert.equal(count, 3);
    const content = await fixture.store.read({ sessionId: c.summary.id, reference, offset: 0, limit: 500, signal: new AbortController().signal });
    assert.match(content.content, /SAFE_MARKER/); assert.ok(!content.content.includes("MCP_SYNTHETIC_SECRET_9821"));
    const { LocalConversationExporter } = await import("@/lib/local-conversation-exporter");
    const exported = await new LocalConversationExporter(fixture.log, fixture.store).createExport(c.summary.id);
    assert.ok(!JSON.stringify([visible, exported]).includes("MCP_SYNTHETIC_SECRET_9821"));
    assert.deepEqual(exported.runs[0].tools[0].mcp, { serverName: "demo", toolName: "echo" });
    assert.ok(exported.context.objects.some(o => o.status === "included" && o.content.includes("SAFE_MARKER")));
  } finally { fixture.permissions.closeSession(session.id); await fixture.close(); await mcp.close(); }
});

test("故障、拒绝和正常 Server 共存，本地与外部工具都可完成", async () => {
  let calls=0;
  const fixture=await runtimeFixture(()=>({chunks:[{data:++calls===1?toolCallDelta({id:'local',name:'read_file',argumentsJson:'{"path":"proof.txt"}'})+TOOL_FINISH_EVENT+TRANSPORT_DONE_EVENT:calls===2?toolCallDelta({id:'external',name:mcpToolName('demo','echo'),argumentsJson:'{"text":"external-ok"}'})+TOOL_FINISH_EVENT+TRANSPORT_DONE_EVENT:textDelta('BOTH_DONE')+DONE_EVENT}]}));
  const mcp=await configureMcpFixture(fixture.root,'stdio');const session=fixture.permissions.createSession();
  const {writeFile}=await import('node:fs/promises');const {parse,stringify}=await import('yaml');
  try{
    await writeFile(`${fixture.root}/proof.txt`,'LOCAL_OK');
    const config=parse(await readFile(`${fixture.root}/.orbitcode/mcp.yaml`,'utf8'));
    config.mcpServers.bad={type:'stdio',command:'/missing/mcp-command'};
    config.mcpServers.denied={type:'stdio',command:'/must-not-start'};
    await writeFile(`${fixture.root}/.orbitcode/mcp.yaml`,stringify(config));
    const c=await fixture.checkpoint();const results=[];const statuses=[];
    for await(const e of fixture.runtime.streamTurn({conversationId:c.summary.id,expectedRevision:c.summary.revision,permissionSessionId:session.id,input:'local and external',mode:'do',modeTurn:1,source:'web',signal:new AbortController().signal})){
      if(e.type==='initialization'&&e.event.type==='runtime-permission-requested')fixture.permissions.resolveDecision(session.id,e.event.prompt.requestId,e.event.serverName==='denied'?'deny':'allow-once');
      if(e.type==='initialization'&&e.event.type==='mcp-status')statuses.push(`${e.event.serverName}:${e.event.phase}`);
      if(e.type==='agent'&&e.event.type==='permission-requested')fixture.permissions.resolveDecision(session.id,e.event.prompt.requestId,'allow-once');
      if(e.type==='agent'&&e.event.type==='tool-result')results.push(e.event.result);
      if(e.type==='finished')assert.equal(e.stopped.reason,'final-response');
    }
    assert.equal(results.length,2);assert.ok(results.every(r=>r.ok));assert.match(JSON.stringify(results),/LOCAL_OK/);
    for(const status of ['bad:unavailable','denied:unavailable','demo:ready'])assert.ok(statuses.includes(status));
  }finally{fixture.permissions.closeSession(session.id);await fixture.close();await mcp.close();}
});

test("放行模式无需审批即可完成 MCP 调用、运行证据和会话持久化", async () => {
  let requests = 0;
  const fixture = await runtimeFixture(() => ({ chunks: [{ data: ++requests === 1
    ? toolCallDelta({ id: "external", name: mcpToolName("demo", "echo"), argumentsJson: '{"text":"你好，MCP！"}' }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT
    : textDelta("返回：你好，MCP！") + DONE_EVENT }] }));
  const mcp = await configureMcpFixture(fixture.root, "stdio");
  const session = fixture.permissions.createSession();
  fixture.permissions.setMode(session.id, "permissive");
  try {
    const c = await fixture.checkpoint();
    const prepared = await fixture.runtime.prepare({ conversationId: c.summary.id, expectedRevision: c.summary.revision, permissionSessionId: session.id, input: "调用 echo", mode: "do", modeTurn: 1, source: "web", signal: new AbortController().signal });
    const response = streamAgentResponse({ ...prepared, request: new Request("http://localhost/api/chat", { method: "POST" }) });
    assert.ok(response.body);
    for await (const event of parseWebChatEvents(readWebStream(response.body))) {
      assert.notEqual(event.type, "runtime-permission-requested");
      assert.notEqual(event.type, "permission-requested");
      if (event.type === "tool-result") assert.equal(event.result.ok, true);
    }
    const saved = await fixture.store.load(c.summary.id);
    assert.equal(saved.displayMessages.at(-1)?.verification?.status, "observed");
    assert.equal(saved.displayMessages.at(-1)?.verification?.checks[0].scope, "external-call");
    assert.equal((await readFile(mcp.callLog, "utf8")).split('"tools/call"').length - 1, 1);
    assert.equal(requests, 2);
  } finally { fixture.permissions.closeSession(session.id); await fixture.close(); await mcp.close(); }
});
