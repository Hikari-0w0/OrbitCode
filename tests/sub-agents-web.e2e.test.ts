import test from 'node:test';import assert from 'node:assert/strict';import {subAgentFixture} from './helpers/sub-agent-fixture';import {agentTaskHttp} from '@/web/agent-task-http';
test('Web 作用域、转后台和取消走共用运行时，外域请求拒绝',async()=>{const f=await subAgentFixture();try{await f.controller.handleLine('委派');const cp=await f.checkpoint();const scope=await f.runtime.taskScope(cp.summary.id);const task=f.runtime.tasks.list(scope)[0];
 const request=(path:string,method='GET')=>new Request(`http://localhost${path}`,{method,headers:{host:'localhost',origin:'http://localhost',...(method==='POST'?{'content-type':'application/json'}:{})},...(method==='POST'?{body:'{}'}:{})});
 assert.equal((await agentTaskHttp(request('/tasks'),cp.summary.id,f.runtime)).status,200);
 assert.equal((await agentTaskHttp(request('/tasks','POST'),cp.summary.id,f.runtime,task.id,'detach')).status,200);
 assert.equal((await agentTaskHttp(request('/tasks'),cp.summary.id,f.runtime,'unknown')).status,400);
 assert.equal((await agentTaskHttp(new Request('http://evil.invalid/tasks',{headers:{host:'evil.invalid'}}),cp.summary.id,f.runtime)).status,403);
 f.release();assert.equal((await agentTaskHttp(request('/tasks','POST'),cp.summary.id,f.runtime,task.id,'cancel')).status,200);
}finally{await f.close();}});
