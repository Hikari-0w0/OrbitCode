import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {runtimeFixture,waitUntil} from './helpers/runtime-fixture';
import {call,say} from './helpers/skill-fixture';
import {record} from '@/runtime/skills/definition';

function latestContent(body:unknown):string {
 assert.ok(record(body)&&Array.isArray(body.messages));
 const messages=body.messages.filter((message:unknown)=>record(message)&&message.role==='tool');
 const last:unknown=messages.at(-1);assert.ok(record(last)&&typeof last.content==='string');
 const value:unknown=JSON.parse(last.content);assert.ok(record(value)&&record(value.output)&&typeof value.output.content==='string');
 return value.output.content;
}

test('共享目录写子任务串行覆盖读改写，父级控制不阻塞且读取最终一致版本',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 let parents=0,blocked=false,parentReadCompleted=false;
 const calls=new Map<string,number>(),observed:number[]=[];
 const f=await runtimeFixture(async request=>{
  const raw=JSON.stringify(request.body);
  if(raw.includes('orbitcode_child_role')){
   const tag=raw.includes('COUNTER_TASK_A')?'A':'B',iteration=(calls.get(tag)??0)+1;calls.set(tag,iteration);
   if(iteration===1)return call('read_file',{path:'count.txt'},`read-${tag}`);
   if(iteration===2){const before=Number(latestContent(request.body));observed.push(before);if(tag==='A'){blocked=true;await gate;}return call('write_file',{path:'count.txt',content:String(before+1)},`write-${tag}`);}
   return say('计数完成');
  }
  parents++;
  if(parents<=2)return call('agent',{operation:'start',task:{kind:'defined',role:'counter',prompt:parents===1?'COUNTER_TASK_A':'COUNTER_TASK_B',background:true}},`start-${parents}`);
  if(parents===4)return call('agent',{operation:'status'},'parent-status');
  if(parents===6)return call('read_file',{path:'count.txt'},'parent-read');
  if(parents===7){assert.equal(latestContent(request.body),'2');parentReadCompleted=true;}
  return say('父完成');
 },{terminal:true});
 let reading:Promise<void>|undefined;
 try{
  await f.runtime.memory.setEnabled(false);
  const roles=path.join(f.root,'.orbitcode/agents');await mkdir(roles,{recursive:true});
  await writeFile(path.join(roles,'counter.md'),'---\nname: counter\ndescription: 计数更新\nallowed-tools: [read_file, write_file]\ndisallowed-tools: [agent]\nmodel: inherit\nmax-iterations: 4\npermission-mode: permissive\n---\n执行计数更新。');
  await writeFile(path.join(f.root,'count.txt'),'0');
  await f.controller.handleLine('创建两个计数任务');await waitUntil(()=>blocked);
  assert.equal(calls.get('B'),undefined);
  await f.controller.handleLine('查看状态');assert.equal(parents,5);
  const cp=await f.checkpoint(),scope=await f.runtime.taskScope(cp.summary.id);
  assert.deepEqual(f.runtime.tasks.list(scope).map(task=>task.workspaceAccess),['exclusive','exclusive']);
  reading=f.controller.handleLine('父级读取计数');await waitUntil(()=>parents===6);assert.equal(parentReadCompleted,false);
  release();await reading;
  for(const task of f.runtime.tasks.list(scope))await f.runtime.tasks.wait(scope,task.id,3000,new AbortController().signal);
  assert.equal(await readFile(path.join(f.root,'count.txt'),'utf8'),'2');assert.deepEqual(observed,[0,1]);assert.equal(parentReadCompleted,true);assert.equal(f.errors(),'');
 }finally{release();await reading;await f.close();}
});

test('只读角色的两个真实子循环保持并行',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let parents=0,children=0;
 const f=await runtimeFixture(async request=>{
  if(JSON.stringify(request.body).includes('orbitcode_child_role')){children++;await gate;return say('只读完成');}
  if(++parents<=2)return call('agent',{operation:'start',task:{kind:'defined',role:'explorer',prompt:`只读任务${parents}`,background:true}},`start-${parents}`);
  return say('父完成');
 });
 try{
  await f.runtime.memory.setEnabled(false);await f.controller.handleLine('并行探索');await waitUntil(()=>children===2);
  const cp=await f.checkpoint(),scope=await f.runtime.taskScope(cp.summary.id),tasks=f.runtime.tasks.list(scope);
  assert.deepEqual(tasks.map(task=>task.workspaceAccess),['read-only','read-only']);
  release();for(const task of tasks)await f.runtime.tasks.wait(scope,task.id,3000,new AbortController().signal);
  assert.equal(f.errors(),'');
 }finally{release();await f.close();}
});

test('等待工作区独占权的任务可取消，不启动子模型且保留稳定终态',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let parents=0,children=0;
 const f=await runtimeFixture(async request=>{
  if(JSON.stringify(request.body).includes('orbitcode_child_role')){children++;await gate;return say('完成');}
  if(++parents<=2)return call('agent',{operation:'start',task:{kind:'fork',prompt:`独占任务${parents}`,background:true}},`start-${parents}`);
  return say('父完成');
 });
 try{
  await f.runtime.memory.setEnabled(false);await f.controller.handleLine('两个写能力任务');await waitUntil(()=>children===1);
  const cp=await f.checkpoint(),scope=await f.runtime.taskScope(cp.summary.id),tasks=f.runtime.tasks.list(scope);
  const cancelled=await f.runtime.tasks.cancel(scope,tasks[1].id);
  assert.ok(cancelled.state.status==='terminal'&&cancelled.state.result.terminationSource==='user'&&cancelled.state.result.cleanup==='complete');
  if(cancelled.state.status==='terminal')assert.equal(cancelled.state.result.failures.length,0);
  assert.equal(children,1);assert.equal(f.runtime.tasks.get(scope,tasks[1].id).id,tasks[1].id);
  release();await f.runtime.tasks.wait(scope,tasks[0].id,3000,new AbortController().signal);assert.equal(children,1);
 }finally{release();await f.close();}
});
