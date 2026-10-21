import {ModelRequestBudget} from "@/runtime/child-execution/request-budget";
import {ChildResultStore} from "@/lib/child-result-store";
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {runtimeFixture,waitUntil} from '../../../tests/helpers/runtime-fixture';
import {say} from '../../../tests/helpers/skill-fixture';
import {createDelegationTool} from './delegation';
import {BackgroundTaskManager} from '@/runtime/background-task-manager';
import {WorkspaceExecutionCoordinator} from '@/runtime/workspace-execution-coordinator';
import {loadProviderContext,resolveRuntimeProvider} from '@/runtime/config';
import {loadSkillCatalog} from '@/runtime/skills/catalog';
import {ContextManager} from '@/core/context/context-manager';
import {DEFAULT_SUB_AGENT_LIMITS} from '@/core/sub-agents/types';
import {LocalContextStore} from '@/lib/local-context-store';
import {createWorkspaceBoundary} from '@/tools/workspace';
import {MacOsSeatbeltCommandSandbox} from '@/tools/macos-seatbelt-sandbox';
import type {ChatProvider} from '@/models/provider';
import type {ManagedContextMessage} from '@/core/context/types';

test('子启动各阶段故障回收目录、容量及 MCP 租约，日志失败可见',async()=>{
 const f=await runtimeFixture(()=>say('不用 HTTP'));const oldTmp=process.env.TMPDIR;
 try{
  const config=resolveRuntimeProvider(await loadProviderContext(f.root,{FIXTURE_KEY:'synthetic'},undefined,true,undefined,false),'primary');
  const workspace=await createWorkspaceBoundary(f.root),empty=path.join(f.root,'empty');await mkdir(empty);
  const skills=await loadSkillCatalog({workspaceRoot:f.root,userRoot:empty,builtinRoot:empty});
  for(const fault of ['directory','reference','migration-cancel','session','mcp','execution','log','cleanup','none'] as const){
   const temp=await mkdtemp(path.join(tmpdir(),'child-fault-'));process.env.TMPDIR=temp;
   const tasks=new BackgroundTaskManager({...DEFAULT_SUB_AGENT_LIMITS,concurrency:1}),scope={conversationId:'parent',lifecycleEpoch:fault},controller=new AbortController();
   let modelCalls=0,releases=0;
   class ParentStore extends LocalContextStore{override async read(input:Parameters<LocalContextStore['read']>[0]){if(fault==='reference')throw new Error('引用复制失败');if(fault==='migration-cancel')void tasks.cancel(scope,tasks.list(scope)[0].id);return super.read(input);}}
   const store=new ParentStore(path.join(f.root,`context-${fault}`));
   const blob=await store.write({sessionId:'parent',content:'父卸载内容',signal:controller.signal});
   const history:ManagedContextMessage[]=[{kind:'user',content:'父目标'},{kind:'assistant-tool-call',content:null,toolCalls:[{id:'old',name:'read_file',argumentsJson:'{}'}]},{kind:'tool-result',toolCallId:'old',payload:{storage:'offloaded',reference:blob.reference,preview:'旧预览',originalBytes:15,estimatedTokens:5}}];
   const provider:ChatProvider={async *stream(messages){modelCalls++;if(fault==='execution')throw new Error('执行阶段失败');if(fault==='none'&&modelCalls===1){const reference=JSON.stringify(messages).match(/context:\/\/v1\/[a-z0-9-]+/)?.[0];assert.ok(reference);assert.notEqual(reference,blob.reference);yield{type:'tool-call',call:{id:'child-context-read',name:'read_context',argumentsJson:JSON.stringify({reference,offset:0,limit:1000})}};yield{type:'done',finishReason:'tool-call'};}else{if(fault==='none')assert.ok(JSON.stringify(messages).includes('父卸载内容'));yield{type:'text-delta',text:'模型完成'};yield{type:'done',finishReason:'stop'};}}};
   const contextManager=new ContextManager({sessionId:'parent',config:config.context,store,provider,initialState:{messages:history,consecutiveSummaryFailures:0}});
   if(fault==='directory'){await writeFile(path.join(temp,'not-directory'),'x');process.env.TMPDIR=path.join(temp,'not-directory');}
   let release!:()=>void;const held=fault==='none'?tasks.withForeground(new AbortController().signal,()=>new Promise<void>(resolve=>{release=resolve;})):undefined;
   const tool=createDelegationTool({requestBudget:new ModelRequestBudget("turn",128),childResults:new ChildResultStore(f.root),tasks,limits:DEFAULT_SUB_AGENT_LIMITS,scope,turnId:'turn',workspace,contextManager,parentStore:store,catalog:async()=>({entries:new Map(),diagnostics:[],complete:true,summary:''}),skills,active:()=>[],parentTools:()=>new Set(['read_context',...(fault==='mcp'||fault==='cleanup'?['mcp__fixture']:[])]),modelIds:new Set(['primary']),parentConfig:config,resolveConfig:()=>config,provider:()=>{if(fault==='session')throw new Error('创建会话失败');return provider;},parentIterations:2,parentRuntimeMs:2000,mode:'do',parentMode:'permissive',rules:[],currentPermissions:async()=>({mode:'permissive',rules:[]}),sandbox:new MacOsSeatbeltCommandSandbox(),optional:{},environment:{workspace:{id:'w',name:'w'},platform:'darwin',currentDate:'2026-10-19',timeZone:'Asia/Shanghai',pathSemantics:'workspace-relative-posix'},writes:new WorkspaceExecutionCoordinator(),runLog:{sink:{append:async()=>{if(fault==='log')throw new Error('日志写入失败');}},conversationId:'parent',providerId:'primary',workspaceId:'w',revisionBefore:0},initialize:async(_gateway,_signal,_deadline,leases)=>{leases.push({release:async()=>{releases++;if(fault==='cleanup')throw new Error('租约释放失败');}});if(fault==='mcp')throw new Error('MCP 初始化失败');return[];}});
   try{
    const prepared=tool.prepareUnknown({operation:'start',task:{kind:'fork',prompt:'子任务'}});assert.equal(prepared.kind,'ready');if(prepared.kind!=='ready')throw new Error('准备失败');
    const accepted=await prepared.call.execute({workspace,signal:controller.signal,deadlineMs:Date.now()+2000,callId:'create'});
    assert.equal(accepted.ok,true);
    const task=tasks.list(scope)[0];
    if(fault==='none'){
     await waitUntil(()=>tasks.get(scope,task.id).state.status==='queued');
     await store.deleteSession('parent');release();await held;
    }
    const done=await tasks.wait(scope,task.id,2500,new AbortController().signal);
    assert.equal(done.task.state.status,'terminal');if(done.task.state.status!=='terminal')throw new Error('没有终态');
    const result=done.task.state.result;
    if(['directory','reference','migration-cancel','session','mcp','execution'].includes(fault))assert.notEqual(result.stopReason,'final-response');else assert.equal(result.stopReason,'final-response');
    assert.equal(result.cleanup,fault==='cleanup'?'failed':'complete');
    if(['directory','reference','migration-cancel'].includes(fault)){
     assert.equal(modelCalls,0);assert.equal(tasks.list(scope).length,1);
     if(fault==='migration-cancel')assert.equal(result.terminationSource,'user');
    }
    if(fault==='none'){
     const retry=tool.prepareUnknown({operation:'start',task:{kind:'defined',role:'missing-after-admission',prompt:'不要重跑'}});
     assert.equal(retry.kind,'ready');if(retry.kind==='ready')assert.equal((await retry.call.execute({workspace,signal:new AbortController().signal,deadlineMs:Date.now()+1000,callId:'create'})).ok,false);
     assert.equal((await prepared.call.execute({workspace,signal:new AbortController().signal,deadlineMs:Date.now()+1000,callId:'create'})).ok,true);
     assert.equal(tasks.list(scope).length,1);assert.equal(modelCalls,2);
    }
    if(fault==='log')assert.equal(result.evidenceLog,'failed');
    if(fault==='mcp'||fault==='cleanup')assert.equal(releases,1);
    assert.equal((await readdir(temp)).filter(name=>name.startsWith('orbitcode-agent-')).length,0);
   }finally{release?.();await held;await tasks.close();process.env.TMPDIR=oldTmp; if(oldTmp===undefined)delete process.env.TMPDIR;await rm(temp,{recursive:true,force:true});}
  }
 }finally{if(oldTmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=oldTmp;await f.close();}
});
