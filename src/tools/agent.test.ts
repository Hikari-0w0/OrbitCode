import test from 'node:test';import assert from 'node:assert/strict';import {parseAgentRequest} from './agent';
test('start携带wait专用字段时给出可执行的纠正说明，仍拒绝原调用',()=>{
 assert.throws(()=>parseAgentRequest({operation:'start',task:{kind:'defined',role:'explorer',prompt:'读取'},timeoutMs:300000}),/timeoutMs.*wait/);
 assert.deepEqual(parseAgentRequest({operation:'start',task:{kind:'defined',role:'explorer',prompt:'读取'}}),{operation:'start',task:{kind:'defined',role:'explorer',prompt:'读取',background:false}});
});
test('统一委派参数有明确类型边界并拒绝伪造来源',()=>{assert.deepEqual(parseAgentRequest({operation:'start',task:{kind:'fork',prompt:'任务'}}),{operation:'start',task:{kind:'fork',prompt:'任务',background:true}});for(const value of [{operation:'start',task:{kind:'fork',prompt:'x',background:false}},{operation:'start',task:{kind:'defined',prompt:'x'}},{operation:'wait',taskId:'x',timeoutMs:Infinity},{operation:'cancel',taskId:'x',workspace:'/'}])assert.throws(()=>parseAgentRequest(value));});
// 正文读取只有任务身份与分页参数，不能传入任意文件路径或其他会话身份。
test('子正文分页参数拒绝越界、非整数及伪造作用域',()=>{assert.deepEqual(parseAgentRequest({operation:'result',taskId:'task',offset:0,limit:4000}),{operation:'result',taskId:'task',offset:0,limit:4000});for(const value of [{operation:'result',taskId:'task',offset:-1},{operation:'result',taskId:'task',limit:4001},{operation:'result',taskId:'task',conversationId:'other'},{operation:'result',taskId:'task',path:'../secret'},{operation:'result',taskId:'task',offset:1.2}])assert.throws(()=>parseAgentRequest(value));});

test('显式委派类型同时约束模型schema、参数解析和直接执行，错误类型不产生任务',async()=>{
  const {createAgentTool}=await import('./agent');
  const {successfulToolResult,ToolRegistry}=await import('./registry');
  const {createWorkspaceBoundary}=await import('./workspace');
  let starts=0;
  const tool=createAgentTool(async()=>{starts++;return successfulToolResult({created:true});},'fork');
  const registry=new ToolRegistry([tool]);
  const bad={operation:'start',task:{kind:'defined',role:'explorer',prompt:'x',background:true}};
  assert.equal(registry.prepare('agent',bad).kind,'failure');
  assert.equal(tool.inputSchema.parse(bad).ok,false);
  assert.match(JSON.stringify(registry.definitions()[0]),/本轮用户限定/);
  const context={workspace:await createWorkspaceBoundary(process.cwd()),signal:new AbortController().signal,deadlineMs:Date.now()+1000};
  assert.equal((await tool.execute(parseAgentRequest(bad),context)).ok,false);
  assert.equal(starts,0);
  assert.equal((await registry.execute('agent',{operation:'start',task:{kind:'fork',prompt:'x'}},context)).ok,true);
  assert.equal(starts,1);
});

test('验收只能引用任务ID，不能携带通过结论、路径或其他会话身份',()=>{assert.deepEqual(parseAgentRequest({operation:'verify',taskId:'task'}),{operation:'verify',taskId:'task'});for(const value of [{operation:'verify',taskId:'task',status:'passed'},{operation:'verify',taskId:'task',path:'../secret'},{operation:'verify',taskId:'task',conversationId:'other'}])assert.throws(()=>parseAgentRequest(value));});
