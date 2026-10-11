import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { McpClient } from "./client";
import { McpHttpTransport } from "./http-transport";
test("HTTP JSON、SSE、202、GET 405 与安全会话头", async () => {
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    calls.push(req.method ?? "");
    if (req.method === "GET" || req.method === "DELETE") { res.writeHead(405).end(); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (message.method === "initialize") {
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "test-session" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } } }));
      return;
    }
    assert.equal(req.headers["mcp-session-id"], "test-session");
    assert.equal(req.headers["mcp-protocol-version"], "2025-11-25");
    if (!message.id) { res.writeHead(202).end(); return; }
    const result = message.method === "tools/list" ? { tools: [] } : { content: [{ type: "text", text: "http-ok" }] };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new McpClient(new McpHttpTransport({ url: `http://127.0.0.1:${address.port}/mcp`, headers: {} }));
  const options = { signal: new AbortController().signal, deadlineMs: Date.now() + 2000 };
  try {
    await client.initialize(options);
    assert.deepEqual(await client.listTools(options), []);
    assert.equal((await client.callTool("echo", {}, options)).content[0].text, "http-ok");
  } finally { await client.close(); await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); }
  assert.ok(calls.includes("GET") && calls.includes("DELETE"));
});

test("HTTP 重定向不发送到目标；404 不重试；GET 通知及伪响应隔离", async () => {
  let targetRequests = 0;
  const target = createServer((_req, res) => { targetRequests++; res.end(); });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const targetAddress = target.address(); assert.ok(targetAddress && typeof targetAddress !== "string");
  let mode = "redirect";
  let posts = 0;
  const server = createServer(async (req, res) => {
    if (mode === "redirect") { res.writeHead(307, { location: `http://127.0.0.1:${targetAddress.port}` }).end(); return; }
    if (mode === "missing") { posts++; res.writeHead(404).end(); return; }
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');
      if (mode === "forged") res.write('data: {"jsonrpc":"2.0","id":123,"result":{}}\n\n');
      return;
    }
    let body = ""; for await (const chunk of req) body += chunk;
    const m = JSON.parse(body);
    if (!("id" in m)) { res.writeHead(202).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const make = () => new McpClient(new McpHttpTransport({ url: `http://127.0.0.1:${address.port}`, headers: { authorization: "Bearer fake-secret" } }));
  const options = () => ({ signal: new AbortController().signal, deadlineMs: Date.now() + 1000 });
  try {
    for (const failure of ["redirect", "missing"]) {
      mode = failure; const client = make();
      await assert.rejects(client.initialize(options())); await client.close();
    }
    assert.equal(targetRequests, 0); assert.equal(posts, 1);
    mode = "notify"; const client = make(); await client.initialize(options());
    await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(client.dirty, true); await client.close();
    mode = "forged"; const forged = make(); await forged.initialize(options());
    await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(forged.failed, true); assert.equal(forged.peer.pendingCount, 0); await forged.close();
  } finally {
    await Promise.all([server, target].map((s) => new Promise<void>((resolve) => { s.close(() => resolve()); s.closeAllConnections(); })));
  }
});

test("HTTP 请求超时和取消不重放，pending 清空", async () => {
  const { McpRpcPeer } = await import("./rpc-peer");
  let requests=0;
  const server=createServer((req,res)=>{if(req.method==='POST'){requests++;req.resume();}else res.writeHead(405).end();});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const a=server.address();assert.ok(a&&typeof a!=='string');
  const peer=new McpRpcPeer(new McpHttpTransport({url:`http://127.0.0.1:${a.port}`,headers:{}}));
  try{
    await peer.start(new AbortController().signal);
    await assert.rejects(peer.request('tools/call',{}, {signal:new AbortController().signal,deadlineMs:Date.now()+30}),/超时/);
    const controller=new AbortController();const pending=peer.request('tools/call',{}, {signal:controller.signal,deadlineMs:Date.now()+1000});
    setTimeout(()=>controller.abort(),30);await assert.rejects(pending,/取消/);
    assert.equal(peer.pendingCount,0);assert.ok(requests<=4);
  }finally{await peer.close();await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});}
});
