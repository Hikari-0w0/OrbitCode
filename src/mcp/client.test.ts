import assert from "node:assert/strict";
import test from "node:test";
import { McpClient } from "./client";
import type { McpTransportHandlers } from "./types";
test("分页完整发布并拒绝循环 cursor，握手顺序固定", async () => {
  let handlers!: McpTransportHandlers;
  const methods: string[] = [];
  let looping = false;
  const client = new McpClient({ async start(h) { handlers = h; }, async close() {}, async send(m) {
    if (!("method" in m)) return;
    methods.push(m.method);
    if (!("id" in m)) return;
    handlers.message({ jsonrpc: "2.0", id: m.id, result: m.method === "initialize"
      ? { protocolVersion: "2025-11-25", serverInfo: { name: "t", version: "1" }, capabilities: { tools: {} } }
      : { tools: [], ...(!m.params?.cursor || looping ? { nextCursor: "next" } : {}) } });
  } });
  const options = { signal: new AbortController().signal, deadlineMs: Date.now() + 1000 };
  await client.initialize(options);
  assert.deepEqual(await client.listTools(options), []);
  assert.deepEqual(methods.slice(0, 3), ["initialize", "notifications/initialized", "tools/list"]);
  looping = true;
  await assert.rejects(client.listTools(options), /MCP/);
  await client.close();
});

test("握手能力和版本、目录重名／工具数／页数超限不发布部分列表", async () => {
  for (const mode of ["version", "capabilities", "duplicate", "tools", "pages"] as const) {
    let h!: McpTransportHandlers; let lists = 0;
    const client=new McpClient({async start(handlers){h=handlers;},async close(){},async send(m){
      if(!('method' in m)||!('id' in m))return;
      const tool={name:'same',inputSchema:{type:'object'}};
      if(m.method==='tools/list')lists++;
      h.message({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:mode==='version'?'bad':'2025-11-25',serverInfo:{name:'t',version:'1'},capabilities:mode==='capabilities'?{}:{tools:{}}}:mode==='duplicate'?{tools:[tool,tool]}:mode==='tools'?{tools:Array.from({length:129},(_,i)=>({...tool,name:`t${i}`}))}:{tools:[],nextCursor:String(lists)}});
    }});
    const options={signal:new AbortController().signal,deadlineMs:Date.now()+1000};
    try {
      if(mode==='version'||mode==='capabilities'){await assert.rejects(client.initialize(options));assert.equal(lists,0);}
      else {await client.initialize(options);await assert.rejects(client.listTools(options));if(mode==='pages')assert.equal(lists,32);}
    } finally {await client.close();}
  }
});
