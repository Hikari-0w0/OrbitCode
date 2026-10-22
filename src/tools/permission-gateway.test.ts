import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parsePermissionRule } from "@/core/permissions/rules";
import type {
  PermissionDecision,
  PermissionRule,
} from "@/core/permissions/types";
import {
  PermissionGateway,
  type PermissionAuthorization,
} from "@/tools/permission-gateway";
import type { PreparedToolCall } from "@/tools/registry";
import { createWorkspaceBoundary } from "@/tools/workspace";
const toolTargets = new Map([
  ["read_file", "path"],
  ["write_file", "path"],
  ["run_command", "command"],
] as const);

for (const mode of ["strict", "default", "permissive"] as const) test(`旧${mode}模式不产生审批等待，文件和命令直接获得执行许可`, async () => {
  const f = await createFixture(); try {
    for (const call of [preparedPath("write_file", "out.txt", "write-target"), preparedCommand("node --version")]) {
      const decision = await f.gateway({permissionMode:mode}).authorize(call,"direct",new AbortController().signal);
      assert.equal(decision.kind,"allowed");if(decision.kind==='allowed')assert.equal(await decision.revalidate(new AbortController().signal),undefined);
    }
  } finally { await f.cleanup(); }
});

test("旧ask规则兼容为允许，但显式deny始终优先",async()=>{
 const f=await createFixture();try{f.rules.push(rule('write_file(*)','ask'));assert.equal((await f.gateway().authorize(preparedPath('write_file','out.txt','write-target'),'ask',new AbortController().signal)).kind,'allowed');f.rules.push(rule('write_file(out.txt)','deny'));assertDenied(await f.gateway().authorize(preparedPath('write_file','out.txt','write-target'),'deny',new AbortController().signal),'permission-denied');}finally{await f.cleanup();}
});

test("Plan禁写与危险命令继续硬拒绝",async()=>{
 const f=await createFixture();try{assertDenied(await f.gateway({agentMode:'plan'}).authorize(preparedPath('write_file','out.txt','write-target'),'plan',new AbortController().signal),'permission-denied');f.rules.push(rule('run_command(*)','allow'));assertDenied(await f.gateway().authorize(preparedCommand('rm -rf .'),'danger',new AbortController().signal),'dangerous-operation');}finally{await f.cleanup();}
});

test("执行前新增deny使已有许可失效",async()=>{
 const f=await createFixture();try{const d=await f.gateway().authorize(preparedPath('write_file','out.txt','write-target'),'write',new AbortController().signal);assert.equal(d.kind,'allowed');f.rules.push(rule('write_file(out.txt)','deny'));if(d.kind==='allowed'){const failure=await d.revalidate(new AbortController().signal);assert.ok(failure&&!failure.ok&&failure.error.kind==='approval-invalid');}}finally{await f.cleanup();}
});

test("完整指纹变化拒绝执行，取消信号不授予许可",async()=>{
 const f=await createFixture();try{const call={...preparedPath('write_file','out.txt','write-target')};const d=await f.gateway().authorize(call,'write',new AbortController().signal);call.fingerprint='changed';if(d.kind==='allowed'){const failure=await d.revalidate(new AbortController().signal);assert.ok(failure&&!failure.ok&&failure.error.kind==='approval-invalid');}const c=new AbortController();c.abort();assertDenied(await f.gateway().authorize(call,'cancel',c.signal),'cancelled');}finally{await f.cleanup();}
});

test("路径越界与权限读取失败均关闭执行路径",async()=>{
 const f=await createFixture();try{assertDenied(await f.gateway().authorize(preparedPath('read_file','../outside.txt','existing-file'),'outside',new AbortController().signal),'workspace-boundary');const workspace=await createWorkspaceBoundary(f.root);const gateway=new PermissionGateway({agentMode:'do',workspace,loadRules:async()=>{throw new Error('配置损坏');}});assertDenied(await gateway.authorize(preparedPath('write_file','out.txt','write-target'),'broken',new AbortController().signal),'permission-config');}finally{await f.cleanup();}
});

function rule(expression: string, decision: PermissionDecision): PermissionRule {
  return parsePermissionRule({
    expression,
    decision,
    source: "local",
    toolTargets,
  });
}

function assertDenied(
  authorization: PermissionAuthorization,
  errorKind: string,
): void {
  assert.equal(authorization.kind, "denied");
  if (authorization.kind !== "denied") return;
  assert.equal(
    authorization.result.ok ? undefined : authorization.result.error.kind,
    errorKind,
  );
  assert.equal(authorization.result.sideEffect, "none");
}

function preparedCommand(command: string): PreparedToolCall {
  return {
    name: "run_command",
    mutability: "command",
    permissionTarget: { kind: "command", command },
    fingerprint: `fingerprint:${command}`,
    async execute() {
      throw new Error("测试不执行命令");
    },
  };
}

function preparedPath(
  name: "read_file" | "write_file",
  requestedPath: string,
  resolution: "existing-file" | "write-target",
  onExecute: () => void = () => undefined,
): PreparedToolCall {
  return {
    name,
    mutability: name === "read_file" ? "read-only" : "workspace-write",
    permissionTarget: { kind: "path", requestedPath, resolution },
    fingerprint: `fingerprint:${requestedPath}`,
    async execute() {
      onExecute();
      throw new Error("测试不执行文件工具");
    },
  };
}

async function createFixture() {
 const root=await mkdtemp(path.join(tmpdir(),'orbitcode-gateway-'));await mkdir(path.join(root,'src'));await writeFile(path.join(root,'src/main.ts'),'export {};');
 const workspace=await createWorkspaceBoundary(root),rules:PermissionRule[]=[];
 return {root,rules,gateway:(options:{agentMode?:'plan'|'do';permissionMode?:'strict'|'default'|'permissive'}={})=>new PermissionGateway({agentMode:options.agentMode??'do',permissionMode:options.permissionMode??'default',workspace,loadRules:async()=>rules}),cleanup:()=>rm(root,{recursive:true,force:true})};
}
