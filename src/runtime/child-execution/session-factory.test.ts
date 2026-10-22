import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {parseAgentRole} from '@/runtime/agents/definition';
import {createChildSession} from './session-factory';
import {runtimeFixture} from '../../../tests/helpers/runtime-fixture';
import {say} from '../../../tests/helpers/skill-fixture';
import {LocalContextStore} from '@/lib/local-context-store';
import {loadProviderContext,resolveRuntimeProvider} from '@/runtime/config';
import {loadSkillCatalog} from '@/runtime/skills/catalog';
import {createWorkspaceBoundary} from '@/tools/workspace';
import {MacOsSeatbeltCommandSandbox} from '@/tools/macos-seatbelt-sandbox';
import type {ChatProvider} from '@/models/provider';
import type {ManagedContextMessage} from '@/core/context/types';

test('子会话重量压缩后角色指令持续存在，摘要与执行用量各自计量',async()=>{
 const f=await runtimeFixture(()=>say('unused'));
 let child:Awaited<ReturnType<typeof createChildSession>>|undefined;
 try {
  const config=resolveRuntimeProvider(await loadProviderContext(f.root,{FIXTURE_KEY:'synthetic'},undefined,true,undefined,false),'primary');
  const roleFile=path.join(f.root,'role.md');
  const original=(await readFile('agents/explorer.md','utf8'))+'\nROLE_LIFETIME_MARKER';
  await writeFile(roleFile,original);
  const role=parseAgentRole(await readFile(roleFile,'utf8'));
  let summaries=0,requests=0;
  const provider:ChatProvider={async *stream(messages,options){
   if(options.toolChoice==='none'){
    summaries++;
    yield {type:'text-delta',text:JSON.stringify({analysisDraft:'仅压缩旧助手内容',summary:{taskGoals:['继续子任务'],completedWork:[],keyDecisions:[],fileChanges:[],toolResults:[],errors:[],nextSteps:[]}})};
   }else{requests++;assert.ok(JSON.stringify(messages).includes('ROLE_LIFETIME_MARKER'));assert.ok(!JSON.stringify(messages).includes('ROLE_NEXT_MARKER'));assert.ok(JSON.stringify(messages).includes('orbitcode_context_summary'));if(requests===1){await writeFile(roleFile,original.replace('ROLE_LIFETIME_MARKER','ROLE_NEXT_MARKER'));yield {type:'tool-call',call:{id:'read-role',name:'read_file',argumentsJson:'{"path":"evidence.txt"}'}};}else yield {type:'text-delta',text:'完成但未验证'};}
   yield {type:'done',finishReason:options.toolChoice!=='none'&&requests===1?'tool-call':'stop'};
  }};
  const empty=path.join(f.root,'empty');await mkdir(empty);await writeFile(path.join(f.root,'evidence.txt'),'独立文件');
  const catalog=await loadSkillCatalog({workspaceRoot:f.root,userRoot:empty,builtinRoot:empty});
  const history:ManagedContextMessage[]=[{kind:'user',content:'旧目标'},{kind:'assistant',content:'a'.repeat(19000)},...Array.from({length:6},(_,i):ManagedContextMessage=>({kind:i%2===0?'user':'assistant',content:'短消息'}))];
  child=await createChildSession({child:{id:'child',store:new LocalContextStore(path.join(f.root,'child-context')),history,maxRuntimeMs:5000,maxIterations:2},config:{...config,context:{...config.context,windowTokens:14000,automaticReserveTokens:8000,manualReserveTokens:1000,recentMessagesTokens:1,singleToolResultTokens:1000,toolResultGroupTokens:1500}},provider,sandbox:new MacOsSeatbeltCommandSandbox(),workspace:await createWorkspaceBoundary(f.root),catalog,modelIds:new Set(['primary']),parentTools:new Set(['read_file']),externalTools:[],options:{maxIterations:2,promptEnvironment:{workspace:{id:'test',name:'test'},platform:'darwin',currentDate:'2026-10-19',timeZone:'Asia/Shanghai',pathSemantics:'workspace-relative-posix'},optionalPromptContext:{childRole:role.instructions}}});
  const events=[];for await(const event of child.agent.streamTurn({input:'新子任务',mode:'do',modeTurn:1,signal:new AbortController().signal}))events.push(event);
  assert.equal(events.at(-1)?.type,'stopped');assert.ok(events.some(event=>event.type==='stopped'&&event.reason==='final-response'),JSON.stringify(events.at(-1)));
  assert.equal(summaries,1);assert.equal(requests,2);assert.ok(parseAgentRole(await readFile(roleFile,'utf8')).instructions.includes('ROLE_NEXT_MARKER'));assert.equal(child.modelUsage().categories.find(c=>c.purpose==='summary')?.requests,1);
 }finally{await child?.close();await f.close();}
});
