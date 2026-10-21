import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {loadProviderContext,resolveRuntimeProvider} from '@/runtime/config';
import {realSubAgentFixture,scrubCredential} from './evals/sub-agent-real-fixture';
import {assertTaskTiming} from './evals/assert-task-timing';

type Result={name:string;status:'passed'|'failed';root?:string;error?:string};
async function main(){
 if(!process.argv.includes('--allow-real-model'))throw new Error('必须显式授权真实模型。');
 const root=process.argv.find(arg=>arg.startsWith('--root='))?.slice(7);
 if(!root)throw new Error('需要新的证据目录。');
 const repeat=Number(process.argv.find(arg=>arg.startsWith('--repeat='))?.slice(9)??1);
 if(!Number.isSafeInteger(repeat)||repeat<1||repeat>5)throw new Error('repeat 超出范围。');
 const base=path.resolve(root);await mkdir(base,{mode:0o700});
 const config=await loadProviderContext(),source=resolveRuntimeProvider(config,config.defaultProviderId??config.providers[0].name);
 const results:Result[]=[];
 for(let iteration=1;iteration<=repeat;iteration++)for(const name of ['counter','readers'] as const){
  let fixture:Awaited<ReturnType<typeof realSubAgentFixture>>|undefined;
  const result:Result={name:`${name}-${iteration}`,status:'failed'};
  const heartbeat=setInterval(()=>console.log(JSON.stringify({event:'running',case:result.name})),30000);
  try{
   fixture=await realSubAgentFixture(base,result.name,source,{'count.txt':'0','evidence.txt':'READ_ONLY_WORKSPACE_PROOF_20261021'});result.root=fixture.root;
   const child=name==='counter'
    ? '先用read_file读取count.txt中的整数，将实际读到的值加1，再用write_file写回同一个文件。只做一次递增，不使用run_command、edit_file、write_files或其他写入方式，不改其他文件。最后简短说明实际读写的数字。'
    : '只用read_file读取evidence.txt并原样返回其中的标记，不运行命令或修改文件。';
   const role=name==='counter'?'builder':'reader';
   await fixture.run(`这是隔离工作区的明确验收任务。父级只用agent工具创建恰好两个defined子任务，role=${role}，background=true，分别在子prompt加入WORKSPACE_TASK_A和WORKSPACE_TASK_B。两个子任务的完整工作指令均为：${child}。先创建全部两个再等待结果，不增加第三个任务，不重试，不代做。父只使用agent start/wait/status/result，不读写文件或运行命令。最后如实报告结构化结果。`,'delegate-only','defined');
   const tasks=await fixture.settle();await fixture.save('workspace-observation.json',{tasks,calls:fixture.calls,model:source.model});assert.equal(tasks.length,2);
   for(const task of tasks){
    assertTaskTiming(task);
    assert.equal(task.kind,'defined');assert.equal(task.role,role);assert.equal(task.workspaceAccess,name==='counter'?'exclusive':'read-only');
    assert.ok(task.state.status==='terminal'&&task.state.result.stopReason==='final-response');
    if(task.state.status!=='terminal')throw new Error('缺少终态');
    assert.equal(task.state.result.cleanup,'complete');
    assert.ok(task.state.result.handoff?.reads?.files.some(file=>file.path===(name==='counter'?'count.txt':'evidence.txt')));
    if(name==='counter')assert.ok(task.state.result.handoff?.fileWrites.paths.includes('count.txt'));
    else assert.ok(task.state.result.finalReply?.includes('READ_ONLY_WORKSPACE_PROOF_20261021'));
   }
   const calls=fixture.calls.filter(item=>item.child);assert.ok(calls.filter(item=>item.call.name==='read_file').length>=2);
   assert.ok(calls.every(item=>(name==='counter'?['read_file','write_file']:['read_file']).includes(item.call.name)));
   assert.equal(calls.filter(item=>['write_file','write_files','edit_file','run_command'].includes(item.call.name)).length,name==='counter'?2:0);
   assert.ok(fixture.calls.filter(item=>!item.child).every(item=>item.call.name==='agent'));
   const independent=await fixture.independent(name==='counter'
    ? "import assert from 'node:assert/strict';import{readFileSync}from 'node:fs';assert.equal(readFileSync('count.txt','utf8').trim(),'2');assert.equal(readFileSync('evidence.txt','utf8'),'READ_ONLY_WORKSPACE_PROOF_20261021');"
    : "import assert from 'node:assert/strict';import{readFileSync}from 'node:fs';assert.equal(readFileSync('count.txt','utf8'),'0');assert.equal(readFileSync('evidence.txt','utf8'),'READ_ONLY_WORKSPACE_PROOF_20261021');");
   assert.equal(independent.exitCode,0);
   await fixture.save('workspace-assessment.json',{tasks,calls:fixture.calls,independent,model:source.model});result.status='passed';
  }catch(error){result.error=scrubCredential(String(error),source);}
  finally{
   if(fixture)try{await fixture.close();}catch{result.status='failed';result.error='清理失败';}
   clearInterval(heartbeat);results.push(result);await writeFile(path.join(base,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(result));
  }
 }
 if(results.some(result=>result.status==='failed'))process.exitCode=1;
}
main().catch(()=>{console.error('工作区评测未完成：检查授权、配置和新证据目录；不输出原始异常或凭据。');process.exitCode=1;});
