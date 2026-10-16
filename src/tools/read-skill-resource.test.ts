import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { runtimeFixture, waitUntil } from '../../tests/helpers/runtime-fixture';
import { writeSkill, call, say } from '../../tests/helpers/skill-fixture';
test('资源读取使用路径审批，拒绝后内容不进入模型上下文',async()=>{
 let count=0;const fixture=await runtimeFixture(()=>++count===1?call('read_skill_resource',{name:'resource',path:'private.txt'}):say('读取被拒绝'),{terminal:true});
 try{
 const root=await writeSkill(fixture,'resource',{tools:['read_skill_resource']});await writeFile(path.join(root,'private.txt'),'RESOURCE_NOT_GRANTED_SENTINEL');await fixture.controller.handleLine('/permissions strict');const running=fixture.controller.handleLine('/skill run resource');await waitUntil(()=>/\/approve ([\w-]+) </.test(fixture.output()));const id=/\/approve ([\w-]+) </.exec(fixture.output())?.[1];assert.ok(id);await fixture.controller.handleLine(`/approve ${id} deny`);await running;assert.match(fixture.output(),/user-denied/);assert.doesNotMatch(JSON.stringify(fixture.server.requests),/RESOURCE_NOT_GRANTED_SENTINEL/);
 }finally{await fixture.close();}
});
