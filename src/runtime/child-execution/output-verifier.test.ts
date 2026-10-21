import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseChildOutputContract } from "@/core/sub-agents/output-contract";
import { createWorkspaceBoundary } from "@/tools/workspace";
import { successfulToolResult } from "@/tools/registry";
import { toolFailure } from "@/tools/types";
import { PermissionGateway } from "@/tools/permission-gateway";
import { WorkspaceExecutionCoordinator } from "@/runtime/workspace-execution-coordinator";
import { parsePermissionRule } from "@/core/permissions/rules";
import { assessChildOutput, readOutputArtifact } from "./output-verifier";

test("产物契约拒绝穿越、重复、未知字段、长文本及模型伪造通过状态", () => {
  for (const value of [{files:[]}, {files:[{path:"../secret"}]}, {files:[{path:"/secret"}]}, {files:[{path:"C:/secret"}]}, {files:[{path:"a"},{path:"a"}]}, {files:[{path:"a",status:"passed"}]}, {files:[{path:"a",contains:"中".repeat(100)}]}]) assert.throws(() => parseChildOutputContract(value));
  assert.deepEqual(parseChildOutputContract({files:[{path:"a",contains:"原文"}]}), {version:1,files:[{path:"a",contains:"原文"}]});
});

test("只从独立读取计算文件检查，失败、未运行与通过分开且不泄露正文", async () => {
  const contract = parseChildOutputContract({files:[{path:"ok",contains:"needle",sha256:createHash("sha256").update("needle-secret").digest("hex")},{path:"wrong",contains:"target"},{path:"missing"},{path:"denied"}]});
  const assessment = await assessChildOutput(contract, async file => file === "missing" ? toolFailure("not-found","内部路径") : file === "denied" ? toolFailure("permission-denied","内部原因") : successfulToolResult({content:file === "ok" ? "needle-secret" : "wrong"}));
  assert.deepEqual(assessment.artifacts.map(file => file.status), ["passed","failed","failed","not-run"]);
  assert.equal(assessment.scope,"declared-file-checks-only"); assert.equal(assessment.status,"failed");
  assert.ok(!JSON.stringify(assessment).includes("needle-secret")); assert.ok(!JSON.stringify(assessment).includes("内部"));
});

test("真实文件验收经过工作区边界、权限与等待后的能力复查", async () => {
  const root = await mkdtemp(path.join(tmpdir(),"output-verifier-")), outside = await mkdtemp(path.join(tmpdir(),"output-outside-"));
  const workspace = await createWorkspaceBoundary(root), writes = new WorkspaceExecutionCoordinator();
  let allowed = true, denied = false;
  const context = {workspace, signal:new AbortController().signal, deadlineMs:Date.now()+5000};
  const gateway = new PermissionGateway({agentMode:"do",permissionMode:"permissive",workspace,
    loadRules:async()=>denied?[parsePermissionRule({expression:"read_file(*)",decision:"deny",source:"local",toolTargets:new Map([["read_file","path"]])})]:[]});
  const read = (file:string) => readOutputArtifact({path:file,context,tools:async()=>new Set(allowed?["read_file"]:[]),gateway,writes});
  try {
    await writeFile(path.join(root,"out.txt"),"actual"); await writeFile(path.join(outside,"secret.txt"),"SECRET"); await symlink(path.join(outside,"secret.txt"),path.join(root,"link.txt"));
    assert.equal((await read("out.txt")).ok,true); assert.equal((await read("link.txt")).ok,false);
    denied = true; assert.equal((await read("out.txt")).ok,false); denied = false;
    const release = await writes.acquire(root,context.signal);
    const waiting = read("out.txt");
    for(let i=0;i<12;i++)await Promise.resolve();
    allowed = false; release();
    const revoked = await waiting; assert.ok(!revoked.ok && revoked.error.kind === "permission-denied");
  } finally { await rm(root,{recursive:true,force:true}); await rm(outside,{recursive:true,force:true}); }
});
