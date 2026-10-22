import test from 'node:test';import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';import path from 'node:path';
test('角色同时允许和禁止的MCP工具不再被接纳或启动视为必需能力',async()=>{
 let parents=0;
 const f=await runtimeFixture(request=>JSON.stringify(request.body).includes('orbitcode_child_role')?say('只执行自包含任务'):++parents===1?call('agent',{operation:'start',task:{kind:'defined',role:'contradiction',prompt:'只返回文字',background:true}},'delegate'):say('父结束'));
 try{
  await f.runtime.memory.setEnabled(false);
  await mkdir(path.join(f.root,'.orbitcode/agents'),{recursive:true});
  await writeFile(path.join(f.root,'.orbitcode/agents/contradiction.md'),'---\nname: contradiction\ndescription: 拒绝优先\nallowed-tools: [read_file, mcp__unavailable]\ndisallowed-tools: [mcp__unavailable]\nmodel: inherit\nmax-iterations: 2\npermission-mode: default\n---\n只执行文字任务。');
  await f.controller.handleLine('创建矛盾角色任务');
  const cp=await f.checkpoint(),scope=await f.runtime.taskScope(cp.summary.id),tasks=f.runtime.tasks.list(scope);
  assert.equal(tasks.length,1);const done=await f.runtime.tasks.wait(scope,tasks[0].id,3000,new AbortController().signal);
  assert.ok(done.task.state.status==='terminal'&&done.task.state.result.stopReason==='final-response');
  assert.deepEqual(done.task.admission?.requiredExternalTools,[]);assert.deepEqual(done.task.admission?.tools,['read_file']);
  assert.equal(done.task.workspaceAccess,'read-only');assert.equal(done.task.preparedContext?.messages,0);
 }finally{await f.close();}
});
import {runtimeFixture}from './helpers/runtime-fixture';import{configureMcpFixture}from './helpers/mcp-fixture';import{call,say}from './helpers/skill-fixture';
test('父轮次清理后，Fork 使用自己的 MCP 租约完成受权限保护的调用',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let parentCalls=0,childCalls=0;
 const f=await runtimeFixture(async request=>{const body=request.body as {tools?:{function:{name:string}}[]};if(JSON.stringify(request.body).includes('orbitcode_child_role')){if(++childCalls===1){await gate;const name=body.tools?.find(tool=>tool.function.name.startsWith('mcp__'))?.function.name;assert.ok(name);return call(name,{text:'child-owned'},'child-mcp');}return say('外部调用已观察');}return ++parentCalls===1?call('agent',{operation:'start',task:{kind:'fork',prompt:'调用允许的 echo',background:true}},'delegate'):say('父已完成');},{terminal:true});
 const mcp=await configureMcpFixture(f.root,'http');
 try{await f.runtime.memory.setEnabled(false);await f.controller.handleLine('委派 MCP');assert.equal(f.errors(),'');const cp=await f.checkpoint(),scope=await f.runtime.taskScope(cp.summary.id),task=f.runtime.tasks.list(scope)[0];release();const done=await f.runtime.tasks.wait(scope,task.id,3000,new AbortController().signal);assert.ok(done.task.state.status==='terminal'&&done.task.state.result.stopReason==='final-response');assert.ok(mcp.methods.includes('tools/call'));assert.equal(mcp.methods.filter(m=>m==='initialize').length,1);assert.equal(done.task.state.status==='terminal'?done.task.state.result.failures.length:-1,0);}finally{release();await f.close();await mcp.close();}
});
