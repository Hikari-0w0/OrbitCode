import test from 'node:test';import assert from 'node:assert/strict';import{mkdtemp,rm}from 'node:fs/promises';import{tmpdir}from 'node:os';import path from 'node:path';import{LocalContextStore}from '@/lib/local-context-store';import{selectSkillHistory}from './history';
test('Fork 全量历史损坏配对直接拒绝，不截掉未配对调用冒充完整快照',async()=>{const root=await mkdtemp(path.join(tmpdir(),'fork-history-'));try{const parent=new LocalContextStore(path.join(root,'parent')),child=new LocalContextStore(path.join(root,'child'));await assert.rejects(selectSkillHistory({messages:[{kind:'user',content:'目标'},{kind:'assistant-tool-call',content:null,toolCalls:[{id:'pending',name:'read_file',argumentsJson:'{}'}]}],history:{kind:'all'},parentId:'parent',childId:'child',parentStore:parent,childStore:child,signal:new AbortController().signal}),/完整结果/);}finally{await rm(root,{recursive:true,force:true});}});

test('Fork只为实际复制的引用建立别名，不授权其他父对象或定义式空历史',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'fork-alias-'));
 try{
  const parent=new LocalContextStore(path.join(root,'parent')),child=new LocalContextStore(path.join(root,'child')),signal=new AbortController().signal;
  const copied=await parent.write({sessionId:'parent',content:'marker😀',signal});
  const excluded=await parent.write({sessionId:'parent',content:'secret',signal});
  const aliases=new Map<string,string>();
  const messages=await selectSkillHistory({messages:[{kind:'assistant-tool-call',content:null,toolCalls:[{id:'read',name:'read_file',argumentsJson:'{}'}]},{kind:'tool-result',toolCallId:'read',payload:{storage:'offloaded',reference:copied.reference,originalBytes:10,estimatedTokens:5,preview:'摘要'}}],history:{kind:'all'},parentId:'parent',childId:'child',parentStore:parent,childStore:child,signal,referenceAliases:aliases});
  assert.equal(aliases.size,1);assert.ok(aliases.has(copied.reference));assert.equal(aliases.has(excluded.reference),false);
  const rebound=aliases.get(copied.reference);assert.ok(rebound);
  assert.equal((await child.search({sessionId:'child',reference:rebound,query:'marker',signal})).matchCount,1);
  await assert.rejects(child.search({sessionId:'child',reference:excluded.reference,query:'secret',signal}));
  const emptyAliases=new Map<string,string>();
  assert.deepEqual(await selectSkillHistory({messages,history:{kind:'none'},parentId:'parent',childId:'empty',parentStore:parent,childStore:child,signal,referenceAliases:emptyAliases}),[]);
  assert.equal(emptyAliases.size,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
