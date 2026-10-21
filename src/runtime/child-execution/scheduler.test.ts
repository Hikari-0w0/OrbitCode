import test from 'node:test';
import assert from 'node:assert/strict';
import {ChildExecutionScheduler} from './scheduler';
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
const signal=()=>new AbortController().signal;

test('就绪队列严格 FIFO，动态下调并发不会抢占已有任务或超发新任务',async()=>{
 const scheduler=new ChildExecutionScheduler(2),first=gate(),second=gate(),order:number[]=[];let running=0,peak=0;
 const run=(id:number,wait?:Promise<void>)=>scheduler.run({signal:signal(),execute:async()=>{order.push(id);running++;peak=Math.max(peak,running);await wait;running--;return id;}});
 try{
  const a=run(1,first.promise),b=run(2,second.promise),c=run(3),d=run(4);scheduler.configure(1);
  first.release();await a;assert.deepEqual(order,[1,2]);second.release();await Promise.all([b,c,d]);assert.deepEqual(order,[1,2,3,4]);assert.equal(peak,2);
  assert.throws(()=>scheduler.configure(0));
 }finally{first.release();second.release();await scheduler.close();}
});
test('资源等待不占执行名额，取消等待必须等接纳收敛后清理部分资源',async()=>{
 const scheduler=new ChildExecutionScheduler(1),resource=gate(),controller=new AbortController();let acquired=false,cleaned=0,executed=0;
 try{
  const blocked=scheduler.run({signal:controller.signal,acquire:async()=>{await resource.promise;acquired=true;},execute:async()=>{executed++;},cleanup:async()=>{assert.equal(acquired,true);cleaned++;}});
  const other=await scheduler.run({signal:signal(),execute:async()=>42});assert.ok(other.result.ok&&other.result.value===42);
  controller.abort();await Promise.resolve();assert.equal(cleaned,0);resource.release();const stopped=await blocked;
  assert.equal(stopped.result.ok,false);assert.equal(stopped.started,false);assert.equal(cleaned,1);assert.equal(executed,0);
 }finally{resource.release();await scheduler.close();}
});
test('关闭同时取消资源等待、执行名额等待与活动任务，并等待一次清理',async()=>{
 const scheduler=new ChildExecutionScheduler(1);let started=0,closed=0;
 const waiting=(signal:AbortSignal)=>new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});});
 const active=scheduler.run({signal:signal(),execute:async owned=>{started++;await waiting(owned);return '已知结果';},cleanup:async()=>{closed++;}});
 const queued=scheduler.run({signal:signal(),execute:async()=>{started++;},cleanup:async()=>{closed++;}});
 const acquiring=scheduler.run({signal:signal(),acquire:waiting,execute:async()=>{started++;},cleanup:async()=>{closed++;}});
 await scheduler.close();const results=await Promise.all([active,queued,acquiring]);assert.equal(started,1);assert.equal(closed,3);
 assert.ok(results[0].result.ok&&results[0].result.value==='已知结果');assert.equal(results[1].started,false);assert.equal(results[2].started,false);
 assert.equal((await scheduler.run({signal:signal(),execute:async()=>{started++;}})).result.ok,false);assert.equal(started,1);
});
test('清理失败不抹掉执行结果，执行失败仍清理并释放名额',async()=>{
 const scheduler=new ChildExecutionScheduler(1);let cleaned=0;
 try{
  const done=await scheduler.run({signal:signal(),execute:async()=>({sideEffect:'applied'}),cleanup:async()=>{cleaned++;throw new Error('清理失败');}});
  assert.ok(done.result.ok&&done.result.value.sideEffect==='applied');assert.equal(done.cleanup,'failed');
  const failed=await scheduler.run({signal:signal(),execute:async()=>{throw new Error('执行失败');},cleanup:async()=>{cleaned++;}});
  assert.equal(failed.result.ok,false);assert.equal(failed.cleanup,'complete');assert.equal(cleaned,2);
  assert.ok((await scheduler.run({signal:signal(),execute:async()=>1})).result.ok);
 }finally{await scheduler.close();}
});
test('排队回调失败仍以结构化结果收敛且不泄漏已取得资源',async()=>{
 const scheduler=new ChildExecutionScheduler(1);let closed=0,started=0;
 try{
  const result=await scheduler.run({signal:signal(),acquire:async()=>{},onQueued:()=>{throw new Error('状态投影失败');},execute:async()=>{started++;},cleanup:async()=>{closed++;}});
  assert.equal(result.result.ok,false);assert.equal(result.started,false);assert.equal(closed,1);assert.equal(started,0);
 }finally{await scheduler.close();}
});

test('固定种子混合就绪/资源等待/取消：并发有界且剩余就绪任务保持 FIFO',async()=>{
 for(let seed=1;seed<=20;seed++){
  const scheduler=new ChildExecutionScheduler(4),ready:number[]=[],started:number[]=[],cleaned=new Set<number>();let active=0,peak=0;
  const controllers=Array.from({length:40},()=>new AbortController());
  const operations=controllers.map((controller,id)=>scheduler.run({
   signal:controller.signal,
   acquire:(id+seed)%3===0?async signal=>{await Promise.resolve();signal.throwIfAborted();}:undefined,
   onQueued:()=>{ready.push(id);},
   execute:async signal=>{started.push(id);active++;peak=Math.max(peak,active);try{for(let i=0;i<3;i++)await Promise.resolve();signal.throwIfAborted();return id;}finally{active--; }},
   cleanup:async()=>{assert.equal(cleaned.has(id),false);cleaned.add(id);},
  }));
  for(let i=seed%5;i<controllers.length;i+=7)controllers[i].abort();
  const results=await Promise.all(operations);assert.ok(peak<=4);assert.equal(active,0);assert.equal(cleaned.size,40);
  assert.deepEqual(started,ready.filter(id=>started.includes(id)));
  assert.equal(results.filter(result=>result.started).length,started.length);
  assert.ok((await scheduler.run({signal:signal(),execute:async()=>1})).result.ok);await scheduler.close();
 }
});
