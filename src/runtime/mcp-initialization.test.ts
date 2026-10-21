import assert from "node:assert/strict";
import test from "node:test";
import { initializeMcpWorkspace } from "./mcp-initialization";
import { McpConnectionManager, type McpConnectionLease } from "./mcp-connections";
import { McpClient } from "@/mcp/client";
import type { McpTransportHandlers } from "@/mcp/types";
import { PermissionGateway } from "@/tools/permission-gateway";
import { parsePermissionRule } from "@/core/permissions/rules";
import { createWorkspaceBoundary } from "@/tools/workspace";
import type { McpConfigSnapshot } from "./mcp-config";

test("多个 Server 故障隔离，工作区工具数／定义容量有界且目录不部分发布", async () => {
  for (const large of [false, true]) {
    let calls = 0;
    const manager = new McpConnectionManager(server => {
      let h!: McpTransportHandlers;
      return new McpClient({ async start(handlers) { h = handlers; if (server.name === "bad") throw new Error(); }, async close() {}, async send(m) {
        if (!("method" in m) || !("id" in m)) return;
        calls++;
        const tools = Array.from({length: large ? 100 : 128}, (_,i) => ({name:`tool${i}`, description: large ? "x".repeat(3000) : "tool", inputSchema:{type:"object"}}));
        h.message({jsonrpc:"2.0",id:m.id,result:m.method==="initialize"?{protocolVersion:"2025-11-25",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}:{tools}});
      }});
    });
    const snapshot: McpConfigSnapshot = { diagnostics: [], servers: ["bad", "good1", "good2", "good3"].map(name => ({ name, workspaceRoot: process.cwd(), configurationId:name, secrets:[],config:{type:"stdio",command:"unused",args:[],env:{}} })) };
    const workspace = await createWorkspaceBoundary(process.cwd());
    const gateway = new PermissionGateway({agentMode:"do",permissionMode:"default",workspace,loadRules:async()=>[parsePermissionRule({expression:"mcp_connect(*)",decision:"allow",source:"local",toolTargets:new Map()})]});
    const leases: McpConnectionLease[]=[];
    try {
      const generator=initializeMcpWorkspace({workspaceRoot:process.cwd(),mode:"do",signal:new AbortController().signal,deadlineMs:Date.now()+2000,load:async()=>snapshot,manager,gateway,leases});
      const phases:string[]=[];
      for (;;) {const next=await generator.next();if(next.done){assert.equal(next.value.length,large?100:256);break;} if(next.value.type==="mcp-status")phases.push(`${next.value.serverName}:${next.value.phase}`);}
      assert.ok(phases.includes("bad:unavailable"));assert.ok(phases.includes("good1:ready"));assert.ok(phases.includes("good3:unavailable"));
      const before=calls;
      const plan=initializeMcpWorkspace({workspaceRoot:process.cwd(),mode:"plan",signal:new AbortController().signal,deadlineMs:Date.now()+100,load:async()=>{throw new Error("Plan 不加载 MCP");},manager,gateway,leases});
      assert.deepEqual((await plan.next()).value,[]);assert.equal(calls,before);
    } finally {await Promise.all(leases.map(l=>l.release()));await manager.close();}
  }
});
