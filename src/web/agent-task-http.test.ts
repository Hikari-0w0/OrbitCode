import test from 'node:test';import assert from 'node:assert/strict';import{subAgentFixture}from '../../tests/helpers/sub-agent-fixture';import{agentTaskHttp}from './agent-task-http';
test('有权任务仍拒绝无效等待时间和多余控制字段，不扩大等待或取消范围',async()=>{const f=await subAgentFixture();try{await f.controller.handleLine('委派');const cp=await f.checkpoint(),scope=await f.runtime.taskScope(cp.summary.id),task=f.runtime.tasks.list(scope)[0];for(const [action,body]of [['wait',{timeoutMs:'forever'}],['wait',{timeoutMs:0}],['cancel',{workspace:'/'}]]as const){const request=new Request('http://localhost/task',{method:'POST',headers:{host:'localhost',origin:'http://localhost','content-type':'application/json'},body:JSON.stringify(body)});assert.equal((await agentTaskHttp(request,cp.summary.id,f.runtime,task.id,action)).status,400);}assert.equal(f.runtime.tasks.get(scope,task.id).state.status,'running');}finally{await f.close();}});
test('正文接口拒绝伪造会话和分页越界，读取不改变投递状态',async()=>{const f=await subAgentFixture();try{await f.controller.handleLine('委派');const cp=await f.checkpoint(),scope=await f.runtime.taskScope(cp.summary.id),task=f.runtime.tasks.list(scope)[0];f.release();await f.runtime.tasks.wait(scope,task.id,3000,new AbortController().signal);const request=(body:object)=>new Request('http://localhost/task',{method:'POST',headers:{host:'localhost',origin:'http://localhost','content-type':'application/json'},body:JSON.stringify(body)});for(const body of [{offset:-1},{limit:4001},{offset:'0'},{conversationId:'other'}])assert.equal((await agentTaskHttp(request(body),cp.summary.id,f.runtime,task.id,'result')).status,400);const before=f.runtime.tasks.get(scope,task.id).delivery;const response=await agentTaskHttp(request({offset:0,limit:1000}),cp.summary.id,f.runtime,task.id,'result');assert.equal(response.status,200);assert.match((await response.json()).content,/子回复/);assert.deepEqual(f.runtime.tasks.get(scope,task.id).delivery,before);}finally{await f.close();}});

test('Fork 正在复制历史时 HTTP 可查询和取消，终态 ID 保持有效且不请求子模型',async()=>{
 const {runtimeFixture,waitUntil}=await import('../../tests/helpers/runtime-fixture');
 const {call,say}=await import('../../tests/helpers/skill-fixture');
 const {LocalConversationStore}=await import('@/lib/local-conversation-store');
 let release!:()=>void,blocked=false,gateOn=false,parentCalls=0,childCalls=0;
 const gate=new Promise<void>(resolve=>{release=resolve;});let turn:Promise<void>|undefined;
 class DelayedStore extends LocalConversationStore {
  override async read(input:Parameters<InstanceType<typeof LocalConversationStore>['read']>[0]){if(gateOn){blocked=true;await gate;}return super.read(input);}
 }
 const f=await runtimeFixture(request=>{
  if(JSON.stringify(request.body).includes('orbitcode_child_role')){childCalls++;return say('子完成');}
  return ++parentCalls===1?call('agent',{operation:'start',task:{kind:'fork',prompt:'准备中取消',background:true}},'start'):say('父完成');
 },{storeFactory:root=>new DelayedStore(root)});
 try{
  await f.runtime.memory.setEnabled(false);
  const cp=await f.checkpoint(),signal=new AbortController().signal;
  const stored=await f.store.write({sessionId:cp.summary.id,content:'copied history',signal});
  await f.store.save({conversationId:cp.summary.id,expectedRevision:cp.summary.revision,checkpoint:{...cp,context:{messages:[{kind:'assistant-tool-call',content:null,toolCalls:[{id:'prior',name:'read_file',argumentsJson:'{}'}]},{kind:'tool-result',toolCallId:'prior',payload:{storage:'offloaded',reference:stored.reference,originalBytes:14,estimatedTokens:5,preview:'history'}}],consecutiveSummaryFailures:0}}});
  await f.controller.handleLine(`/resume ${cp.summary.id}`);const scope=await f.runtime.taskScope(cp.summary.id);gateOn=true;
  turn=f.controller.handleLine('创建 Fork');await waitUntil(()=>blocked);
  const task=f.runtime.tasks.list(scope)[0],origin='http://127.0.0.1';
  const request=(post=false)=>new Request(`${origin}/task`,{method:post?'POST':'GET',headers:{origin,host:'127.0.0.1','content-type':'application/json'},...(post?{body:'{}'}:{})});
  const before=await agentTaskHttp(request(),cp.summary.id,f.runtime,task.id);
  assert.equal(before.status,200);const beforeTask=(await before.json()).task;assert.equal(beforeTask.state.status,'preparing');assert.equal(beforeTask.timing.current,'preparation');
  const cancel=agentTaskHttp(request(true),cp.summary.id,f.runtime,task.id,'cancel');
  await waitUntil(()=>f.runtime.tasks.get(scope,task.id).state.status==='stopping');release();
  assert.equal((await cancel).status,200);await turn;
  const after=await agentTaskHttp(request(),cp.summary.id,f.runtime,task.id);
  assert.equal(after.status,200);const afterTask=(await after.json()).task,state=afterTask.state;
  assert.equal(afterTask.timing.current,'terminal');assert.equal(afterTask.timing.stopRequested.phase,'preparation');assert.deepEqual(state.result.timing,afterTask.timing);
  assert.equal(state.status,'terminal');assert.equal(state.result.stopReason,'cancelled');assert.equal(state.result.terminationSource,'user');assert.equal(childCalls,0);
 }finally{release();await turn;await f.close();}
});
