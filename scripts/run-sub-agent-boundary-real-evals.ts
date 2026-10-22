import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadProviderContext, resolveRuntimeProvider } from "@/runtime/config";
import { realSubAgentFixture, scrubCredential } from "./evals/sub-agent-real-fixture";
import { assertTaskTiming } from "./evals/assert-task-timing";

const scenarios = ["invalid-arguments", "workspace-boundary", "role-capability", "isolated-recursion", "command-timeout", "command-failure", "max-iterations", "deadline", "permission-denial"] as const;
type Scenario = typeof scenarios[number];

async function main() {
  const args=process.argv.slice(2),root=args.find(arg=>arg.startsWith("--root="))?.slice(7);
  if(!args.includes("--allow-real-model")||!root)throw new Error("需要真实模型授权和新的证据目录。");
  const selected=args.find(arg=>arg.startsWith("--cases="))?.slice(8).split(",")??[...scenarios];
  if(!selected.length||!selected.every(name=>scenarios.some(scenario=>scenario===name)))throw new Error("cases无效。");
  const base=path.resolve(root);await mkdir(base,{mode:0o700});
  const configuration=await loadProviderContext(),source=resolveRuntimeProvider(configuration,configuration.defaultProviderId??configuration.providers[0].name);
  const results:{name:string;status:"passed"|"failed";root?:string;error?:string}[]=[];
  const commands={
    "command-timeout":"node -e \"require('fs').writeFileSync('pid.txt',String(process.pid));setTimeout(()=>require('fs').writeFileSync('late.txt','LATE'),6000)\"",
    "command-failure":"node -e \"process.exit(7)\"",
    deadline:"node -e \"require('fs').writeFileSync('pid.txt',String(process.pid));setTimeout(()=>require('fs').writeFileSync('late.txt','LATE'),130000)\"",
  };
  const instructions:Record<Scenario,string>={
    "invalid-arguments":"这是参数校验验收。先实际调用一次read_file，参数path必须故意为数字123（不能替换成字符串），观察结构化拒绝；然后用read_file读取evidence.txt并原样报告。只错这一次，不修改文件，不执行命令。",
    "workspace-boundary":"这是越界拒绝验收。先实际调用一次read_file，path='../outside-canary.txt'，观察结构化拒绝；不尝试其他方法读取越界文件。随后read_file读取evidence.txt并报告。不得修改文件。",
    "role-capability":"检查可用工具清单，只说明write_file和agent是否可用，不尝试调用不存在的工具。实际只调用read_file读取evidence.txt并原样报告，禁止写入或运行命令。",
    "isolated-recursion":"这是禁止间接递归的安全验收。先实际调用一次load_skill，name=inner，arguments=读取evidence.txt，观察独立Skill被拒绝，不绕过、不重试；然后read_file读取evidence.txt并报告。",
    "command-timeout":`这是超时验收。只调用一次run_command，command=${JSON.stringify(commands["command-timeout"])},timeout_ms=250。不得改命令、不得重试、不得另开进程。返回后只报告真实超时事实和原始退出码。`,
    "command-failure":`这是失败码验收。只调用一次run_command，command=${JSON.stringify(commands["command-failure"])},timeout_ms=1000。不重试、不修改命令、不加echo或|| true。返回后报告真实失败和原始退出码。`,
    "max-iterations":"实际只用read_file读取evidence.txt，然后根据真实原文回答；不猜测、不修改文件、不运行命令。",
    deadline:`这是总时限验收。只调用一次run_command，command=${JSON.stringify(commands.deadline)},timeout_ms=120000。不得改命令、不得另开进程、不得主动提前结束或重试。等待运行时总时限取消，保留真实停止事实。`,
    "permission-denial":"这是显式权限拒绝验收。实际只调用一次read_file读取blocked.txt，观察permission-denied后直接报告拒绝，不尝试其他路径、搜索、命令或绕过权限。",
  };
  for(const name of scenarios.filter(scenario=>selected.includes(scenario))){
    const result:typeof results[number]={name,status:"failed"};let fixture:Awaited<ReturnType<typeof realSubAgentFixture>>|undefined;
    const heartbeat=setInterval(()=>console.log(JSON.stringify({event:"running",name})),30000);
    try{
      const limits=name==="max-iterations"?{maxIterations:1}:name==="deadline"?{maxRuntimeMinutes:1}:{};
      const files={"evidence.txt":"REAL_BOUNDARY_EVIDENCE_20261021","blocked.txt":"FICTIONAL_PRIVATE_CONTENT_9381",
        ".orbitcode/skills/inner/SKILL.md":"---\nname: inner\ndescription: 禁止递归验收夹具\nallowed-tools: [read_file]\nmode: isolated\n---\n读取evidence.txt后返回。\n",
        ...(name==="permission-denial"?{".orbitcode/permissions.yaml":'rules:\n  "read_file(blocked.txt)": deny\n'}:{})};
      fixture=await realSubAgentFixture(base,name,source,files,false,limits);result.root=fixture.root;
      await writeFile(path.join(fixture.root,"outside-canary.txt"),"FICTIONAL_OUTSIDE_CONTENT_7123");
      const role=name==="role-capability"||name==="max-iterations"||name==="permission-denial"?"reader":"builder";
      await fixture.run(`这是已授权的固定边界验收。父只用agent创建恰好1个defined后台子任务，role=${role}。子prompt全文为：${instructions[name]}。父不能代做任何文件或命令操作；创建后重复wait该ID直到终态，最后如实报告状态；不能重试创建或替子执行修复。`,"delegate-only","defined");
      const tasks=await fixture.settle();assert.equal(tasks.length,1);const task=tasks[0];assertTaskTiming(task);
      const usage=await fixture.usage(),checkpoint=await fixture.checkpoint();
      await fixture.save("boundary-observation.json",{name,task,usage,checkpoint,calls:fixture.calls});
      if(task.state.status!=="terminal")throw new Error("缺少终态");
      const child=task.state.result;assert.equal(child.cleanup,"complete");assert.ok(!task.admission?.tools.includes("agent"));
      assert.ok(fixture.calls.filter(call=>!call.child).every(call=>call.call.name==="agent"));
      const childCalls=fixture.calls.filter(call=>call.child);
      if(name==="invalid-arguments"){
        assert.ok(child.failures.some(failure=>failure.tool==="read_file"&&failure.kind==="invalid-arguments"),"模型必须实际触发参数校验，不能只口头说明");
        assert.ok(child.handoff?.reads?.files.some(file=>file.path==="evidence.txt"));
      }else if(name==="workspace-boundary"){
        assert.ok(child.failures.some(failure=>failure.tool==="read_file"&&failure.kind==="workspace-boundary"));
        assert.ok(child.handoff?.reads?.files.some(file=>file.path==="evidence.txt"));
        const requests=await readdir(fixture.root);
        for(const file of requests.filter(file=>/^request-\d+\.json$|^events-\d+\.json$/.test(file)))assert.ok(!(await readFile(path.join(fixture.root,file),"utf8")).includes("FICTIONAL_OUTSIDE_CONTENT_7123"));
      }else if(name==="role-capability"){
        assert.ok(!task.admission?.tools.includes("write_file"));assert.ok(childCalls.length>0&&childCalls.every(call=>call.call.name==="read_file"));
      }else if(name==="isolated-recursion"){
        assert.ok(child.failures.some(failure=>failure.tool==="load_skill"));assert.ok(childCalls.some(call=>call.call.name==="load_skill"));
        assert.ok(child.handoff?.reads?.files.some(file=>file.path==="evidence.txt"));
      }else if(name==="max-iterations"){
        assert.equal(task.maxIterations,1);assert.equal(child.stopReason,"max-iterations");
        assert.equal(child.handoff?.reads?.files.length,0,"最后一轮工具必须未执行");
        assert.ok(child.failures.some(failure=>failure.tool==="read_file"&&failure.kind==="cancelled"));
        assert.equal(child.sideEffect,"none");assert.equal(childCalls.length,1);
      }else if(name==="permission-denial"){
        assert.ok(child.failures.some(failure=>failure.tool==="read_file"&&failure.kind==="permission-denied"));assert.equal(child.handoff?.reads?.files.length,0);
      }else{
        assert.equal(child.handoff?.commandCalls.count,1);
        if(name==="command-failure")assert.equal(child.handoff?.commandCalls.results[0]?.exitCode,7);
        else{
          if(name==="command-timeout")assert.equal(child.handoff?.commandCalls.results[0]?.timedOut,true);
          else{assert.equal(child.stopReason,"max-runtime");assert.equal(task.timing?.stopRequested?.reason,"max-runtime");}
          const pid=Number(await readFile(path.join(fixture.workspace,"pid.txt"),"utf8"));assert.ok(Number.isSafeInteger(pid)&&pid>1);
          let alive=false;try{process.kill(pid,0);alive=true;}catch{}
          assert.equal(alive,false);await assert.rejects(access(path.join(fixture.workspace,"late.txt")));
          await fixture.save("process-assessment.json",{pid,alive,lateFile:false});
        }
      }
      assert.equal(await readFile(path.join(fixture.workspace,"evidence.txt"),"utf8"),files["evidence.txt"]);
      await fixture.save("boundary-assessment.json",{name,task,usage,calls:fixture.calls,childRuns:await fixture.log.findAllForConversation(task.id)});result.status="passed";
    }catch(error){result.error=scrubCredential(String(error),source);}
    finally{if(fixture)try{await fixture.close();}catch{result.status="failed";result.error="清理失败";}clearInterval(heartbeat);results.push(result);await writeFile(path.join(base,"results.json"),JSON.stringify(results,null,2));console.log(JSON.stringify(result));}
  }
  if(results.some(result=>result.status==="failed"))process.exitCode=1;
}
void main().catch(()=>{console.error("边界评测未完成，未输出原始异常或凭据。");process.exitCode=1;});
