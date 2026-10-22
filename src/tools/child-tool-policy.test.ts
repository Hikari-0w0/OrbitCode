import test from 'node:test';import assert from 'node:assert/strict';import {ToolRegistry,defineTool,successfulToolResult} from './registry';import {objectSchema} from './schema';import {createModeToolPolicy} from './mode-policy';import {ChildToolPolicy} from './child-tool-policy';import {parseAgentRole} from '@/runtime/agents/definition';import {readFile} from 'node:fs/promises';
test('加载工具豁免仍受父和角色黑名单约束，agent 永远禁止',async()=>{let executions=0;const registry=new ToolRegistry(['agent','load_skill'].map(name=>defineTool({name:name==='agent'?'agent':'load_skill',description:'test',mutability:'read-only',inputSchema:objectSchema({}),permission:{targetKind:'context',resolve:()=>({kind:'context',reference:'test'})},execute:async()=>{executions++;return successfulToolResult({},'none');}})));const role=parseAgentRole((await readFile('agents/explorer.md','utf8')).replace('disallowed-tools: [agent,','disallowed-tools: [load_skill, agent,'));const policy=new ChildToolPolicy(createModeToolPolicy(registry,'do'),new Set(['agent','load_skill']),role);assert.equal(policy.definitions().length,0);assert.equal(policy.prepare('agent',{}).kind,'failure');assert.equal(policy.prepare('load_skill',{}).kind,'failure');assert.equal(executions,0);});

test('接纳后修改源工具集合不能扩权，动态撤销仍拒绝已准备调用',async()=>{
 const registry=new ToolRegistry([defineTool({name:'load_skill',description:'test',mutability:'read-only',inputSchema:objectSchema({}),permission:{targetKind:'context',resolve:()=>({kind:'context',reference:'test'})},execute:async()=>successfulToolResult({},'none')})]);
 const parent=new Set<string>(),current=new Set(['load_skill']);
 const denied=new ChildToolPolicy(createModeToolPolicy(registry,'do'),parent);parent.add('load_skill');
 assert.equal(denied.prepare('load_skill',{}).kind,'failure','源集合后续新增不能改变接纳上限');
 const admitted=new ChildToolPolicy(createModeToolPolicy(registry,'do'),parent,undefined,async()=>current);
 const prepared=admitted.prepare('load_skill',{});assert.equal(prepared.kind,'ready');
 if(prepared.kind!=='ready')throw new Error('测试工具准备失败');
 current.clear();
 const {createWorkspaceBoundary}=await import('./workspace');
 const result=await admitted.executePrepared(prepared.call,{signal:new AbortController().signal,deadlineMs:Date.now()+1000,workspace:await createWorkspaceBoundary(process.cwd())});
 assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error.kind,'permission-denied');
});
