import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {runtimeFixture,waitUntil} from "./helpers/runtime-fixture";
import {call,say} from "./helpers/skill-fixture";
import {agentTaskHttp} from "@/web/agent-task-http";

for(const transition of ['automatic','explicit','manual','wait-timeout'] as const)test(`内置general在${transition}后无需审批完成同一次执行`,async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let parents=0,children=0;
 const f=await runtimeFixture(async request=>{
  if(JSON.stringify(request.body).includes('orbitcode_child_role')){if(++children===1){await gate;return call('write_file',{path:'direct.txt',content:'DIRECT_CHILD'},'write');}if(children===2)return call('run_command',{command:'node --version'},'command');return say('子完成');}
  return ++parents===1?call('agent',{operation:'start',task:{kind:'defined',role:'general',prompt:'创建文件并执行本地命令',background:transition==='explicit'}},'delegate'):say('父完成');
 },{terminal:true,subAgentLimits:{waitSeconds:1}});
 try{
  await f.runtime.memory.setEnabled(false);await f.controller.handleLine('委派开发');const scope=await f.runtime.taskScope((await f.checkpoint()).summary.id),task=f.runtime.tasks.list(scope)[0];
  if(transition==='manual')f.runtime.tasks.detach(scope,task.id);
  if(transition==='wait-timeout')await f.runtime.tasks.wait(scope,task.id,1,new AbortController().signal);
  await waitUntil(()=>f.runtime.tasks.get(scope,task.id).background);release();
  const done=await f.runtime.tasks.wait(scope,task.id,3000,new AbortController().signal);assert.equal(done.task.state.status,'terminal');if(done.task.state.status!=='terminal')assert.fail('未结束');
  assert.equal(done.task.deadlineAt,task.deadlineAt);assert.equal(done.task.state.result.failureCount,0);assert.equal(done.task.state.result.handoff?.commandCalls.succeeded,1);assert.equal(await readFile(path.join(f.root,'direct.txt'),'utf8'),'DIRECT_CHILD');assert.equal(children,3);
  const req=(post=false)=>new Request('http://localhost/tasks',{method:post?'POST':'GET',headers:{host:'localhost',origin:'http://localhost','content-type':'application/json'},...(post?{body:'{}'}:{})});
  const listing=await agentTaskHttp(req(),scope.conversationId,f.runtime);assert.ok((await listing.json()).tasks.every((t:object)=>!('prompt' in t)));
  assert.equal((await agentTaskHttp(req(true),scope.conversationId,f.runtime,task.id,'decide')).status,410);
 }finally{release();await f.close();}
});
