import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {runtimeFixture} from './helpers/runtime-fixture';
import {subAgentFixture} from './helpers/sub-agent-fixture';
import {call,say} from './helpers/skill-fixture';
import {toolCallDelta,TOOL_FINISH_EVENT,TRANSPORT_DONE_EVENT} from './helpers/openai-mock';

test('未知角色或模型在接纳前拒绝，零子模型请求与零任务记录',async()=>{
 for(const role of ['unknown-role','unknown-model']){
  let parent=0,children=0;
  const f=await runtimeFixture(request=>{if(JSON.stringify(request.body).includes('orbitcode_child_role')){children++;return say('不得执行');}return ++parent===1?call('agent',{operation:'start',task:{kind:'defined',role,prompt:'不得执行'}},'invalid-role'):say('已观察拒绝');});
  try{await f.runtime.memory.setEnabled(false);const dir=path.join(f.root,'.orbitcode/agents');await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'unknown-model.md'),(await readFile('agents/explorer.md','utf8')).replace('name: explorer','name: unknown-model').replace('model: inherit','model: absent-provider'));await f.controller.handleLine('测试拒绝');const cp=await f.checkpoint();assert.equal(children,0);assert.equal(f.runtime.tasks.list(await f.runtime.taskScope(cp.summary.id)).length,0);assert.ok(cp.context.messages.some(m=>m.kind==='tool-result'&&JSON.stringify(m).includes('invalid-arguments')));}finally{await f.close();}
 }
});

test('同批两个 Fork 排除整个当前组，保持相同前缀与完整历史顺序',async()=>{
 let parents=0;const children:unknown[]=[];
 const f=await runtimeFixture(request=>{if(JSON.stringify(request.body).includes('orbitcode_child_role')){children.push(request.body);return say('子结束');}if(++parents===1)return call('read_file',{path:'evidence.txt'},'before-batch');if(parents===2)return {chunks:[{data:[0,1].map(index=>toolCallDelta({index,id:`same-batch-${index}`,name:'agent',argumentsJson:JSON.stringify({operation:'start',task:{kind:'fork',prompt:'相同子任务'}})})).join('')+TOOL_FINISH_EVENT+TRANSPORT_DONE_EVENT}]};return say('父结束');});
 try{await f.runtime.memory.setEnabled(false);await writeFile(path.join(f.root,'evidence.txt'),'证据');await f.controller.handleLine('父当前目标');const cp=await f.checkpoint(),scope=await f.runtime.taskScope(cp.summary.id);for(const task of f.runtime.tasks.list(scope))await f.runtime.tasks.wait(scope,task.id,3000,new AbortController().signal);assert.equal(children.length,2);assert.deepEqual(children[0],children[1]);assert.ok(JSON.stringify(children[0]).includes('before-batch'));assert.ok(!JSON.stringify(children[0]).includes('same-batch-'));}finally{await f.close();}
});

test('子在父流式请求中完成时只排队，下一安全轮次消费且不追加模型请求',async()=>{
 let parents=0,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const f=await runtimeFixture(async request=>{if(JSON.stringify(request.body).includes('orbitcode_child_role')){await gate;return say('子已结束');}if(++parents===1)return call('agent',{operation:'start',task:{kind:'fork',prompt:'流式期间完成'}},'stream-child');if(parents===2){release();return{chunks:say('父流式结束').chunks?.map(chunk=>({...chunk,delayMs:100}))};}return say('消费结果');});
 try{await f.runtime.memory.setEnabled(false);await f.controller.handleLine('启动');const cp=await f.checkpoint(),scope=await f.runtime.taskScope(cp.summary.id);assert.equal(parents,2);assert.equal(f.runtime.tasks.list(scope)[0].state.status,'terminal');assert.equal(cp.context.messages.filter(m=>m.kind==='child-result').length,0);await f.controller.handleLine('继续');assert.equal(parents,3);assert.equal((await f.checkpoint()).context.messages.filter(m=>m.kind==='child-result').length,1);}finally{release();await f.close();}
});

test('忙碌或 revision 冲突的清空不会提前取消仍有效的子任务',async()=>{
 const f=await subAgentFixture();
 try{await f.controller.handleLine('委派');const cp=await f.checkpoint(),scope=await f.runtime.taskScope(cp.summary.id),task=f.runtime.tasks.list(scope)[0];await assert.rejects(f.conversations.clear({conversationId:cp.summary.id,expectedRevision:cp.summary.revision-1}));assert.equal(f.runtime.tasks.get(scope,task.id).state.status,'running');const operation=await f.guard.begin(cp.summary.id,'agent');try{await assert.rejects(f.conversations.clear({conversationId:cp.summary.id,expectedRevision:cp.summary.revision}));assert.equal(f.runtime.tasks.get(scope,task.id).state.status,'running');}finally{await operation.finish();}}finally{await f.close();}
});

test('子 Provider 错误与工具失败后恢复均保留独立停止事实',async()=>{
 for(const scenario of ['provider-error','recover']){
  let parents=0,children=0;
  const f=await runtimeFixture(request=>{if(JSON.stringify(request.body).includes('orbitcode_child_role')){children++;if(scenario==='provider-error')return{status:400,chunks:[]};if(children===1)return call('read_file',{path:'missing.txt'},'missing');if(children===2)return call('read_file',{path:'evidence.txt'},'recovered');return say('模型说成功');}return ++parents===1?call('agent',{operation:'start',task:{kind:'defined',role:'explorer',prompt:'执行异常场景',background:true}},'failure-child'):say('父完成');});
  try{await f.runtime.memory.setEnabled(false);await writeFile(path.join(f.root,'evidence.txt'),'恢复证据');await f.controller.handleLine('测试');const cp=await f.checkpoint(),scope=await f.runtime.taskScope(cp.summary.id),task=f.runtime.tasks.list(scope)[0];const done=await f.runtime.tasks.wait(scope,task.id,3000,new AbortController().signal);assert.equal(done.task.state.status,'terminal');if(done.task.state.status!=='terminal')throw new Error('未结束');const result=done.task.state.result;assert.equal(result.stopReason,scenario==='provider-error'?'model-error':'final-response');assert.equal(result.verification.status,'unverified');if(scenario==='recover'){assert.equal(result.failureCount,1);assert.equal(result.failures[0].kind,'not-found');assert.equal(children,3);}else assert.ok(result.usage.categories.some(c=>c.failedRequests>0));}finally{await f.close();}
 }
});

test('同一父轮后续创建读取新角色，运行中子仍使用旧角色快照',async()=>{
 let parents=0;const seen:string[]=[];let roleFile='',original='';
 const f=await runtimeFixture(async request=>{const text=JSON.stringify(request.body);if(text.includes('orbitcode_child_role')){seen.push(text);return say('子结束');}parents++;if(parents===1)return call('agent',{operation:'start',task:{kind:'defined',role:'snapshot-role',prompt:'first'}},'first-role');if(parents===2){await writeFile(roleFile,original.replace('ROLE_OLD_MARKER','ROLE_NEW_MARKER'));return call('agent',{operation:'start',task:{kind:'defined',role:'snapshot-role',prompt:'second'}},'second-role');}return say('父结束');});
 try{await f.runtime.memory.setEnabled(false);const dir=path.join(f.root,'.orbitcode/agents');await mkdir(dir,{recursive:true});roleFile=path.join(dir,'snapshot-role.md');original=(await readFile('agents/explorer.md','utf8')).replace('name: explorer','name: snapshot-role')+'\nROLE_OLD_MARKER';await writeFile(roleFile,original);await f.controller.handleLine('创建两次');const cp=await f.checkpoint(),scope=await f.runtime.taskScope(cp.summary.id);for(const task of f.runtime.tasks.list(scope))await f.runtime.tasks.wait(scope,task.id,3000,new AbortController().signal);assert.equal(seen.length,2);assert.ok(seen[0].includes('ROLE_OLD_MARKER'));assert.ok(seen[1].includes('ROLE_NEW_MARKER'));assert.ok(!seen[1].includes('ROLE_OLD_MARKER'));}finally{await f.close();}
});

test('子在父多工具批未配对时完成，结果等完整配对后才进入下一模型请求',async()=>{
 const {LocalConversationStore}=await import('@/lib/local-conversation-store');
 const {waitUntil}=await import('./helpers/runtime-fixture');
 let parents=0,reference='',finished:()=>boolean=()=>false;let after:unknown;
 class WaitingStore extends LocalConversationStore{
  override async read(input:Parameters<InstanceType<typeof LocalConversationStore>['read']>[0]){
   if(reference&&input.reference===reference)await waitUntil(finished);
   return super.read(input);
  }
 }
 const f=await runtimeFixture(request=>{
  const text=JSON.stringify(request.body);if(text.includes('orbitcode_child_role'))return say('批次期间子完成');
  if(++parents===1)return{chunks:[{data:toolCallDelta({index:0,id:'batch-delegate',name:'agent',argumentsJson:JSON.stringify({operation:'start',task:{kind:'defined',role:'explorer',prompt:'批次期间完成'}})})+toolCallDelta({index:1,id:'batch-context',name:'read_context',argumentsJson:JSON.stringify({reference,offset:0,limit:1000})})+TOOL_FINISH_EVENT+TRANSPORT_DONE_EVENT}]};
  after=request.body;return say('父结束');
 },{terminal:true,storeFactory:root=>new WaitingStore(root)});
 try{
  await f.runtime.memory.setEnabled(false);
  const cp=await f.checkpoint(),scope=await f.runtime.taskScope(cp.summary.id);
  reference=(await f.store.write({sessionId:cp.summary.id,content:'受控只读结果',signal:new AbortController().signal})).reference;
  finished=()=>f.runtime.tasks.list(scope).some(task=>task.state.status==='terminal');
  await f.controller.handleLine('同批委派和只读引用');assert.equal(f.errors(),'');assert.equal(parents,2);
  const body=after as{messages:{role:string;content?:string;tool_call_id?:string;tool_calls?:{id:string}[]}[]};
  const pending=new Set<string>();let childIndex=-1,lastResult=-1;
  for(const[i,message]of body.messages.entries()){
   for(const call of message.tool_calls??[])pending.add(call.id);
   if(message.role==='tool'){assert.ok(pending.delete(message.tool_call_id!));lastResult=i;}
   if(message.role==='user'&&message.content?.startsWith('子任务 ')){assert.equal(pending.size,0);childIndex=i;}
  }
  assert.equal(pending.size,0);assert.ok(childIndex>lastResult);
 }finally{await f.close();}
});
