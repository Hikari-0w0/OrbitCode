import { runKnowledgeCommand } from "@/cli/knowledge-commands";
import path from "node:path";
import { LocalConversationStore } from "@/lib/local-conversation-store";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { LocalSettingsStore } from "@/lib/local-settings-store";
import { knowledgeForWorkspace } from "@/runtime/knowledge/factory";
import { record } from "@/runtime/knowledge/config";
function run(dataRoot:string,prompt:string,maxIterations=8,conversationId?:string){return new Promise<{code:number|null;output:string}>((resolve,reject)=>{const child=spawn(process.execPath,["--import","tsx","src/cli/main.ts","run","--stdin",...(conversationId?["--resume",conversationId]:[]),"--output-format","jsonl","--data-dir",dataRoot,"--max-iterations",String(maxIterations)],{stdio:["pipe","pipe","pipe"]});let output="",error="";child.stdout.on("data",chunk=>output+=chunk.toString());child.stderr.on("data",chunk=>error+=chunk.toString());child.on("error",reject);child.on("exit",async code=>{try{const events=output.trim().split("\n").map(line=>JSON.parse(line) as unknown);const last=events[events.length-1];let saved="";if(record(last)&&record(last.result)&&typeof last.result.conversationId==="string")saved=JSON.stringify(await new LocalConversationStore(path.join(dataRoot,"conversations-v1")).load(last.result.conversationId));resolve({code,output:output+error+saved});}catch(error){reject(error);}});child.stdin.end(prompt);});}
test("独立 CLI 与共享 RAG 服务闭环、无效参数与最大轮数",{timeout:30000},async()=>{
 const provider=spawn(process.execPath,["--import","tsx","scripts/fixtures/knowledge-provider.ts"],{stdio:["ignore","pipe","pipe"]});let root="";
 try{
  const metadata=await new Promise<Record<string,unknown>>((resolve,reject)=>{let buffer="";provider.stdout.on("data",chunk=>{buffer+=chunk.toString();if(buffer.includes("\n")){try{const value:unknown=JSON.parse(buffer.split("\n")[0]);if(!record(value))throw new Error();resolve(value);}catch{reject(new Error("invalid fixture"));}}});provider.once("error",reject);provider.once("exit",()=>reject(new Error("provider exited")));});
  assert.equal(typeof metadata.root,"string");assert.equal(typeof metadata.dataRoot,"string");assert.equal(typeof metadata.workspaceId,"string");root=String(metadata.root);
  const store=new LocalSettingsStore(String(metadata.dataRoot)),service=await knowledgeForWorkspace(store,String(metadata.workspaceId));const cli={knowledge:(id:string)=>knowledgeForWorkspace(store,id),knowledgeSettingsStore:store};
  const configFile=path.join(root,"knowledge-config.json"),savedSettings=await store.load();await writeFile(configFile,JSON.stringify(savedSettings?.workspaces[0].knowledge),{mode:0o600});await runKnowledgeCommand(cli,String(metadata.workspaceId),`config ${configFile}`);
  await runKnowledgeCommand(cli,String(metadata.workspaceId),"build");let state=await service.status();for(let i=0;i<100&&state.operation?.state==="running";i++){await new Promise(resolve=>setTimeout(resolve,10));state=await service.status();}assert.equal(state.index.kind,"ready");
  const answer=await run(store.directory,"为什么切换工作区会新建会话？");assert.equal(answer.code,0,answer.output);assert.match(answer.output,/search_knowledge/);assert.match(answer.output,/read_file/);assert.match(answer.output,/docs\/workspace.md/);
  const settings=await store.load();assert.ok(settings);
  const plan=await new LocalConversationStore(path.join(store.directory,"conversations-v1")).create({providerId:settings.providers[0].id,workspaceId:String(metadata.workspaceId),mode:"plan"});
  const planAnswer=await run(store.directory,"为什么切换工作区会新建会话？",8,plan.summary.id);assert.equal(planAnswer.code,0,planAnswer.output);assert.match(planAnswer.output,/search_knowledge/);assert.match(planAnswer.output,/sourceLines/);assert.doesNotMatch(planAnswer.output,/模式.*拒绝/);
  const invalid=await run(store.directory,"测试无效参数");assert.match(invalid.output,/invalid-arguments/);
  const failed=await run(store.directory,"测试工具失败");assert.match(failed.output,/not-found/);
  const malicious=await run(store.directory,"测试恶意资料");assert.match(malicious.output,/protected-path/);assert.doesNotMatch(malicious.output,/SYNTHETIC_PRIVATE_SENTINEL/);
  if(process.platform==="darwin"){const timed=await run(store.directory,"测试命令超时");assert.match(timed.output,/timedOut/);}
  const limited=await run(store.directory,"测试最大轮数",2);assert.match(limited.output,/max-iterations/);
  for(const action of ["update","rebuild"]){await runKnowledgeCommand(cli,String(metadata.workspaceId),action);for(let n=0;n<100;n++){const current=await service.status();if(current.operation?.state!=="running"){assert.equal(current.operation?.state,"finished");break;}await new Promise(resolve=>setTimeout(resolve,10));}}
  await runKnowledgeCommand(cli,String(metadata.workspaceId),"cancel");await runKnowledgeCommand(cli,String(metadata.workspaceId),"delete");assert.equal((await service.status()).index.kind,"absent");await runKnowledgeCommand(cli,String(metadata.workspaceId),"off");assert.equal((await service.status()).enabled,false);await runKnowledgeCommand(cli,String(metadata.workspaceId),"on");assert.equal((await service.status()).enabled,true);
 }finally{await new Promise<void>(resolve=>{provider.once("exit",()=>resolve());provider.kill("SIGTERM");});if(root)await rm(root,{recursive:true,force:true});}
});
