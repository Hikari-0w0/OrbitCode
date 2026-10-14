import assert from "node:assert/strict";
import test from "node:test";
import { McpClient } from "@/mcp/client";
import type { McpTransportHandlers } from "@/mcp/types";
import { McpConnectionManager } from "./mcp-connections";
import type { ResolvedMcpServer } from "./mcp-config";

test("连接跨轮复用、工作区隔离、配置变更和单等待者取消", async () => {
  let starts = 0;
  let closed = 0;
  const manager = new McpConnectionManager(() => {
    let handlers!: McpTransportHandlers;
    return new McpClient({ async start(h) { starts++; handlers = h; }, async send(m) {
      if (!("method" in m) || !("id" in m)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
      handlers.message({ jsonrpc: "2.0", id: m.id, result: m.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } } : { tools: [] } });
    }, async close() { closed++; } });
  });
  const server: ResolvedMcpServer = { name: "demo", workspaceRoot: "/one", configurationId: "c1", secrets: [], config: { type: "stdio", command: "unused", args: [], env: {} } };
  const request = { server, signal: new AbortController().signal, deadlineMs: Date.now() + 2000, revalidate: async () => {} };
  try {
    const abort = new AbortController();
    const first = manager.acquire({ ...request, signal: abort.signal });
    const second = manager.acquire(request);
    await new Promise((resolve) => setTimeout(resolve, 2)); abort.abort();
    await assert.rejects(first, /取消/);
    const lease = await second;
    await lease.release();
    const again = await manager.acquire(request); await again.release();
    assert.equal(starts, 1);
    const other = await manager.acquire({ ...request, server: { ...server, workspaceRoot: "/two" } }); await other.release();
    assert.equal(starts, 2);
    const changed = await manager.acquire({ ...request, server: { ...server, configurationId: "c2" } }); await changed.release();
    assert.equal(starts, 3); assert.ok(closed > 0);
  } finally { await manager.close(); }
});
test("失败缓存不每轮重试，拒绝授权不创建 client", async () => {
  let starts = 0;
  const manager = new McpConnectionManager(() => { starts++; return new McpClient({ async start() { throw new Error(); }, async send() {}, async close() {} }); });
  const server: ResolvedMcpServer = { name: "demo", workspaceRoot: "/one", configurationId: "c1", secrets: [], config: { type: "stdio", command: "unused", args: [], env: {} } };
  const input = { server, signal: new AbortController().signal, deadlineMs: Date.now() + 2000, revalidate: async () => {} };
  await assert.rejects(manager.acquire({ ...input, revalidate: async () => { throw new Error("deny"); } }));
  assert.equal(starts, 0);
  await assert.rejects(manager.acquire(input));
  await assert.rejects(manager.acquire(input));
  assert.equal(starts, 1);
  await manager.close();
});

test("目录通知合并刷新，旧租约保留快照，刷新失败不重试", async () => {
  let h!: McpTransportHandlers; let lists = 0; let fail = false;
  const manager = new McpConnectionManager(() => new McpClient({ async start(handlers) { h = handlers; }, async close() {}, async send(m) {
    if (!("method" in m) || !("id" in m)) return;
    if (m.method === "tools/list") { lists++; if (fail) { h.message({ jsonrpc: "2.0", id: m.id, error: { code: -1, message: "no" } }); return; } }
    h.message({ jsonrpc: "2.0", id: m.id, result: m.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "t", version: "1" } } : { tools: [{ name: `tool${lists}`, inputSchema: { type: "object" } }] } });
  } }));
  const request = { server: { name: "demo", workspaceRoot: "/one", configurationId: "c", secrets: [], config: { type: "stdio" as const, command: "x", args: [], env: {} } }, signal: new AbortController().signal, deadlineMs: Date.now() + 2000, revalidate: async () => {} };
  try {
    const old = await manager.acquire(request);
    for (let i = 0; i < 3; i++) h.message({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    const current = await manager.acquire(request);
    assert.equal(lists, 2); assert.equal(old.tools[0].name, "tool1"); assert.equal(current.tools[0].name, "tool2");
    fail = true; h.message({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    await assert.rejects(manager.acquire(request)); await assert.rejects(manager.acquire(request)); assert.equal(lists, 3);
    await old.release(); await current.release();
  } finally { await manager.close(); }
});

test("活动缓存容量不驱逐租约，配置 draining 等待在途调用后关闭", async () => {
  let pending: (()=>void)|undefined;let closes=0;
  const manager=new McpConnectionManager(()=>{let h!:McpTransportHandlers;return new McpClient({async start(handlers){h=handlers;},async close(){closes++;},async send(m){
    if(!('id'in m)||!('method'in m))return;
    if(m.method==='tools/call'){pending=()=>h.message({jsonrpc:'2.0',id:m.id,result:{content:[]}});return;}
    h.message({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'t',version:'1'}}:{tools:[]}});
  }});});
  const input={server:{name:'s',workspaceRoot:'/w0',configurationId:'c',secrets:[],config:{type:'stdio' as const,command:'x',args:[],env:{}}},signal:new AbortController().signal,deadlineMs:Date.now()+3000,revalidate:async()=>{}};
  const leases=[];
  try {
    for(let i=0;i<128;i++)leases.push(await manager.acquire({...input,server:{...input.server,workspaceRoot:`/w${i}`}}));
    await assert.rejects(manager.acquire({...input,server:{...input.server,workspaceRoot:'/overflow'}}),/已满/);
    assert.equal(closes,0);
    await leases[127].release();
    const call=leases[0].call('x',{},input); await new Promise(r=>setTimeout(r,0));
    const newer=await manager.acquire({...input,server:{...input.server,configurationId:'new'}});
    assert.ok(pending);pending();assert.deepEqual(await call,{content:[]});
    const continued = leases[0].call('x', {}, input);
    await new Promise(r=>setTimeout(r,0));
    assert.ok(pending);pending();assert.deepEqual(await continued,{content:[]});
    await leases[0].release();await newer.release();
  } finally {await Promise.all(leases.map(l=>l.release()));await manager.close();}
});

test("最后一个初始化等待者取消会关闭连接", async () => {
  let closed=0;let started=false;
  const manager=new McpConnectionManager(()=>new McpClient({async start(){started=true;},async send(){},async close(){closed++;}}));
  const controller=new AbortController();
  const pending=manager.acquire({server:{name:'s',workspaceRoot:'/w',configurationId:'c',secrets:[],config:{type:'stdio',command:'x',args:[],env:{}}},signal:controller.signal,deadlineMs:Date.now()+1000,revalidate:async()=>{}});
  await new Promise(r=>setTimeout(r,0));assert.equal(started,true);controller.abort();await assert.rejects(pending,/取消/);assert.ok(closed>0);await manager.close();
});

test("删除配置释放空闲连接，活动租约进入 draining", async () => {
  let closes=0;
  const manager=new McpConnectionManager(()=>{let h!:McpTransportHandlers;return new McpClient({async start(handlers){h=handlers;},async close(){closes++;},async send(m){if('method'in m&&'id'in m)h.message({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'t',version:'1'}}:m.method==='tools/call'?{content:[]}:{tools:[]}});}});});
  const input={server:{name:'s',workspaceRoot:'/w',configurationId:'c',secrets:[],config:{type:'stdio' as const,command:'x',args:[],env:{}}},signal:new AbortController().signal,deadlineMs:Date.now()+1000,revalidate:async()=>{}};
  try{
    const lease=await manager.acquire(input);await manager.reconcile('/w',[]);assert.equal(closes,0);assert.deepEqual(await lease.call('x',{},input),{content:[]});await lease.release();assert.ok(closes>0);
    const idle=await manager.acquire({...input,server:{...input.server,name:'idle'}});await idle.release();const before=closes;await manager.reconcile('/w',[]);assert.ok(closes>before);
  }finally{await manager.close();}
});
