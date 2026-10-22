import test from 'node:test';import assert from 'node:assert/strict';
import {subAgentFixture} from './helpers/sub-agent-fixture';
for(const kind of ['defined','fork'] as const)test(`${kind} 完成真实 HTTP/循环/文件读取，父结束不取消且结果只投递一次`,async()=>{
 const f=await subAgentFixture(kind);
 try{
 await f.controller.handleLine('PARENT_HISTORY_MARKER 请委派探索');
 assert.equal(f.errors(),'');
 const cp=await f.checkpoint(),scope=await f.runtime.taskScope(cp.summary.id);
 const tasks=f.runtime.tasks.list(scope);assert.equal(tasks.length,1);assert.equal(tasks[0].state.status,'running');
 const child=JSON.stringify(f.childRequests[0]);assert.equal(child.includes('PARENT_HISTORY_MARKER'),kind==='fork');assert.ok(child.includes('CHILD_ONLY_TASK'));assert.ok(child.includes('只执行最后追加的本次子任务 prompt'));assert.ok(child.includes('编排步骤由父 Agent 负责'));
 assert.ok(child.includes('orbitcode_current_subtask'));assert.ok(child.includes('未完整检查'));assert.ok(child.includes('nextOffset'));assert.ok(child.includes('失败交接'));
 f.release();const waited=await f.runtime.tasks.wait(scope,tasks[0].id,3000,new AbortController().signal);
 assert.equal(waited.task.state.status,'terminal');if(waited.task.state.status==='terminal'){assert.equal(waited.task.state.result.stopReason,'final-response');assert.equal(waited.task.state.result.verification.status,'unverified');}
 const before=f.parentCalls();await new Promise(r=>setTimeout(r,20));assert.equal(f.parentCalls(),before);
 await f.controller.handleLine('读取子结果');await f.controller.handleLine('再确认一次');
 const saved=await f.checkpoint();assert.equal(saved.context.messages.filter(m=>m.kind==='child-result').length,1);assert.equal(saved.childResultReceipts?.length,1);assert.equal(f.runtime.tasks.get(scope,tasks[0].id).delivery.status,'committed');
 const runs=await f.log.findAllForConversation(tasks[0].id);assert.equal(runs.length,1);assert.ok(runs[0].tools.some(t=>t.name==='read_file'));assert.doesNotMatch(JSON.stringify(runs),/synthetic-fixture-secret/);
 }finally{await f.close();}
});

test('Fork 包含当轮此前工具交换，排除当前委派组，历史配对完整',async()=>{const f=await subAgentFixture('fork',true);try{await f.controller.handleLine('父当轮先读后委派');const raw=JSON.stringify(f.childRequests[0]);assert.ok(raw.includes('parent-read'));assert.ok(!raw.includes('"id":"delegate"'));const request=f.childRequests[0] as {messages:{role:string;tool_calls?:{id:string}[];tool_call_id?:string}[]};const pending=new Set<string>();for(const m of request.messages){for(const call of m.tool_calls??[])pending.add(call.id);if(m.role==='tool'){assert.ok(pending.delete(m.tool_call_id!));}}assert.equal(pending.size,0);}finally{await f.close();}});
test('成功清空取消旧世代后台任务并隔绝迟到结果',async()=>{const f=await subAgentFixture();try{await f.controller.handleLine('委派');const cp=await f.checkpoint(),scope=await f.runtime.taskScope(cp.summary.id),task=f.runtime.tasks.list(scope)[0];const cleared=await f.conversations.clear({conversationId:cp.summary.id,expectedRevision:cp.summary.revision});assert.notEqual(cleared.lifecycleEpoch,scope.lifecycleEpoch);assert.equal(cleared.childResultReceipts,undefined);assert.equal(f.runtime.tasks.get(scope,task.id).delivery.status,'invalidated');assert.equal(f.runtime.tasks.pending(scope).length,0);assert.deepEqual(cleared.context.messages,[]);}finally{await f.close();}});

test('Fork 排队时父停用 Skill，子仍保留接纳时的指令快照',async()=>{
 const {runtimeFixture,waitUntil}=await import('./helpers/runtime-fixture');
 const {call,say}=await import('./helpers/skill-fixture');
 const {mkdir,writeFile}=await import('node:fs/promises');
 const path=await import('node:path');
 let parentCalls=0;const childRequests:string[]=[];
 const f=await runtimeFixture(request=>{const text=JSON.stringify(request.body);if(text.includes('orbitcode_child_role')){childRequests.push(text);return say('子完成');}return ++parentCalls===1?call('agent',{operation:'start',task:{kind:'fork',prompt:'执行快照任务'}},'snapshot-delegate'):say('父完成');},{terminal:true});
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const held=Array.from({length:2},()=>f.runtime.tasks.withForeground(new AbortController().signal,()=>gate));
 try{
  await f.runtime.memory.setEnabled(false);
  const dir=path.join(f.root,'.orbitcode/skills');await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,'snapshot.md'),'---\nname: snapshot\ndescription: 快照测试\nallowed-tools: [agent, read_file, report_completion]\nmode: shared\n---\nSKILL_AT_ADMISSION_MARKER');
  await f.controller.handleLine('/skill snapshot');
  assert.equal(f.errors(),'');const cp=await f.checkpoint(),scope=await f.runtime.taskScope(cp.summary.id),task=f.runtime.tasks.list(scope)[0];
  assert.equal(task.state.status,'queued');await f.controller.handleLine('/skill deactivate snapshot');
  assert.equal((await f.checkpoint()).skills?.active.length,0);
  release();await Promise.all(held);await f.runtime.tasks.wait(scope,task.id,3000,new AbortController().signal);
  await waitUntil(()=>childRequests.length>0);assert.ok(childRequests[0].includes('已经加载并激活'));assert.ok(childRequests[0].includes('SKILL_AT_ADMISSION_MARKER'));
 }finally{release();await Promise.allSettled(held);await f.close();}
});
