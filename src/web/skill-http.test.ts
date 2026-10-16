import test from 'node:test';import assert from 'node:assert/strict';import {runtimeFixture} from '../../tests/helpers/runtime-fixture';import {say} from '../../tests/helpers/skill-fixture';import {skillHttp} from './skill-http';
test('Skill HTTP 校验本机来源与请求结构，列表不请求模型或返回完整定义',async()=>{
 const fixture=await runtimeFixture(()=>say('不应调用'));try{const c=await fixture.checkpoint();
 const badOrigin=await skillHttp(new Request('http://evil.invalid/api/skills',{headers:{host:'evil.invalid'}}),c.summary.id,fixture.runtime);assert.equal(badOrigin.status,403);
 const badBody=await skillHttp(new Request('http://localhost/api/skills',{method:'POST',headers:{host:'localhost',origin:'http://localhost','content-type':'application/json'},body:JSON.stringify({action:'refresh',expectedRevision:0,root:'/etc'})}),c.summary.id,fixture.runtime);assert.equal(badBody.status,400);
 const response=await skillHttp(new Request('http://localhost/api/skills',{headers:{host:'localhost'}}),c.summary.id,fixture.runtime);assert.equal(response.status,200);const text=await response.text();assert.doesNotMatch(text,/resourceRoot|allowedTools|instructions/);assert.equal(fixture.server.requests.length,0);
 }finally{await fixture.close();}
});
