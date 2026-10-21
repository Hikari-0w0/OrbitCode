import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import path from 'node:path';import {runtimeFixture} from './helpers/runtime-fixture';import {call,say} from './helpers/skill-fixture';
for(const terminal of [false,true])test(`CLI terminal=${terminal}无需人工审批且旧命令不能授权`,async()=>{
 let count=0;const f=await runtimeFixture(()=>++count===1?call('write_file',{path:'direct.txt',content:'direct'}):say('完成'),{terminal});
 try{await f.controller.handleLine('写入文件');assert.equal(await readFile(path.join(f.root,'direct.txt'),'utf8'),'direct');assert.equal(f.output().includes('需要授权'),false);await f.controller.handleLine('/approve retired once');assert.match(f.errors(),/人工审批已移除/);await f.controller.handleLine('/task approve retired request once');assert.match(f.errors(),/使用/);const c=await f.checkpoint();assert.deepEqual(await f.guard.inspect(c.summary.id),{status:'idle'});}finally{await f.close();}
});
