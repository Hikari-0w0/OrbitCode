import test from 'node:test';import assert from 'node:assert/strict';import {WorkspaceExecutionCoordinator} from './workspace-execution-coordinator';
test('同根写入互斥，排队可取消，其他根不阻塞',async()=>{const c=new WorkspaceExecutionCoordinator(),signal=new AbortController().signal;const release=await c.acquire('/a',signal);let entered=false;const abort=new AbortController();const cancelled=c.acquire('/a',abort.signal);const second=c.acquire('/a',signal).then(fn=>{entered=true;return fn;});const other=await c.acquire('/b',signal);assert.equal(entered,false);abort.abort();await assert.rejects(cancelled);other();release();(await second)();assert.equal(entered,true);});
test('不同工作区入口经真实路径归一后使用同一写入许可',async()=>{const{mkdtemp,mkdir,symlink,rm}=await import('node:fs/promises');const{tmpdir}=await import('node:os');const path=await import('node:path');const{createWorkspaceBoundary}=await import('@/tools/workspace');const root=await mkdtemp(path.join(tmpdir(),'shared-root-'));try{await mkdir(path.join(root,'real'));await symlink(path.join(root,'real'),path.join(root,'alias'));const a=await createWorkspaceBoundary(path.join(root,'real')),b=await createWorkspaceBoundary(path.join(root,'alias'));assert.equal(a.root,b.root);const c=new WorkspaceExecutionCoordinator(),release=await c.acquire(a.root,new AbortController().signal);let entered=false;const next=c.acquire(b.root,new AbortController().signal).then(unlock=>{entered=true;unlock();});assert.equal(entered,false);release();await next;assert.equal(entered,true);}finally{await rm(root,{recursive:true,force:true});}});

const signal=()=>new AbortController().signal;
test('同轮许可可复用且引用全部归还后才放行其他任务，取消不能借用许可',async()=>{
 const coordinator=new WorkspaceExecutionCoordinator(),scope=coordinator.createExecutionScope();
 const process=await scope.acquire('/service',signal());
 let externalEntered=false;
 const outside=coordinator.acquire('/service',signal()).then(release=>{externalEntered=true;release();});
 const verification=await scope.acquire('/service',signal());
 const read=await scope.acquireRead('/service',signal());
 const aborted=new AbortController();aborted.abort();
 await assert.rejects(scope.acquire('/service',aborted.signal));
 process();process();await Promise.resolve();assert.equal(externalEntered,false);
 verification();await Promise.resolve();assert.equal(externalEntered,false);
 read();await outside;assert.equal(externalEntered,true);
});
test('不同轮作用域不能复用许可，独立只读任务不能借父轮作用域升级',async()=>{
 const coordinator=new WorkspaceExecutionCoordinator(),first=coordinator.createExecutionScope(),second=coordinator.createExecutionScope();
 const release=await first.acquire('/a',signal());let entered=false;
 const waiting=second.acquire('/a',signal()).then(unlock=>{entered=true;unlock();});
 await Promise.resolve();assert.equal(entered,false);release();await waiting;
 await coordinator.runTask('/a','read-only',signal(),async()=>{
  await assert.rejects(first.acquire('/a',signal()),/升级/);
  const unlock=await first.acquireRead('/a',signal());unlock();
 },async()=>{});
});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
test('任务独占覆盖读取、推理、写回和清理，两个递增不会覆盖旧版本',async()=>{
 const coordinator=new WorkspaceExecutionCoordinator();let value=0,cleaned=0;
 const increment=()=>coordinator.runTask('/shared','exclusive',signal(),async()=>{
  const releaseRead=await coordinator.acquireRead('/shared',signal());const before=value;releaseRead();
  await Promise.resolve();const releaseWrite=await coordinator.acquire('/shared',signal());value=before+1;releaseWrite();
 },async()=>{cleaned++;});
 await Promise.all([increment(),increment()]);assert.equal(value,2);assert.equal(cleaned,2);
});
test('只读任务并行且写者不会被后来的读者插队，独立工作区不阻塞',async()=>{
 const c=new WorkspaceExecutionCoordinator(),gate=deferred(),both=deferred();let readers=0;const order:string[]=[];
 const read=()=>c.runTask('/a','read-only',signal(),async()=>{if(++readers===2)both.resolve();await gate.promise;},async()=>{});
 const first=read(),second=read();await both.promise;
 const write=c.acquire('/a',signal()).then(release=>{order.push('write');release();});
 const last=c.acquireRead('/a',signal()).then(release=>{order.push('read');release();});
 const other=await c.acquire('/b',signal());other();assert.equal(readers,2);assert.deepEqual(order,[]);
 gate.resolve();await Promise.all([first,second,write,last]);assert.deepEqual(order,['write','read']);
});
test('父级读写等待完整任务清理，重复释放和排队取消不破坏所有权',async()=>{
 const c=new WorkspaceExecutionCoordinator(),gate=deferred(),cleaning=deferred();let read=false,write=false;
 const task=c.runTask('/a','exclusive',signal(),async()=>{},async()=>{cleaning.resolve();await gate.promise;});
 await cleaning.promise;
 const aborted=new AbortController(),cancelled=c.acquireRead('/a',aborted.signal);aborted.abort();await assert.rejects(cancelled);
 const reader=c.acquireRead('/a',signal()).then(release=>{read=true;release();release();});
 const writer=c.acquire('/a',signal()).then(release=>{write=true;release();release();});
 await Promise.resolve();assert.equal(read,false);assert.equal(write,false);
 gate.resolve();await Promise.all([task,reader,writer]);assert.equal(read,true);assert.equal(write,true);
});
test('只读任务不能升级写锁，任务结束后的异步回调不能沿用所有权',async()=>{
 const c=new WorkspaceExecutionCoordinator(),gate=deferred();let late:Promise<void>|undefined;
 await c.runTask('/a','read-only',signal(),async()=>{
  await assert.rejects(c.acquire('/a',signal()),/升级/);
  await assert.rejects(c.acquireRead('/b',signal()),/范围/);
  late=gate.promise.then(async()=>{await assert.rejects(c.acquireRead('/a',signal()),/结束/);});
 },async()=>{});
 gate.resolve();await late;
 const release=await c.acquire('/a',signal());release();
});
test('清理失败保留任务产物并拒绝同根后续访问，其他根继续工作',async()=>{
 const c=new WorkspaceExecutionCoordinator();
 const observed=await c.runTask('/a','exclusive',signal(),async()=>({writes:1}),async()=>{throw new Error('执行器停止无法确认');});
 assert.equal(observed.value.writes,1);assert.equal(observed.cleanup,'failed');
 await assert.rejects(c.acquire('/a',signal()),/清理失败/);await assert.rejects(c.acquireRead('/a',signal()),/清理失败/);
 const release=await c.acquire('/b',signal());release();
});

test('固定种子压力：任务读写隔离、取消、公平回收与跨根一致性',async()=>{
 for(let seed=1;seed<=20;seed++){
  const c=new WorkspaceExecutionCoordinator();let random=seed;
  const next=()=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return random;};
  const values=[0,0,0],writers=[0,0,0],readers=[0,0,0],completed=[0,0,0],closed=new Set<number>();
  const aborts:AbortController[]=[],pending:Promise<void>[]=[];
  for(let i=0;i<40;i++){
   const root=next()%3,access=next()%3===0?'exclusive':'read-only',controller=new AbortController();aborts.push(controller);
   const running=c.runTask(`/root-${root}`,access,controller.signal,async()=>{
    if(access==='exclusive'){assert.equal(writers[root],0);assert.equal(readers[root],0);writers[root]++;}
    else{assert.equal(writers[root],0);readers[root]++;}
    const before=values[root];for(let step=0;step<3;step++)await Promise.resolve();
    assert.equal(values[root],before);
    if(access==='exclusive'){values[root]++;completed[root]++;writers[root]--;}
    else readers[root]--;
   },async()=>{assert.equal(closed.has(i),false);closed.add(i);});
   pending.push(running.then(()=>{},error=>{assert.equal(controller.signal.aborted,true,String(error));}));
  }
  for(let i=3;i<aborts.length;i+=7)aborts[i].abort();
  await Promise.all(pending);assert.deepEqual(values,completed);assert.deepEqual(writers,[0,0,0]);assert.deepEqual(readers,[0,0,0]);
  for(let root=0;root<3;root++){const release=await c.acquire(`/root-${root}`,signal());release();}
 }
});
