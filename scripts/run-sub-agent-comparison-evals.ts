import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadProviderContext, resolveRuntimeProvider } from "@/runtime/config";
import { realSubAgentFixture, scrubCredential } from "./evals/sub-agent-real-fixture";

async function main(){
 const args=process.argv.slice(2),root=args.find(arg=>arg.startsWith("--root="))?.slice(7);
 if(!args.includes("--allow-real-model")||!root)throw new Error("需要真实模型授权与新目录。");
 const base=path.resolve(root);await mkdir(base,{mode:0o700});
 const context=await loadProviderContext(),source=resolveRuntimeProvider(context,context.defaultProviderId??context.providers[0].name);
 const files={"alpha.ts":"// 同一固定任务输入\n"+"// alpha实现背景\n".repeat(1200)+"export const alphaCode = 'ALPHA_729_REAL';\n","beta.ts":"// 同一固定任务输入\n"+"// beta实现背景\n".repeat(1200)+"export const betaCode = 'BETA_384_REAL';\n"};
 const results:{name:string;status:"passed"|"failed";root?:string;elapsedMs?:number;usage?:unknown;error?:string}[]=[];
 for(let round=1;round<=3;round++)for(const arm of (round%2?["single","delegated"]:["delegated","single"]) as ("single"|"delegated")[]){
  const result:typeof results[number]={name:`${arm}-${round}`,status:"failed"};let f:Awaited<ReturnType<typeof realSubAgentFixture>>|undefined;
  const heartbeat=setInterval(()=>console.log(JSON.stringify({event:"running",name:result.name})),30000);
  try{
   f=await realSubAgentFixture(base,result.name,source,files,false,{groupTokens:2000000});result.root=f.root;
   const goal="读取alpha.ts和beta.ts，分别报告导出常量alphaCode和betaCode的精确字符串值。必须来自实际文件读取，不猜测、不修改文件、不执行命令。";
   const prompt=arm==="single"?goal+"由主Agent直接完成，不使用agent或Skill。":goal+"父只委派、等待和汇总。创建恰好两个defined后台reader子任务，每个只负责一个文件；先创建两个再等待，不增加任务，不重试，父不代做。";
   const started=performance.now();await f.run(prompt,arm==="single"?"collaborate":"delegate-only",arm==="single"?undefined:"defined");const tasks=await f.settle();result.elapsedMs=Math.round(performance.now()-started);
   const cp=await f.checkpoint(),reply=cp.context.messages.findLast(message=>message.kind==="assistant");
   const usage=await f.usage();result.usage=usage;
   await f.save("comparison-assessment.json",{arm,round,elapsedMs:result.elapsedMs,usage,tasks,checkpoint:cp});
   assert.ok(reply?.kind==="assistant"&&reply.content.includes("ALPHA_729_REAL")&&reply.content.includes("BETA_384_REAL"));
   assert.equal(tasks.length,arm==="single"?0:2);assert.ok(f.calls.every(item=>arm==="single"?item.call.name!=="agent":item.child||item.call.name==="agent"));
   for(const [file,content]of Object.entries(files))assert.equal(await readFile(path.join(f.workspace,file),"utf8"),content);
   const observed=f.calls.filter(item=>item.call.name==="read_file").map(item=>JSON.parse(item.call.argumentsJson).path);
   assert.ok(observed.includes("alpha.ts")&&observed.includes("beta.ts"));result.status="passed";
  }catch(error){result.error=scrubCredential(String(error),source);}
  finally{if(f)try{await f.close();}catch{result.status="failed";result.error="清理失败";}clearInterval(heartbeat);results.push(result);await writeFile(path.join(base,"results.json"),JSON.stringify(results,null,2));console.log(JSON.stringify({name:result.name,status:result.status,elapsedMs:result.elapsedMs,error:result.error}));}
 }
 if(results.some(result=>result.status==="failed"))process.exitCode=1;
}
void main().catch(()=>{console.error("收益对照未完成，未输出原始异常或凭据。");process.exitCode=1;});
