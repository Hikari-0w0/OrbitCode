import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadProviderContext, resolveRuntimeProvider } from "@/runtime/config";
import { realSubAgentFixture, scrubCredential } from "./evals/sub-agent-real-fixture";
import { realWebSubAgentFixture } from "./evals/sub-agent-web-fixture";
import { assertTaskTiming } from "./evals/assert-task-timing";

async function main() {
  const args=process.argv.slice(2), option=(name:string)=>args.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3);
  const root=option("root"),transport=option("transport")??"cli";
  if(!args.includes("--allow-real-model")||!root||!["cli","web"].includes(transport))throw new Error("需要真实模型授权、新目录与合法transport。");
  const base=path.resolve(root);await mkdir(base,{mode:0o700});
  const context=await loadProviderContext(),source=resolveRuntimeProvider(context,context.defaultProviderId??context.providers[0].name);
  const results:{name:string;status:"passed"|"failed";root?:string;error?:string}[]=[];
  for(const scenario of ["pass","mismatch","token-reject"] as const){
    let fixture:Awaited<ReturnType<typeof realSubAgentFixture>>|Awaited<ReturnType<typeof realWebSubAgentFixture>>|undefined;
    const result:typeof results[number]={name:`${transport}-${scenario}`,status:"failed"};
    const heartbeat=setInterval(()=>console.log(JSON.stringify({event:"running",name:result.name})),30000);
    try{
      const limits={groupTokens:scenario==="token-reject"?1:1000000};
      fixture=transport==="web"?await realWebSubAgentFixture(base,result.name,source,{"out.txt":"BASE"},{serverMode:"start",limits}):await realSubAgentFixture(base,result.name,source,{"out.txt":"BASE"},false,limits);
      result.root=fixture.root;
      if(scenario==="token-reject")await fixture.run("只回复ACK，不使用工具。");
      else await fixture.run(`这是固定契约验收。只创建恰好1个defined后台子任务role=builder，start.task.output.files必须为[{"path":"out.txt","contains":"${scenario==="pass"?"ACTUAL_OUTPUT_20261021":"MUST_NOT_APPEAR"}"}]。子任务prompt：先读取out.txt，再用write_file将out.txt完整写成ACTUAL_OUTPUT_20261021，只修改这个文件，不运行命令，完成后简短回复。父只用agent start、wait、verify和status，等待终态后必须调用verify；不代做、不修改文件、不重跑、不更换契约。${scenario==="mismatch"?"这是故意不匹配的验收，verify应返回failed，请保留失败，不修复判据或文件。":"按真实验收结果回复。"}`,"delegate-only","defined");
      const tasks=await fixture.settle(),usage=await fixture.usage(),checkpoint=await fixture.checkpoint();
      await fixture.save("delivery-assessment.json",{scenario,tasks,usage,checkpoint});
      const budgets=usage.requestBudgets;assert.equal(budgets.length,1);assert.ok(budgets[0].tokens);assert.equal(budgets[0].tokens.reserved,0);
      if(scenario==="token-reject"){
        assert.equal(budgets[0].admittedAttempts,0);assert.ok(budgets[0].rejectedRequests>0);assert.equal(tasks.length,0);assert.equal(checkpoint.summary.lastStopReason,"model-error");
        assert.equal(await readFile(path.join(fixture.workspace,"out.txt"),"utf8"),"BASE");
      }else{
        assert.equal(tasks.length,1);const task=tasks[0];assertTaskTiming(task);
        assert.equal(task.admission?.requestBudget.tokenLimit,1000000);assert.equal(task.admission?.output?.files[0].contains,scenario==="pass"?"ACTUAL_OUTPUT_20261021":"MUST_NOT_APPEAR");
        assert.equal(task.acceptance?.status,scenario==="pass"?"passed":"failed");assert.equal(task.acceptance?.scope,"declared-file-checks-only");
        assert.equal(await readFile(path.join(fixture.workspace,"out.txt"),"utf8"),"ACTUAL_OUTPUT_20261021");
        assert.ok(task.state.status==="terminal"&&task.state.result.verification.status==="unverified");
        assert.ok(budgets[0].tokens.reported>0||budgets[0].tokens.unknown>0);
      }
      result.status="passed";
    }catch(error){result.error=scrubCredential(String(error),source);}
    finally{if(fixture)try{await fixture.close();}catch{result.status="failed";result.error="清理失败";}clearInterval(heartbeat);results.push(result);await writeFile(path.join(base,"results.json"),JSON.stringify(results,null,2));console.log(JSON.stringify(result));}
  }
  if(results.some(result=>result.status==="failed"))process.exitCode=1;
}
void main().catch(()=>{console.error("交付评测未完成，未输出原始异常或凭据。");process.exitCode=1;});
