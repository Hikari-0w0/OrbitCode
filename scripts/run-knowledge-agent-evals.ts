import { LocalConversationStore } from "@/lib/local-conversation-store";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, realpath, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalSettingsStore } from "@/lib/local-settings-store";
import { knowledgeForWorkspace } from "@/runtime/knowledge/factory";
import { record } from "@/runtime/knowledge/config";
import { contentHash } from "@/runtime/knowledge/access";
async function main(){
 const args=new Map<string,string>();for(let i=2;i<process.argv.length;i+=2){if(!["--data-dir","--workspace","--provider","--split","--take","--repetitions","--output"].includes(process.argv[i])||!process.argv[i+1])throw new Error();args.set(process.argv[i],process.argv[i+1]);}
 const sourceDirectory=args.get("--data-dir"),workspaceId=args.get("--workspace"),split=args.get("--split")??"test",take=Number(args.get("--take")??5),repetitions=Number(args.get("--repetitions")??3),output=args.get("--output");
 if(!sourceDirectory||!workspaceId||!output||!["dev","test"].includes(split)||!Number.isInteger(take)||take<1||take>60||!Number.isInteger(repetitions)||repetitions<1||repetitions>3)throw new Error();
 const source=await new LocalSettingsStore(path.resolve(sourceDirectory)).load(),workspace=source?.workspaces.find(item=>item.id===workspaceId&&item.enabled),provider=source?.providers.find(item=>item.id===(args.get("--provider")??source.defaultProviderId)&&item.enabled);
 if(!source||!workspace?.knowledge||!provider)throw new Error();
 const corpusRoot=await realpath(path.resolve("tests/fixtures/knowledge")),sourceQuestions=await readFile(path.join(corpusRoot,"questions.json"),"utf8"),questions:unknown=JSON.parse(sourceQuestions);
 if(!Array.isArray(questions))throw new Error();const selected=questions.filter((q):q is Record<string,unknown>=>record(q)&&q.split===split&&Array.isArray(q.evidence)&&q.evidence.length>0).slice(0,take);
 await writeFile(path.resolve(output),JSON.stringify({status:"started",attempts:[]}),{flag:"wx",mode:0o600});
 const temporary=await realpath(await mkdtemp(path.join(tmpdir(),"orbitcode-rag-agent-eval-"))),attempts:unknown[]=[],builds:unknown[]=[];
 try{
  for(const enabled of [false,true]){
   const directory=path.join(temporary,enabled?"retrieval":"baseline"),store=new LocalSettingsStore(directory),evaluationWorkspace=path.join(temporary,enabled?"retrieval-workspace":"baseline-workspace");
   await cp(path.join(corpusRoot,"corpus"),path.join(evaluationWorkspace,"corpus"),{recursive:true});
   await store.save(0,{schemaVersion:1,providers:[provider],workspaces:[{...workspace,rootPath:evaluationWorkspace,knowledge:{...workspace.knowledge,enabled,include:["corpus/**/*.md"],exclude:[],includeHistorical:false}}],mcpServers:[],defaultProviderId:provider.id,defaultWorkspaceId:workspace.id,maxIterations:8,maxRuntimeMinutes:3});
   if(enabled){const service=await knowledgeForWorkspace(store,workspace.id);await service.start(true);for(;;){const state=await service.status();if(state.operation?.state==="finished"){builds.push({group:"retrieval",report:state.operation.report});break;}if(state.operation?.state!=="running")throw new Error();await new Promise(resolve=>setTimeout(resolve,100));}}
   for(const question of selected)for(let repetition=1;repetition<=repetitions;repetition++){
    const started=Date.now(),prompt=String(question.query)+"\n请依据当前工作区材料回答并引用来源；证据不足请明确说明。";
    const conversationStore=new LocalConversationStore(path.join(directory,"conversations-v1")),conversation=await conversationStore.create({providerId:provider.id,workspaceId:workspace.id,mode:"plan"});
    const result=await new Promise<{exitCode:number|null;result:unknown}>((resolve)=>{
     const child=spawn(process.execPath,["--import","tsx","src/cli/main.ts","run","--stdin","--resume",conversation.summary.id,"--data-dir",directory,"--max-iterations","8","--timeout-ms","180000"],{stdio:["pipe","pipe","ignore"]});let text="";const timer=setTimeout(()=>child.kill("SIGTERM"),185000);child.stdout.on("data",chunk=>{text+=chunk.toString();if(text.length>4*1024*1024)child.kill();});child.once("error",()=>{clearTimeout(timer);resolve({exitCode:-1,result:null});});child.once("exit",exitCode=>{clearTimeout(timer);let result:unknown=null;try{result=JSON.parse(text.trim());}catch{}resolve({exitCode,result});});child.stdin.end(prompt);
    });
    let toolEvidence:unknown[]=[];
    if(record(result.result)&&typeof result.result.conversationId==="string"){try{const checkpoint=await new LocalConversationStore(path.join(directory,"conversations-v1")).load(result.result.conversationId);toolEvidence=checkpoint.displayMessages.flatMap(message=>(message.toolExecutions??[]).map(tool=>({name:tool.name,state:tool.state,result:tool.result})));}catch{toolEvidence=[{status:"checkpoint-unavailable"}];}}
    attempts.push({toolEvidence,questionId:question.id,group:enabled?"retrieval":"baseline",repetition,elapsedMs:Date.now()-started,...result,manualAssessment:{status:"pending",answerCorrect:null,citationSupported:null,taskPassed:null}});
    await writeFile(path.resolve(output),JSON.stringify({schemaVersion:1,questionSetHash:contentHash(sourceQuestions),split,corpus:"tests/fixtures/knowledge/corpus",providerId:provider.id,chatModel:provider.model,embeddingModel:workspace.knowledge.model,builds,questionCount:selected.length,repetitions,attempts},null,2),{mode:0o600});
   }
  }
  process.stdout.write(JSON.stringify({attempts:attempts.length,output:path.resolve(output),manualAssessment:"pending"})+"\n");
 }finally{await rm(temporary,{recursive:true,force:true});}
}
void main().catch(()=>{process.stderr.write("Agent 对照评估未完成；请检查显式隔离配置、输出路径和服务状态，已完成尝试保留在私密报告中。\n");process.exitCode=1;});
