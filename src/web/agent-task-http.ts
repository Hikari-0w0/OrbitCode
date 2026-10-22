import type { AgentRuntime } from "@/runtime/agent-runtime";
import { assertLocalRequest, LocalManagementError } from "./local-management-guard";
import { readPermissionJsonBody } from "./request-security";
import { record } from "@/runtime/skills/definition";
export async function agentTaskHttp(request:Request,conversationId:string,runtime:Pick<AgentRuntime,"taskScope"|"inspectAgents"|"tasks"|"usageFor"> & Partial<Pick<AgentRuntime,"readTaskReply">>,taskId?:string,action?:string):Promise<Response> {
  try {
    assertLocalRequest(request);
    const scope=await runtime.taskScope(conversationId);
    let output:unknown;
    if(action==="agents") { if(request.method!=="GET")throw new Error("仅允许 GET。"); output=await runtime.inspectAgents(conversationId); }
    else if(request.method==="GET") {
      if(action)throw new Error("控制操作需要 POST。");
      output=taskId?{task:runtime.tasks.get(scope,taskId)}:{usage:runtime.usageFor(scope),tasks:runtime.tasks.list(scope),notice:"任务只在当前运行时存活；关闭运行时会取消未完成任务，未保存结果可能丢失。"};
    } else if(request.method==="POST"&&taskId) {
      if(action==="decide")return Response.json({error:"人工审批已移除，工具按权限规则直接执行或拒绝。"},{status:410});
      const body:unknown=await readPermissionJsonBody(request);
      const allowed=action==="wait"?["timeoutMs"]:action==="result"?["offset","limit"]:[];
      if(!record(body)||Object.keys(body).some(k=>!allowed.includes(k)) || action==="wait" && body.timeoutMs!==undefined && (typeof body.timeoutMs!=="number" || !Number.isSafeInteger(body.timeoutMs) || body.timeoutMs<1 || body.timeoutMs>300000))throw new Error("任务操作参数无效。");
      if(action==="result") {
        if(!runtime.readTaskReply||body.offset!==undefined&&(typeof body.offset!=="number"||!Number.isSafeInteger(body.offset)||body.offset<0)||body.limit!==undefined&&(typeof body.limit!=="number"||!Number.isSafeInteger(body.limit)||body.limit<1||body.limit>4000))throw new Error("正文分页参数无效。");
        output=await runtime.readTaskReply(conversationId,taskId,typeof body.offset==="number"?body.offset:0,typeof body.limit==="number"?body.limit:4000,request.signal);
      }
      else if(action==="wait")output=await runtime.tasks.wait(scope,taskId,typeof body.timeoutMs==="number"?body.timeoutMs:30000,request.signal);
      else if(action==="detach"){runtime.tasks.detach(scope,taskId);output=runtime.tasks.get(scope,taskId);}
      else if(action==="cancel")output=await runtime.tasks.cancel(scope,taskId);
      else throw new Error("未知任务操作。");
    }else throw new Error("任务操作无效。");
    return Response.json(output,{headers:{"cache-control":"no-store"}});
  }catch(error){return Response.json({error:error instanceof LocalManagementError?error.message:"任务不存在、无权访问或参数无效。"},{status:error instanceof LocalManagementError?403:400});}
}
