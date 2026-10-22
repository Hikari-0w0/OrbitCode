import { startTestTask, testTaskSpecification } from "../../tests/helpers/task-admission";
import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundTaskManager } from './background-task-manager';
import { DEFAULT_SUB_AGENT_LIMITS, type ChildExecutionResult } from '@/core/sub-agents/types';
const scope={conversationId:'parent',lifecycleEpoch:'epoch'};
const result=(id:string):ChildExecutionResult=>({taskId:id,stopReason:'final-response',finalReply:'模型陈述',failures:[],sideEffect:'none',verification:{status:'unverified',checks:[],blockers:[]},usage:{scope:'self',categories:[]},cleanup:'complete',truncated:false,evidenceRunId:id});

test('管理器绑定不可变契约，执行与可见预算使用同一上限且不暴露任务正文',async()=>{
 const manager=new BackgroundTaskManager({...DEFAULT_SUB_AGENT_LIMITS,maxIterations:2,maxRuntimeMinutes:1},()=>1000);
 const specification=testTaskSpecification({kind:'fork',prompt:'私有任务正文',background:true},9,120000);
 try{
  const view=await manager.start({scope,turnId:'contract-turn',callId:'contract-call',specification,signal:new AbortController().signal,
   prepare:async contract=>{
    assert.ok(Object.isFrozen(contract.specification.limits));assert.equal(contract.specification.limits.maxIterations,2);
    assert.equal(contract.deadlineAt,61000);assert.equal(contract.specification.limits.maxRuntimeMs,60000);
    assert.equal(contract.scope.conversationId,scope.conversationId);assert.equal(contract.turnId,'contract-turn');assert.equal(contract.callId,'contract-call');
    return {close:async()=>{},run:async()=>result(contract.taskId)};
   }});
  const done=await manager.wait(scope,view.id,1000,new AbortController().signal);
  assert.equal(done.task.state.status,'terminal');assert.equal(done.task.admission?.limits.maxIterations,2);assert.equal(done.task.deadlineAt,61000);
  assert.equal(JSON.stringify(done.task).includes('私有任务正文'),false);
  assert.equal(done.task.admission?.delivery.acceptance,'independent-verification');
 }finally{await manager.close();}
});
test('待投递按终态发布顺序排序，墙钟相同仍保持先完成先投递',async()=>{
 const manager=new BackgroundTaskManager({...DEFAULT_SUB_AGENT_LIMITS,concurrency:2},()=>1000),gates=new Map<string,()=>void>();
 const start=(callId:string)=>startTestTask(manager,{scope,turnId:'completion-order',callId,task:{kind:'fork',prompt:'x',background:true},maxIterations:1,maxRuntimeMs:1000,signal:new AbortController().signal,prepare:async id=>({close:async()=>{},run:()=>new Promise(resolve=>gates.set(id,()=>resolve(result(id))))})});
 try{const a=await start('a'),b=await start('b');gates.get(b.id)!();await manager.wait(scope,b.id,1000,new AbortController().signal);gates.get(a.id)!();await manager.wait(scope,a.id,1000,new AbortController().signal);assert.deepEqual(manager.pending(scope).map(task=>task.id),[b.id,a.id]);}finally{for(const release of gates.values())release();await manager.close();}
});
test('运行中总时限保留副作用与清理失败，来源不是用户取消',async()=>{
 const manager=new BackgroundTaskManager();
 try{const view=await startTestTask(manager,{scope,turnId:'deadline-source',callId:'start',task:{kind:'fork',prompt:'x',background:true},maxIterations:1,maxRuntimeMs:15,signal:new AbortController().signal,prepare:async id=>({close:async()=>{throw new Error('清理失败');},run:signal=>new Promise(resolve=>signal.addEventListener('abort',()=>resolve({...result(id),sideEffect:'applied'}),{once:true}))})});const done=await manager.wait(scope,view.id,1000,new AbortController().signal);assert.ok(done.task.state.status==='terminal');if(done.task.state.status!=='terminal')return;assert.equal(done.task.state.result.stopReason,'max-runtime');assert.equal(done.task.state.result.terminationSource,undefined);assert.equal(done.task.state.result.sideEffect,'applied');assert.equal(done.task.state.result.cleanup,'failed');}finally{await manager.close();}
});
function fixture(concurrency=1){const manager=new BackgroundTaskManager({...DEFAULT_SUB_AGENT_LIMITS,concurrency});let starts=0,closes=0;const finish=new Map<string,()=>void>();const start=(callId:string)=>startTestTask(manager,{scope,turnId:'turn',callId,task:{kind:'fork',prompt:'任务',background:true},maxIterations:2,maxRuntimeMs:10000,signal:new AbortController().signal,prepare:async id=>({close:async()=>{closes++;},run:signal=>new Promise(resolve=>{starts++;const done=()=>resolve(result(id));finish.set(id,done);signal.addEventListener('abort',done,{once:true});})})});return {manager,start,finish,starts:()=>starts,closes:()=>closes};}
test('并发有界、等待超时不重跑、同调用幂等、终态仅一次并隔离归属',async()=>{
 const f=fixture();try{const a=await f.start('a'),b=await f.start('b');assert.equal(f.starts(),1);assert.equal(f.manager.get(scope,b.id).state.status,'queued');assert.equal((await f.start('a')).id,a.id);
 const waited=await f.manager.wait(scope,a.id,5,new AbortController().signal);assert.equal(waited.reason,'timeout');assert.equal(waited.task.deadlineAt,a.deadlineAt);assert.equal(f.starts(),1);
 assert.throws(()=>f.manager.get({...scope,conversationId:'other'},a.id));
 f.finish.get(a.id)!();await f.manager.wait(scope,a.id,1000,new AbortController().signal);assert.equal(f.starts(),2);await f.manager.cancel(scope,b.id);assert.equal(f.closes(),2);
 assert.equal(f.manager.pending(scope).length,2);await f.manager.cancel(scope,a.id);assert.equal(f.closes(),2);
 }finally{await f.manager.close();}
});
test('取消排队不启动、关闭取消执行且不接受新任务',async()=>{const f=fixture();const a=await f.start('a'),b=await f.start('b');await f.manager.cancel(scope,b.id);assert.equal(f.starts(),1);await f.manager.close();assert.equal(f.manager.get(scope,a.id).state.status,'terminal');assert.equal(f.closes(),2);await assert.rejects(f.start('c'));});
test('排队总时限到期不启动，清理失败保留原停止原因和副作用',async()=>{const manager=new BackgroundTaskManager({...DEFAULT_SUB_AGENT_LIMITS,concurrency:1});const signal=new AbortController().signal;let starts=0;const start=(callId:string,maxRuntimeMs:number)=>startTestTask(manager,{scope,turnId:'t',callId,task:{kind:'fork',prompt:'x',background:true},maxIterations:2,maxRuntimeMs,signal,prepare:async id=>({close:async()=>{if(callId==='fail')throw new Error('清理失败');},run:async taskSignal=>{starts++;if(callId==='fail')return {...result(id),sideEffect:'applied'};await new Promise<void>(resolve=>taskSignal.addEventListener('abort',()=>resolve(),{once:true}));return result(id);}})});try{const long=await start('long',1000),queued=await start('queued',10);const expired=await manager.wait(scope,queued.id,1000,signal);assert.equal(starts,1);assert.ok(expired.task.state.status==='terminal'&&expired.task.state.result.stopReason==='max-runtime');await manager.cancel(scope,long.id);const failed=await start('fail',1000);const done=await manager.wait(scope,failed.id,1000,signal);assert.ok(done.task.state.status==='terminal'&&done.task.state.result.cleanup==='failed'&&done.task.state.result.sideEffect==='applied'&&done.task.state.result.stopReason==='final-response');}finally{await manager.close();}});
test('独立 Skill 与后台共用并发许可，世代失效不再投递',async()=>{const f=fixture();try{const a=await f.start('a');let entered=false;const foreground=f.manager.withForeground(new AbortController().signal,async()=>{entered=true;});await new Promise(r=>setTimeout(r,5));assert.equal(entered,false);f.finish.get(a.id)!();await foreground;assert.equal(entered,true);await f.manager.invalidate(scope);assert.equal(f.manager.pending(scope).length,0);assert.equal(f.manager.get(scope,a.id).delivery.status,'invalidated');}finally{await f.manager.close();}});
test('每轮数量预算不被已投递记录的容量清理重置',async()=>{const manager=new BackgroundTaskManager({...DEFAULT_SUB_AGENT_LIMITS,capacity:1,concurrency:1,perTurn:1});const start=()=>startTestTask(manager,{scope,turnId:'one-turn',callId:Math.random().toString(),task:{kind:'fork',prompt:'x',background:true},maxIterations:1,maxRuntimeMs:1000,signal:new AbortController().signal,prepare:async id=>({close:async()=>{},run:async()=>result(id)})});try{const a=await start();await manager.wait(scope,a.id,1000,new AbortController().signal);manager.commit(scope,a.id,1);await assert.rejects(start(),/上限/);}finally{await manager.close();}});
test('关闭与前台槽位授予相邻时不启动迟到执行',async()=>{const manager=new BackgroundTaskManager();let starts=0;const foreground=manager.withForeground(new AbortController().signal,async()=>{starts++;});const closed=manager.close();await assert.rejects(foreground,/关闭/);await closed;assert.equal(starts,0);});
test('准备失败保留终态和去重记录，确认投递后才回收容量',async()=>{
 const manager=new BackgroundTaskManager({...DEFAULT_SUB_AGENT_LIMITS,capacity:1,concurrency:1});
 const input={scope,turnId:'prepare-failure',callId:'call',task:{kind:'fork' as const,prompt:'x',background:true as const},maxIterations:1,maxRuntimeMs:1000,signal:new AbortController().signal};
 let preparations=0;
 const prepare=async()=>{preparations++;throw new Error('引用复制失败');};
 try{
  const task=await startTestTask(manager,{...input,prepare});
  const done=await manager.wait(scope,task.id,1000,input.signal);
  assert.ok(done.task.state.status==='terminal'&&done.task.state.result.stopReason==='agent-error');
  assert.equal((await startTestTask(manager,{...input,prepare})).id,task.id);
  assert.equal(preparations,1);
  await assert.rejects(startTestTask(manager,{...input,callId:'another',prepare}),/上限/);
  manager.commit(scope,task.id,1);
  const next=await startTestTask(manager,{...input,callId:'another',prepare:async id=>({run:async()=>result(id),close:async()=>{}})});
  await manager.wait(scope,next.id,1000,input.signal);
  await assert.rejects(startTestTask(manager,{...input,prepare}),/退休/);
 }finally{await manager.close();}
});
test('三条后台路径只执行一次，等待和转后台不续期',async()=>{
 for(const transition of ['explicit','timeout','manual'] as const){
  const manager=new BackgroundTaskManager();let starts=0,writes=0,release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  try{
   const task=await startTestTask(manager,{scope,turnId:transition,callId:'one',task:{kind:'defined',role:'general',prompt:'受控操作',background:transition==='explicit'},maxIterations:1,maxRuntimeMs:3000,signal:new AbortController().signal,prepare:async id=>({close:async()=>{},run:async()=>{starts++;await gate;writes++;return {...result(id),sideEffect:'applied'};}})});
   if(transition==='timeout')assert.equal((await manager.wait(scope,task.id,2,new AbortController().signal)).reason,'timeout');
   if(transition==='manual'){const waiting=manager.wait(scope,task.id,1000,new AbortController().signal);manager.detach(scope,task.id);assert.equal((await waiting).reason,'detached');}
   assert.equal(manager.get(scope,task.id).background,true);assert.equal(manager.get(scope,task.id).deadlineAt,task.deadlineAt);
   release();await manager.wait(scope,task.id,1000,new AbortController().signal);assert.equal((await manager.wait(scope,task.id,1000,new AbortController().signal)).reason,'finished');assert.equal(starts,1);assert.equal(writes,1);assert.equal(manager.get(scope,task.id).deadlineAt,task.deadlineAt);
  }finally{release();await manager.close();}
 }
});
test('已投递任务被容量退休后，同轮旧创建调用拒绝重放',async()=>{const manager=new BackgroundTaskManager({...DEFAULT_SUB_AGENT_LIMITS,capacity:1,concurrency:1});let starts=0;const start=(callId:string)=>startTestTask(manager,{scope,turnId:'same-turn',callId,task:{kind:'fork',prompt:'x',background:true},maxIterations:1,maxRuntimeMs:1000,signal:new AbortController().signal,prepare:async id=>({run:async()=>{starts++;return result(id);},close:async()=>{}})});try{const a=await start('a');await manager.wait(scope,a.id,1000,new AbortController().signal);manager.commit(scope,a.id,1);const b=await start('b');await manager.wait(scope,b.id,1000,new AbortController().signal);manager.commit(scope,b.id,2);await assert.rejects(start('a'),/退休/);assert.equal(starts,2);}finally{await manager.close();}});

function deferred<T>() {
 let resolve!: (value:T)=>void;
 const promise=new Promise<T>(done=>{resolve=done;});
 return {promise,resolve};
}
function admissionInput(callId='call') {
 return {scope,turnId:'admission',callId,task:{kind:'fork' as const,prompt:'稳定任务',background:true as const},maxIterations:2,maxRuntimeMs:3000,signal:new AbortController().signal};
}
test('准备中取消保持可查询 ID，重复创建和并发停止只清理一次',async()=>{
 const manager=new BackgroundTaskManager(),gate=deferred<void>();let closes=0,runs=0,prepares=0;let signal:AbortSignal|undefined;
 const input=admissionInput();
 const prepare=async(id:string,_deadline:number,taskSignal:AbortSignal)=>{prepares++;signal=taskSignal;await gate.promise;return {close:async()=>{closes++;},run:async()=>{runs++;return result(id);}};};
 try{
  const first=await startTestTask(manager,{...input,prepare});assert.equal(first.state.status,'preparing');
  const second=await startTestTask(manager,{...input,prepare});assert.equal(second.id,first.id);assert.equal(prepares,1);
  const cancelled=manager.cancel(scope,first.id),closed=manager.close();
  assert.equal(signal?.aborted,true);assert.equal(manager.get(scope,first.id).state.status,'stopping');
  gate.resolve();const done=await cancelled;await closed;
  assert.ok(done.state.status==='terminal'&&done.state.result.stopReason==='cancelled'&&done.state.result.terminationSource==='user');
  assert.equal(manager.get(scope,first.id).id,first.id);assert.equal(closes,1);assert.equal(runs,0);assert.equal(manager.pending(scope).length,1);
 }finally{gate.resolve();await manager.close();}
});
test('准备受任务 deadline 控制，准备失败与清理失败均保留真实终止来源',async()=>{
 const {TaskPreparationError}=await import('./task-transitions');
 for(const source of ['deadline','close'] as const){
  const manager=new BackgroundTaskManager();
  try{
   const task=await startTestTask(manager,{...admissionInput(),maxRuntimeMs:source==='deadline'?10:3000,prepare:async(_id,_deadline,signal)=>{
    await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));
    throw new TaskPreparationError('failed');
   }});
   if(source==='close')await manager.close();
   const done=await manager.wait(scope,task.id,1000,new AbortController().signal);
   assert.equal(done.task.state.status,'terminal');if(done.task.state.status!=='terminal')return;
   assert.equal(done.task.state.result.cleanup,'failed');
   assert.equal(done.task.state.result.stopReason,source==='deadline'?'max-runtime':'cancelled');
   assert.equal(done.task.state.result.terminationSource,source==='close'?'runtime-close':undefined);
  }finally{await manager.close();}
 }
});
test('接纳后父请求取消不撤销后台准备，输入与去重 key 按 scope 固定',async()=>{
 const manager=new BackgroundTaskManager(),gate=deferred<void>(),parent=new AbortController();let prepares=0;
 const input={...admissionInput(),signal:parent.signal};
 const prepare=async(id:string,_deadline:number,signal:AbortSignal)=>{prepares++;await gate.promise;signal.throwIfAborted();return {run:async()=>result(id),close:async()=>{}};};
 try{
  const first=await startTestTask(manager,{...input,prepare});parent.abort();
  await assert.rejects(startTestTask(manager,{...admissionInput(),task:{...input.task,prompt:'替换输入'},prepare}),/更换任务/);
  const other=await startTestTask(manager,{...admissionInput(),scope:{...scope,conversationId:'other'},prepare});assert.notEqual(first.id,other.id);
  gate.resolve();const done=await manager.wait(scope,first.id,1000,new AbortController().signal);
  assert.ok(done.task.state.status==='terminal'&&done.task.state.result.stopReason==='final-response');assert.equal(prepares,2);
 }finally{gate.resolve();await manager.close();}
});
test('准备并发有界，尚未分配准备名额的任务取消后不初始化资源',async()=>{
 const manager=new BackgroundTaskManager({...DEFAULT_SUB_AGENT_LIMITS,concurrency:1});const gate=deferred<void>();let prepares=0;
 const prepare=async(id:string)=>{prepares++;await gate.promise;return {run:async()=>result(id),close:async()=>{}};};
 try{
  const a=await startTestTask(manager,{...admissionInput('a'),prepare}),b=await startTestTask(manager,{...admissionInput('b'),prepare});
  assert.equal(prepares,1);const done=await manager.cancel(scope,b.id);assert.equal(done.state.status,'terminal');
  gate.resolve();await manager.wait(scope,a.id,1000,new AbortController().signal);assert.equal(prepares,1);
 }finally{gate.resolve();await manager.close();}
});

test('终态事实不因后续清空改变，活跃任务清空在停止协议中归因',async()=>{
 const f=fixture();
 try{
  const first=await f.start('done');f.finish.get(first.id)!();const completed=await f.manager.wait(scope,first.id,1000,new AbortController().signal);
  const active=await f.start('active');await f.manager.invalidate(scope);
  assert.deepEqual(f.manager.get(scope,first.id).state,completed.task.state);
  const stopped=f.manager.get(scope,active.id);assert.ok(stopped.state.status==='terminal'&&stopped.state.result.terminationSource==='parent-cleared');
  f.manager.commit(scope,first.id,9);assert.equal(f.manager.get(scope,first.id).delivery.status,'invalidated');
 }finally{await f.manager.close();}
});

test('任务进入工作区被拒绝时交接保留结构化冲突，不暴露原始异常',async()=>{
 const {WorkspaceAccessError}=await import('@/tools/types');const manager=new BackgroundTaskManager();
 try{
  const task=await startTestTask(manager,{...admissionInput(),prepare:async()=>({close:async()=>{},run:async()=>{throw new WorkspaceAccessError('conflict','内部拒绝诊断，不复制到结果');}})});
  const done=await manager.wait(scope,task.id,1000,new AbortController().signal);
  assert.ok(done.task.state.status==='terminal');if(done.task.state.status!=='terminal')return;
  assert.equal(done.task.state.result.stopReason,'agent-error');assert.deepEqual(done.task.state.result.failures,[{tool:'agent',kind:'conflict'}]);assert.ok(!JSON.stringify(done.task.state.result).includes('内部拒绝诊断'));
 }finally{await manager.close();}
});

test('已排队后台任务不会被后来提交的独立 Skill 插队',async()=>{
 const manager=new BackgroundTaskManager({...DEFAULT_SUB_AGENT_LIMITS,concurrency:1}),gate=deferred<void>(),order:string[]=[];
 const create=(callId:string)=>startTestTask(manager,{...admissionInput(callId),prepare:async id=>({close:async()=>{},run:async()=>{if(callId==='held')await gate.promise;else order.push('background');return result(id);}})});
 try{
  const held=await create('held'),queued=await create('queued');
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(manager.get(scope,queued.id).state.status,'queued');
  const foreground=manager.withForeground(new AbortController().signal,async()=>{order.push('foreground');});
  gate.resolve();await manager.wait(scope,held.id,1000,new AbortController().signal);await foreground;await manager.wait(scope,queued.id,1000,new AbortController().signal);
  assert.deepEqual(order,['background','foreground']);
 }finally{gate.resolve();await manager.close();}
});

test('同根资源等待不占执行名额，其他根任务可以完成',async()=>{
 const {WorkspaceExecutionCoordinator}=await import('./workspace-execution-coordinator');
 const coordinator=new WorkspaceExecutionCoordinator(),manager=new BackgroundTaskManager({...DEFAULT_SUB_AGENT_LIMITS,concurrency:2});
 const held=deferred<void>(),entered=deferred<void>(),started:string[]=[];let closed=0;
 const create=(name:string,root:string)=>startTestTask(manager,{...admissionInput(name),prepare:async id=>{
  let lease:import('./workspace-execution-coordinator').TaskWorkspaceLease|undefined;
  return {acquire:async signal=>{lease=await coordinator.acquireTask(root,'exclusive',signal);},run:async()=>{
   if(!lease)throw new Error('缺少许可');return lease.run(async()=>{started.push(name);if(name==='held'){entered.resolve();await held.promise;}return result(id);});
  },close:async()=>{closed++;lease?.release('complete');}};
 }});
 try{
  const a=await create('held','/a');await entered.promise;const blocked=await create('blocked','/a');await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(manager.get(scope,blocked.id).state.status,'waiting-resources');
  const other=await create('other','/b'),done=await manager.wait(scope,other.id,1000,new AbortController().signal);
  assert.equal(done.task.state.status,'terminal');assert.deepEqual(started,['held','other']);
  held.resolve();await manager.wait(scope,a.id,1000,new AbortController().signal);await manager.wait(scope,blocked.id,1000,new AbortController().signal);assert.deepEqual(started,['held','other','blocked']);assert.equal(closed,3);
 }finally{held.resolve();await manager.close();}
});
test('关闭给活动独立 Skill 注入取消信号并等待资源清理，不修改调用者信号',async()=>{
 const manager=new BackgroundTaskManager(),parent=new AbortController(),entered=deferred<void>();let aborted=false,closed=0;
 const foreground=manager.withForeground(parent.signal,async owned=>{
  entered.resolve();await new Promise<void>(resolve=>{owned.addEventListener('abort',()=>{aborted=true;resolve();},{once:true});});return '已知观察';
 },{acquire:async()=>{},close:async()=>{closed++;}});
 await entered.promise;await manager.close();assert.equal(await foreground,'已知观察');assert.equal(aborted,true);assert.equal(closed,1);assert.equal(parent.signal.aborted,false);
});
