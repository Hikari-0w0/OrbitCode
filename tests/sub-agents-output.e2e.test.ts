import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { runtimeFixture } from "./helpers/runtime-fixture";
import { call, say } from "./helpers/skill-fixture";

test("真实Runtime冻结产物契约，独立验收不信任子自述，文件变化后复验失败并保存父检查点", async () => {
  let parents=0, taskId="";
  const f=await runtimeFixture(request=>{
    const body=request.body;
    if(JSON.stringify(body).includes("orbitcode_child_role"))return say("我声明全部验收成功");
    parents++;
    if(parents===1)return call("agent",{operation:"start",task:{kind:"defined",role:"explorer",prompt:"仅回复，不读取文件",background:true,output:{files:[{path:"out.txt",contains:"ACTUAL"}]}}},"start");
    const messages=typeof body==="object"&&body!==null&&"messages"in body?body.messages:undefined;
    if(Array.isArray(messages))for(const message of messages)if(message.role==="tool"&&typeof message.content==="string"){
      const value=JSON.parse(message.content);if(typeof value.output?.taskId==="string")taskId=value.output.taskId;
    }
    if(parents===2)return call("agent",{operation:"wait",taskId,timeoutMs:3000},"wait");
    if(parents===3||parents===5)return call("agent",{operation:"verify",taskId},`verify-${parents}`);
    return say("验收以结构化结果为准");
  },{subAgentLimits:{groupTokens:200000}});
  try{
    await f.runtime.memory.setEnabled(false);await f.controller.handleLine("/delegation delegate-only");
    await writeFile(path.join(f.root,"out.txt"),"ACTUAL");await f.controller.handleLine("创建并验收");
    const scope=await f.runtime.taskScope((await f.checkpoint()).summary.id), first=f.runtime.tasks.get(scope,taskId);
    assert.equal(first.acceptance?.status,"passed");assert.equal(first.acceptance?.scope,"declared-file-checks-only");
    assert.ok(first.state.status==="terminal"&&first.state.result.verification.status==="unverified");
    assert.equal(first.admission?.output?.files[0].contains,"ACTUAL");
    await writeFile(path.join(f.root,"out.txt"),"CHANGED");await f.controller.handleLine("重新验收");
    const second=f.runtime.tasks.get(scope,taskId);assert.equal(second.acceptance?.status,"failed");
    const cp=await f.checkpoint();assert.ok(cp.context.messages.some(message=>message.kind==="tool-result"&&message.payload.storage==="inline"&&message.payload.content.includes('"scope":"declared-file-checks-only"')));
    const tokens=f.runtime.usageFor(scope).requestBudgets.flatMap(group=>group.tokens?[group.tokens]:[]);
    assert.ok(tokens.length>0);assert.ok(tokens.every(token=>token.reserved===0));
  }finally{await f.close();}
});
