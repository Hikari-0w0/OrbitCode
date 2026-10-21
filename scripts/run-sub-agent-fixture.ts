import path from 'node:path';
import {mkdir,writeFile}from 'node:fs/promises';
import {startOpenAIMockServer}from '../tests/helpers/openai-mock';
import {call,say}from '../tests/helpers/skill-fixture';
import {LocalSettingsStore}from '@/lib/local-settings-store';
import {SettingsService}from '@/runtime/settings-service';
import {DEFAULT_SUB_AGENT_LIMITS}from '@/core/sub-agents/types';
async function main() {
const index=process.argv.indexOf('--root');
if(index<0||!process.argv[index+1])throw new Error('必须显式指定 --root <本次隔离目录>。');
const root=path.resolve(process.argv[index+1]);
const workspace=path.join(root,'workspace'),data=path.join(root,'data');
await mkdir(workspace,{recursive:true});
await writeFile(path.join(workspace,'evidence.txt'),'本地替身验收文件\n');
const settings=new SettingsService(new LocalSettingsStore(data));
if(await settings.load())throw new Error('隔离目录已有配置，请选择新的 --root，避免覆盖。');
await mkdir(path.join(workspace,'.orbitcode/agents'),{recursive:true});
await writeFile(path.join(workspace,'.orbitcode/agents/runner.md'),'---\nname: runner\ndescription: 本地命令超时测试角色\nallowed-tools: [run_command, read_file, report_completion]\ndisallowed-tools: [agent]\nmodel: inherit\nmax-iterations: 8\npermission-mode: permissive\n---\n只执行明确要求的隔离本地测试，保留退出码、超时和验证边界。\n');
const server=await startOpenAIMockServer(request=>{
 const serialized=JSON.stringify(request.body);
 const body=request.body as {messages?:{role:string;content?:string|null;tool_calls?:{function:{name:string}}[]}[]};
 const messages=body.messages??[];
 const last=messages.at(-1);
 const user=messages.findLast(m=>m.role==='user'&&!m.content?.startsWith('子任务 '));
 const taskPrompt=user?.content??'';
 if(serialized.includes('orbitcode_child_role')) {
   if(taskPrompt.includes('最大轮次')||last?.role==='user'){
     const response=call(taskPrompt.includes('命令超时')?'run_command':taskPrompt.includes('审批写入')?'write_file':'read_file',taskPrompt.includes('命令超时')?{command:'sleep 1',timeout_ms:100}:taskPrompt.includes('审批写入')?{path:'child-output.txt',content:'测试写入'}:taskPrompt.includes('无效参数')?{path:42}:{path:taskPrompt.includes('工具失败')?'missing.txt':'evidence.txt'},`child-${messages.length}`);
     return taskPrompt.includes('慢任务')?{...response,chunks:response.chunks?.map(chunk=>({...chunk,delayMs:6000}))}:response;
   }
   return say('子执行结束：已保留工具事实；最终回复不代表验收通过。');
 }
 if(last?.role==='tool'||messages.slice(user?messages.indexOf(user)+1:0).some(m=>m.tool_calls?.some(call=>call.function.name==='agent')))return say('父轮次结束，子任务由运行时管理。');
 const prompt=taskPrompt;
 if(prompt.includes('读取结果')||prompt.includes('继续'))return say('根据子任务结构化结果说明停止与验证状态。');
 return call('agent',{operation:'start',task:prompt.includes('Fork')||prompt.includes('fork')?{kind:'fork',prompt,background:true}:{kind:'defined',role:prompt.includes('命令超时')?'runner':prompt.includes('审批写入')?'general':'explorer',prompt,background:prompt.includes('后台')}},`delegate-${messages.length}`);
});
await settings.apply(0,{type:'provider-add',displayName:'本地子 Agent 替身',model:'sub-agent-fixture',baseUrl:server.baseUrl,windowTokens:128000,credential:{kind:'local',value:'synthetic-local-fixture'}});
const added=await settings.apply(1,{type:'workspace-add',name:'子 Agent 隔离验收',rootPath:workspace});
await settings.apply(2,{type:'preferences-set',maxIterations:8,maxRuntimeMinutes:5,defaultPermissionMode:'default',subAgents:{...DEFAULT_SUB_AGENT_LIMITS,waitSeconds:30}});
await mkdir(path.join(data,'memory-state-v1'),{recursive:true});
await writeFile(path.join(data,'memory-state-v1/settings.json'),'{"enabled":false}');
console.log(JSON.stringify({root,data,workspace,provider:added.providers[0].id,workspaceId:added.workspaces[0].id,baseUrl:server.baseUrl,web:`ORBITCODE_DATA_DIR='${data}' npm run dev -- --port 3109`,cli:`npm run cli -- --data-dir '${data}'`,prompts:['委派定义式探索 evidence.txt','后台慢任务探索 evidence.txt','Fork 慢任务探索 evidence.txt','审批写入 child-output.txt','无效参数','工具失败','最大轮次','读取结果']},null,2));
await new Promise<void>(resolve=>{const stop=()=>{void server.close().then(resolve);};process.once('SIGINT',stop);process.once('SIGTERM',stop);});

}
void main().catch(error=>{console.error(error instanceof Error?error.message:"替身启动失败。");process.exitCode=1;});
