import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadProviderContext, resolveRuntimeProvider } from '@/runtime/config';
import { realSubAgentFixture, scrubCredential } from './evals/sub-agent-real-fixture';
import { assertTaskTiming } from './evals/assert-task-timing';
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function main(){
 if(!process.argv.includes('--allow-real-model'))throw new Error('真实模型评测需要显式 --allow-real-model。');
 const root=process.argv.find(argument=>argument.startsWith('--root='))?.slice('--root='.length);
 if(!root)throw new Error('需要指定新的 --root= 证据目录。');
 const base=path.resolve(root);await mkdir(base,{mode:0o700});
 const context=await loadProviderContext(),source=resolveRuntimeProvider(context,context.defaultProviderId??context.providers[0].name);
 const results:{name:string;root?:string;status:'passed'|'failed';error?:string}[]=[];
 for(const name of ['cancel','runtime-close']){
  let f:Awaited<ReturnType<typeof realSubAgentFixture>>|undefined,closed=false,childPid:number|undefined;
  const outcome:typeof results[number]={name,status:'failed'};const heartbeat=setInterval(()=>console.log(JSON.stringify({event:'running',name})),30000);
  try{
   f=await realSubAgentFixture(base,name,source);outcome.root=f.root;
   await f.run('实际只创建1个defined后台子任务role=builder，background=true，创建后父立即简短回复，不wait、不取消、不代做。子任务只调用run_command执行：node -e "require(\'fs\').writeFileSync(\'started.txt\',JSON.stringify({pid:process.pid,marker:\'LIFECYCLE_EVAL_20261020\'}));setTimeout(()=>require(\'fs\').writeFileSync(\'late.txt\',\'LATE\'),20000)"，timeoutMs=25000。运行过程中不要另开其他进程、不要主动缩短时限、不要创建任何其他文件。','delegate-only','defined');
   const deadline=Date.now()+30000;for(;;){try{const started=JSON.parse(await readFile(path.join(f.workspace,'started.txt'),'utf8'));assert.equal(started.marker,'LIFECYCLE_EVAL_20261020');assert.ok(Number.isSafeInteger(started.pid)&&started.pid>1);childPid=started.pid;break;}catch{if(Date.now()>deadline)throw new Error('未观察到真实子命令启动');await delay(50);}}
   const before=await f.tasks();assert.equal(before.length,1);assert.equal(before[0].state.status,'running');
   const startedAt=Date.now();if(name==='cancel')await f.run(`/task cancel ${before[0].id}`);else{await f.close();closed=true;}
   const elapsedMs=Date.now()-startedAt,after=(await f.tasks())[0];assert.equal(after.state.status,'terminal');assertTaskTiming(after);assert.equal(after.timing?.stopRequested?.phase,'execution');
   if(after.state.status!=='terminal')throw new Error('没有终态');
   assert.equal(after.state.result.stopReason,'cancelled');assert.equal(after.state.result.terminationSource,name==='cancel'?'user':'runtime-close');assert.equal(after.state.result.cleanup,'complete');
   let alive=false;try{process.kill(childPid!,0);alive=true;}catch{}
   assert.equal(alive,false,'子进程已终止');await assert.rejects(access(path.join(f.workspace,'late.txt')));
   await f.save('lifecycle-assessment.json',{before,after,elapsedMs,childPid,alive,childRuns:await f.log.findAllForConversation(after.id),commandCancelledFlagPreserved:after.state.result.handoff?.commandCalls.results.some(call=>call.cancelled===true)??false});
   assert.ok(after.state.result.handoff?.commandCalls.results.some(call=>call.cancelled===true),'执行已取消，但原始命令取消字段未保留');
   outcome.status='passed';
  }catch(error){outcome.error=scrubCredential(String(error),source);}
  finally{
   if(f&&!closed)try{await f.close();}catch{outcome.status='failed';outcome.error='清理失败';}
   clearInterval(heartbeat);results.push(outcome);await writeFile(path.join(base,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(outcome));
  }
 }
 if(results.some(result=>result.status!=='passed'))process.exitCode=1;
}
main().catch(()=>{console.error('生命周期评测未完成：检查真实模型授权、配置和新建证据目录；未输出原始异常或凭据。');process.exitCode=1;});
