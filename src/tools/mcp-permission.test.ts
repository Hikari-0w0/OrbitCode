import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePermission } from "@/core/permissions/evaluator";
import { parsePermissionRule } from "@/core/permissions/rules";
import type { PermissionSubject } from "@/core/permissions/types";
import { PermissionGateway } from "@/tools/permission-gateway";
import { createWorkspaceBoundary } from "@/tools/workspace";
import { PermissionSessionManager } from "@/runtime/permission-session-manager";
import type { PermissionOperation } from "@/tools/registry";
import { toolFailure } from "@/tools/types";

const subject: PermissionSubject = { kind: "mcp", toolKind: "external", toolName: "mcp__demo", operation: "call", serverName: "demo", configurationId: "config", toolIdentity: { originalName: "echo", schemaId: "schema", argumentsId: "args" } };
test("MCP 严格和默认模式询问，放行模式允许，独立规则离线可解析且 deny 优先", () => {
  for (const mode of ["strict", "default"] as const) assert.equal(evaluatePermission({ subject, mode, rules: [] }).kind, "ask");
  for (const operation of ["connect", "call"] as const) assert.equal(evaluatePermission({ subject: { ...subject, operation }, mode: "permissive", rules: [] }).kind, "allow");
  const rule = (expression: string, decision: "allow" | "deny" | "ask") => parsePermissionRule({ expression, decision, source: "local", toolTargets: new Map() });
  assert.equal(evaluatePermission({ subject, mode: "default", rules: [rule("mcp_connect(*)", "allow")] }).kind, "ask");
  assert.equal(evaluatePermission({ subject, mode: "permissive", rules: [rule("mcp_call(*)", "ask")] }).kind, "ask");
  assert.equal(evaluatePermission({ subject, mode: "permissive", rules: [rule("mcp_call(*)", "allow"), rule("mcp_call(*)", "ask"), rule("mcp_call(*)", "deny")] }).kind, "deny");
});
test("启动批准绑定配置，Plan 硬拒绝，审批后复检不通过则不执行", async () => {
  const sessions = new PermissionSessionManager();
  const session = sessions.createSession();
  const turn = sessions.beginTurn(session.id, { workspace: { id: "w", name: "w" }, providerId: "p" });
  const workspace = await createWorkspaceBoundary(process.cwd());
  let changed = false;
  const operation: PermissionOperation = { name: "mcp_connect", mutability: "external", fingerprint: "config", permissionTarget: { kind: "mcp", operation: "connect", serverName: "demo", configurationId: "config", summary: {} }, revalidate: async () => changed ? toolFailure("approval-invalid", "配置变化") : undefined };
  const gateway = (agentMode: "plan" | "do") => new PermissionGateway({ agentMode, permissionMode: "default", workspace, broker: turn.broker, loadRules: async () => [] });
  const signal = new AbortController().signal;
  assert.equal((await gateway("plan").authorizeConnection(operation, "start", signal)).kind, "denied");
  const pending = await gateway("do").authorizeConnection(operation, "start", signal);
  assert.equal(pending.kind, "awaiting");
  if (pending.kind === "awaiting") {
    changed = true;
    sessions.resolveDecision(session.id, pending.prompt.requestId, "allow-once");
    assert.equal((await pending.resolve()).kind, "denied");
  }
  sessions.finishTurn(session.id, turn.id); sessions.closeSession(session.id);
});

test("MCP 会话与永久批准绑定配置、定义和参数，跨会话及新增 deny 不复用", async () => {
  const { createMcpTool } = await import("./mcp-tool");
  const sessions=new PermissionSessionManager();const session=sessions.createSession();const other=sessions.createSession();
  const binding={workspace:{id:"w",name:"w"},providerId:"p"};
  const turn=sessions.beginTurn(session.id,binding);const otherTurn=sessions.beginTurn(other.id,binding);
  const workspace=await createWorkspaceBoundary(process.cwd());
  let rules: import("@/core/permissions/types").PermissionRule[]=[];
  const gateway=(broker=turn.broker)=>new PermissionGateway({agentMode:"do",permissionMode:"default",workspace,broker,loadRules:async()=>rules,persistAllow:async(expression)=>{rules.push(parsePermissionRule({expression,decision:"allow",source:"local",toolTargets:new Map()}));}});
  const prepare=(n:number,config="c",description="echo")=>{const result=createMcpTool({name:"echo",description,inputSchema:{type:"object"}},{serverName:"demo",configurationId:config,redact:v=>v,revalidate:async()=>undefined,call:async()=>({content:[]})}).prepareUnknown({n});assert.equal(result.kind,"ready");if(result.kind!=="ready")throw new Error();return result.call;};
  const signal=new AbortController().signal;
  try{
    const approved=await gateway().authorize(prepare(1),"a",signal);assert.equal(approved.kind,"awaiting");
    if(approved.kind!=="awaiting")throw new Error();
    assert.throws(()=>sessions.resolveDecision(other.id,approved.prompt.requestId,"allow-once"));
    sessions.resolveDecision(session.id,approved.prompt.requestId,"allow-session");assert.equal((await approved.resolve()).kind,"allowed");
    assert.throws(()=>sessions.resolveDecision(session.id,approved.prompt.requestId,"allow-once"));
    assert.equal((await gateway().authorize(prepare(1),"same",signal)).kind,"allowed");
    for(const call of [prepare(2),prepare(1,"different"),prepare(1,"c","changed")]){
      const pending=await gateway().authorize(call,"changed",signal);assert.equal(pending.kind,"awaiting");if(pending.kind==="awaiting"){sessions.resolveDecision(session.id,pending.prompt.requestId,"deny");await pending.resolve();}
    }
    const cross=await gateway(otherTurn.broker).authorize(prepare(1),"cross",signal);assert.equal(cross.kind,"awaiting");
    if(cross.kind==="awaiting"){sessions.resolveDecision(other.id,cross.prompt.requestId,"allow-permanent");assert.equal((await cross.resolve()).kind,"allowed");}
    assert.equal(rules.length,1);
    const allowed=await gateway().authorize(prepare(1),"permanent",signal);assert.equal(allowed.kind,"allowed");
    rules=[...rules,parsePermissionRule({expression:"mcp_call(*)",decision:"deny",source:"user",toolTargets:new Map()})];
    if(allowed.kind==="allowed")assert.equal((await allowed.revalidate(signal))?.ok,false);
  }finally{sessions.finishTurn(session.id,turn.id);sessions.finishTurn(other.id,otherTurn.id);sessions.closeSession(session.id);sessions.closeSession(other.id);}
});
