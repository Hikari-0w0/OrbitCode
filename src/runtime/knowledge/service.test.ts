import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createWorkspaceBoundary } from "@/tools/workspace";
import { PermissionGateway } from "@/tools/permission-gateway";
import { parsePermissionRule } from "@/core/permissions/rules";
import type { PermissionRule } from "@/core/permissions/types";
import { KnowledgeAccess } from "./access";
import { KnowledgeService } from "./service";
import { DEFAULT_KNOWLEDGE_LIMITS, parseKnowledgeConfig, publicKnowledgeConfig } from "./config";
import { SettingsService } from "@/runtime/settings-service";
import { LocalSettingsStore } from "@/lib/local-settings-store";
import { KnowledgeStore } from "./store";
import { beginBuild } from "./lifecycle";
import { chunkFile } from "./chunker";
import { contentHash } from "./access";
export function fixtureConfig(){return parseKnowledgeConfig({enabled:true,endpoint:"http://127.0.0.1:4321/v1",model:"fixture",dimensions:2,credential:{kind:"none"},remoteEnabled:false,include:["**/*.ts","**/*.md"],exclude:[],includeHistorical:false,documentPrefix:"",queryPrefix:"",limits:DEFAULT_KNOWLEDGE_LIMITS});}
async function finished(service:KnowledgeService){for(let n=0;n<200;n++){const state=await service.status();if(state.operation?.state!=="running")return state;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error("build timeout");}
test("配置不回显凭据、保存无网络，旧设置兼容",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"orbitcode-knowledge-settings-"));
 try{const store=new LocalSettingsStore(path.join(root,"private")),service=new SettingsService(store);let view=await service.apply(0,{type:"workspace-add",name:"project",rootPath:root});const config={...fixtureConfig(),credential:{kind:"local" as const,value:"SYNTHETIC_SECRET"}};view=await service.apply(view.revision,{type:"knowledge-set",id:view.workspaces[0].id,config});assert.ok(!JSON.stringify(view).includes("SYNTHETIC_SECRET"));assert.ok(!JSON.stringify(publicKnowledgeConfig(config)).includes("SYNTHETIC_SECRET"));assert.throws(()=>parseKnowledgeConfig({...config,endpoint:"http://example.com"}));assert.throws(()=>parseKnowledgeConfig({...config,endpoint:"https://example.com",remoteEnabled:false}));}
 finally{await rm(root,{recursive:true,force:true});}
});
test("混合检索闭环、哈希复用、过期与权限过滤、关键词降级、删除与停用",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"orbitcode-knowledge-service-"));
 try{
  await mkdir(path.join(root,"src"));await mkdir(path.join(root,"docs/archive"),{recursive:true});await writeFile(path.join(root,"src/session.ts"),"export function switchWorkspace() { return 'new conversation'; }\n");await writeFile(path.join(root,"docs/design.md"),"# 工作区隔离\n切换工作区会创建新会话。\n");await writeFile(path.join(root,"docs/archive/old.md"),"# 旧设计\nOLD_SENTINEL");await writeFile(path.join(root,".env.local"),"SYNTHETIC_SECRET");
  const workspace=await createWorkspaceBoundary(root);let config=fixtureConfig();let rules:PermissionRule[]=[];let calls=0,down=false;
  const gateway=new PermissionGateway({workspace,agentMode:"plan",loadRules:async()=>rules});
  const service=new KnowledgeService({dataRoot:path.join(root,"private"),access:new KnowledgeAccess(workspace,gateway),loadConfig:async()=>config,provider:(_config,before)=>({embed:async(texts,signal)=>{signal.throwIfAborted();await before();calls++;if(down)throw new Error("down");return {vectors:texts.map(()=>[1,0]),usage:{kind:"reported",inputTokens:texts.length}};}})});
  await service.start();let state=await finished(service);assert.equal(state.index.kind,"ready",JSON.stringify(state));assert.equal(state.operation?.report?.files,2);assert.equal(state.operation?.report?.requests,1);
  const result=await service.search({query:"切换工作区",scope:"all",limit:6},new AbortController().signal);assert.equal(result.kind,"results");if(result.kind!=="results")return;assert.ok(result.hits.some(hit=>hit.path==="docs/design.md"));assert.ok(result.hits.some(hit=>hit.matchedBy.includes("semantic")));assert.ok(!JSON.stringify(result).includes("OLD_SENTINEL"));
  const afterQuery=calls;await service.start();state=await finished(service);assert.equal(calls,afterQuery);assert.ok((state.operation?.report?.reused??0)>0);
  await writeFile(path.join(root,"docs/design.md"),"# 工作区隔离\nNEW_CONTENT\n");rules=[parsePermissionRule({expression:"read_file(src/session.ts)",decision:"deny",source:"local",toolTargets:new Map([["read_file","path"]])})];
  const stale=await service.search({query:"工作区",scope:"all",limit:6},new AbortController().signal);assert.equal(stale.kind,"results");if(stale.kind==="results"){assert.equal(stale.hits.length,0);assert.ok(stale.staleCount>=1);}
  rules=[];await service.start();await finished(service);down=true;const fallback=await service.search({query:"NEW_CONTENT",scope:"docs",limit:6},new AbortController().signal);assert.equal(fallback.kind,"results");if(fallback.kind==="results"){assert.equal(fallback.retrieval,"keyword-fallback");assert.ok(fallback.hits.length);}
  down=false;await writeFile(path.join(root,"new.md"),"# new knowledge\nnew evidence");await rm(path.join(root,"src/session.ts"));
  const deleted=await service.search({query:"switchWorkspace",scope:"all",limit:6},new AbortController().signal);if(deleted.kind==="results")assert.ok(deleted.hits.every(hit=>hit.path!=="src/session.ts"));
  config={...config,exclude:["docs/design.md"]};await service.start();state=await finished(service);assert.equal(state.operation?.report?.files,1);
  config={...config,dimensions:3};const mismatch=await service.search({query:"hello",scope:"all",limit:6},new AbortController().signal);assert.equal(mismatch.kind,"failure");if(mismatch.kind==="failure")assert.equal(mismatch.code,"incompatible");
  await service.delete();assert.equal((await service.status()).index.kind,"absent");config={...config,enabled:false};const disabled=await service.search({query:"hello",scope:"all",limit:6},new AbortController().signal);assert.equal(disabled.kind,"failure");if(disabled.kind==="failure")assert.equal(disabled.code,"disabled");
 }finally{await rm(root,{recursive:true,force:true});}
});
test("构建互斥与删除禁止旧作业提交",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"orbitcode-knowledge-lock-"));try{const store=new KnowledgeStore(root,root);const first=await beginBuild(store);await assert.rejects(beginBuild(store),/已有索引构建/);await store.invalidate();assert.notEqual((await store.control()).epoch,first.epoch);await first.release();const next=await beginBuild(store);await next.release();}finally{await rm(root,{recursive:true,force:true});}
});
test("结构分块来源与超长行",()=>{
 const content="export class Session {\n  resume() { return 1; }\n}\n",chunks=chunkFile({path:"src/session.ts",content,hash:contentHash(content)});assert.ok(chunks.some(chunk=>chunk.label.includes("resume")));for(const chunk of chunks)assert.equal(chunk.excerpt,content.split("\n").slice(chunk.startLine-1,chunk.endLine).join("\n"));assert.throws(()=>chunkFile({path:"a.ts",content:"a".repeat(5000),hash:"h"}));
});

test("跨进程锁、崩溃恢复保留明确中断状态",async()=>{
 const {spawn}=await import("node:child_process");const root=await mkdtemp(path.join(tmpdir(),"orbitcode-knowledge-process-"));
 const code=`import {KnowledgeStore} from './src/runtime/knowledge/store.ts';import {beginBuild} from './src/runtime/knowledge/lifecycle.ts';const lease=await beginBuild(new KnowledgeStore(process.argv[1],process.argv[1]));process.stdout.write('READY\\n');process.stdin.resume();process.stdin.on('end',async()=>{await lease.release();process.exit(0)});`;
 const child=spawn(process.execPath,["--import","tsx","--input-type=module","-e",code,root],{stdio:["pipe","pipe","pipe"]});
 try{await new Promise<void>((resolve,reject)=>{child.stdout.once("data",()=>resolve());child.once("error",reject);child.once("exit",code=>reject(new Error(`child exited ${code}`)));});const store=new KnowledgeStore(root,root);await assert.rejects(beginBuild(store),/已有索引构建/);await new Promise<void>(resolve=>{child.once("exit",()=>resolve());child.kill("SIGKILL");});const {recoverStatus}=await import("./lifecycle");assert.equal((await recoverStatus(store)).operation?.state,"failed");const lease=await beginBuild(store);await lease.release();}
 finally{child.kill();await rm(root,{recursive:true,force:true});}
});
test("删除会中止在途构建，损坏数据不会被伪装成无命中",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"orbitcode-knowledge-delete-"));try{
  await writeFile(path.join(root,"a.md"),"# hello\nworld");const workspace=await createWorkspaceBoundary(root),gateway=new PermissionGateway({workspace,agentMode:"plan",loadRules:async()=>[]});let entered=false,hang=true;
  const service=new KnowledgeService({dataRoot:path.join(root,"private"),access:new KnowledgeAccess(workspace,gateway),loadConfig:async()=>fixtureConfig(),provider:(_config,before)=>({embed:async(texts,signal)=>{await before();entered=true;if(hang)await new Promise<void>((resolve,reject)=>{if(signal.aborted)return reject(new Error("cancelled"));signal.addEventListener("abort",()=>reject(new Error("cancelled")),{once:true});});return {vectors:texts.map(()=>[1,0]),usage:{kind:"unknown"}};}})});
  await service.start();while(!entered)await new Promise(resolve=>setTimeout(resolve,5));await service.delete();await new Promise(resolve=>setTimeout(resolve,150));assert.equal((await service.status()).index.kind,"absent");
  hang=false;await service.start(true);const state=await finished(service);assert.equal(state.index.kind,"ready");await writeFile(path.join(service.store.directory,`${state.index.version}.vectors`),"broken");const result=await service.search({query:"hello",scope:"all",limit:6},new AbortController().signal);assert.equal(result.kind,"failure");if(result.kind==="failure")assert.equal(result.code,"corrupt-index");
 }finally{await rm(root,{recursive:true,force:true});}
});
test("同一物理目录的不同工作区身份仍隔离索引",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"orbitcode-knowledge-identity-"));try{
  await writeFile(path.join(root,"a.md"),"# 工作区\n隔离索引");const workspace=await createWorkspaceBoundary(root),gateway=new PermissionGateway({workspace,agentMode:"plan",loadRules:async()=>[]});
  const options={dataRoot:path.join(root,"private"),access:new KnowledgeAccess(workspace,gateway),loadConfig:async()=>fixtureConfig(),provider:()=>({embed:async(texts:readonly string[])=>({vectors:texts.map(()=>[1,0]),usage:{kind:"unknown" as const}})})};
  const first=new KnowledgeService({...options,workspaceIdentity:"first"}),second=new KnowledgeService({...options,workspaceIdentity:"second"});assert.notEqual(first.store.directory,second.store.directory);await first.start();assert.equal((await finished(first)).index.kind,"ready");const result=await second.search({query:"工作区",scope:"all",limit:6},new AbortController().signal);assert.equal(result.kind,"failure");if(result.kind==="failure")assert.equal(result.code,"not-indexed");
 }finally{await rm(root,{recursive:true,force:true});}
});
test("服务请求预算、扫描上限与查询降级均有界且保留旧版本",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"orbitcode-knowledge-budget-"));try{
  for(let i=0;i<20;i++)await writeFile(path.join(root,`file-${i}.md`),`# workspace ${i}\nworkspace isolation\n`);
  const workspace=await createWorkspaceBoundary(root),gateway=new PermissionGateway({workspace,agentMode:"plan",loadRules:async()=>[]});let config=fixtureConfig(),requests=0;
  const service=new KnowledgeService({dataRoot:path.join(root,"private"),access:new KnowledgeAccess(workspace,gateway),loadConfig:async()=>config,provider:(_config,before)=>({embed:async texts=>{await before();requests++;return {vectors:texts.map(()=>[1,0]),usage:{kind:"unknown"}};}})});
  await service.start();const initial=await finished(service);assert.equal(initial.index.kind,"ready");assert.equal(requests,2);
  config={...config,limits:{...config.limits,maxRequests:1}};requests=0;await service.start(true);const failed=await finished(service);assert.equal(failed.operation?.state,"failed");assert.equal(failed.index.version,initial.index.version);assert.equal(requests,1);
  config={...config,limits:{...config.limits,maxChunks:1}};await service.start(true);assert.equal((await finished(service)).operation?.state,"failed");
  config={...config,limits:{...config.limits,maxFiles:1}};await service.start();const capped=await finished(service);assert.equal(capped.operation?.state,"failed");assert.equal(capped.index.version,initial.index.version);
  config={...fixtureConfig(),dimensions:4096};await writeFile(path.join(root,"large.ts"),Array.from({length:3000},(_,n)=>`export function item${n}(){return ${n};}`).join("\n"));requests=0;await service.start(true);assert.equal((await finished(service)).operation?.state,"failed");assert.equal(requests,0);await rm(path.join(root,"large.ts"));
  config=fixtureConfig();requests=0;let last;for(let n=0;n<9;n++)last=await service.search({query:"workspace",scope:"docs",limit:6},new AbortController().signal);assert.equal(requests,8);assert.equal(last?.kind,"results");if(last?.kind==="results")assert.equal(last.degradedReason,"semantic-budget-exhausted");
  const controller=new AbortController();controller.abort();const cancelled=await service.search({query:"workspace",scope:"all",limit:6},controller.signal);assert.equal(cancelled.kind,"failure");if(cancelled.kind==="failure")assert.equal(cancelled.code,"cancelled");assert.equal(requests,8);
 }finally{await rm(root,{recursive:true,force:true});}
});
test("规则配置失败、索引目录和源文件符号链接替换均安全拒绝",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"orbitcode-knowledge-security-")),outside=await mkdtemp(path.join(tmpdir(),"orbitcode-knowledge-outside-"));try{
  await writeFile(path.join(root,"safe.md"),"# safe\nSAFE_SENTINEL");await writeFile(path.join(outside,"secret.md"),"OUTSIDE_SENTINEL");let broken=false;
  const workspace=await createWorkspaceBoundary(root),gateway=new PermissionGateway({workspace,agentMode:"plan",loadRules:async()=>{if(broken)throw new Error("invalid config");return [];}}),access=new KnowledgeAccess(workspace,gateway);
  const service=new KnowledgeService({dataRoot:path.join(root,"private"),access,loadConfig:async()=>fixtureConfig(),provider:(_config,before)=>({embed:async texts=>{await before();return {vectors:texts.map(()=>[1,0]),usage:{kind:"unknown"}};}})});
  await service.start();assert.equal((await finished(service)).index.kind,"ready");
  const privatePath=path.relative(root,path.join(service.store.directory,"current.json"));await assert.rejects(workspace.readTextFile(privatePath,{maxBytes:65536}));
  broken=true;await assert.rejects(access.read("safe.md",1024,new AbortController().signal),/不可读取/);const denied=await service.search({query:"safe",scope:"all",limit:6},new AbortController().signal);if(denied.kind==="results")assert.equal(denied.hits.length,0);
  broken=false;await rm(path.join(root,"safe.md"));await symlink(path.join(outside,"secret.md"),path.join(root,"safe.md"));const swapped=await service.search({query:"safe",scope:"all",limit:6},new AbortController().signal);assert.equal(swapped.kind,"results");if(swapped.kind==="results")assert.equal(swapped.hits.length,0);assert.doesNotMatch(JSON.stringify(swapped),/OUTSIDE_SENTINEL|secret\.md/);
 }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
test("公开资源限制边界不可通过本地配置扩大",()=>{
 const excessive={maxFiles:10001,maxFileBytes:1048577,maxScanBytes:134217729,maxChunks:20001,concurrency:5,requestTimeoutMs:30001,maxRetries:2,buildTimeoutMs:1800001,maxRequests:2001,queryTimeoutMs:30001,evidenceCharacters:16001};
 for(const [name,value] of Object.entries(excessive))assert.throws(()=>parseKnowledgeConfig({...fixtureConfig(),limits:{...DEFAULT_KNOWLEDGE_LIMITS,[name]:value}}));
});
