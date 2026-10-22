import { parseChildOutputContract } from "@/core/sub-agents/output-contract";
import type { DelegationKind } from "@/core/sub-agents/parent-execution";
import type { AgentStart, AgentToolRequest } from "@/core/sub-agents/types";
import { defineTool } from "./registry";
import { record } from "@/runtime/skills/definition";
import { toolFailure, type ToolExecutionContext, type ToolExecutionResult, type ToolInputSchema } from "./types";
export function parseAgentRequest(v:unknown):AgentToolRequest {
  if(!record(v))throw new Error("Agent 参数必须是对象。");
  const op=v.operation;
  if(op==="start") {
    if(Object.keys(v).some(k=>!["operation","task"].includes(k))||!record(v.task))throw new Error("start 参数无效。");
    const t=v.task;
    if(Object.keys(t).some(k=>!["kind","role","prompt","background","output"].includes(k))||typeof t.prompt!=="string"||!t.prompt.trim()||Buffer.byteLength(t.prompt)>16384||t.role!==undefined&&(typeof t.role!=="string"||!/^[a-z][a-z0-9-]{0,63}$/.test(t.role))||t.background!==undefined&&typeof t.background!=="boolean")throw new Error("子任务参数无效。");
    let task:AgentStart;
    if(t.kind==="defined" && typeof t.role==="string")task={kind:"defined",role:t.role,prompt:t.prompt,background:t.background===true};
    else if(t.kind==="fork" && t.background!==false)task={kind:"fork",...(typeof t.role==="string"?{role:t.role}:{}),prompt:t.prompt,background:true};
    else throw new Error("定义式必须选角色，Fork 固定后台。");
    return {operation:"start",task:{...task,...(t.output===undefined?{}:{output:parseChildOutputContract(t.output)})}};
  }
  if(op!=="status"&&op!=="wait"&&op!=="cancel"&&op!=="verify"&&op!=="result")throw new Error("未知 Agent 操作。");
  if(Object.keys(v).some(k=>!["operation","taskId",...(op==="wait"?["timeoutMs"]:op==="result"?["offset","limit"]:[])].includes(k)))throw new Error("操作含未知字段。");
  if(v.taskId!==undefined&&(typeof v.taskId!=="string"||v.taskId.length>128||!v.taskId.length))throw new Error("任务 ID 无效。");
  if(op==="status")return {operation:op,...(typeof v.taskId==="string"?{taskId:v.taskId}:{})};
  if(typeof v.taskId!=="string")throw new Error("缺少任务 ID。");
  if(op==="result") {
    if(v.offset!==undefined&&(typeof v.offset!=="number"||!Number.isSafeInteger(v.offset)||v.offset<0)||v.limit!==undefined&&(typeof v.limit!=="number"||!Number.isSafeInteger(v.limit)||v.limit<1||v.limit>4000))throw new Error("正文分页参数无效，limit 为 1–4000 个字符。");
    return {operation:op,taskId:v.taskId,...(typeof v.offset==="number"?{offset:v.offset}:{}),...(typeof v.limit==="number"?{limit:v.limit}:{})};
  }
  if(op==="cancel"||op==="verify")return {operation:op,taskId:v.taskId};
  if(v.timeoutMs!==undefined&&(typeof v.timeoutMs!=="number"||!Number.isSafeInteger(v.timeoutMs)||v.timeoutMs<1||v.timeoutMs>300000))throw new Error("等待时间无效。");
  return {operation:op,taskId:v.taskId,...(typeof v.timeoutMs==="number"?{timeoutMs:v.timeoutMs}:{})};
}
export function createAgentTool(execute:(request:AgentToolRequest,context:ToolExecutionContext)=>Promise<ToolExecutionResult>, requiredKind?: DelegationKind) {
  const inputSchema:ToolInputSchema<AgentToolRequest>={jsonSchema:{type:"object",properties:{operation:{type:"string",enum:["start","status","wait","cancel","result","verify"]},task:{type:"object",properties:{kind:{type:"string",enum:requiredKind?[requiredKind]:["defined","fork"]},role:{type:"string"},prompt:{type:"string"},background:{type:"boolean"},output:{type:"object",properties:{files:{type:"array",minItems:1,maxItems:8,items:{type:"object",properties:{path:{type:"string",maxLength:256},contains:{type:"string",maxLength:256},sha256:{type:"string",pattern:"^[a-f0-9]{64}$"}},required:["path"],additionalProperties:false}}},required:["files"],additionalProperties:false}},required:["kind","prompt"],additionalProperties:false},taskId:{type:"string"},timeoutMs:{type:"integer",minimum:1,maximum:300000},offset:{type:"integer",minimum:0},limit:{type:"integer",minimum:1,maximum:4000}},required:["operation"],additionalProperties:false},parse(value){try{const request=parseAgentRequest(value);if(request.operation==="start"&&requiredKind&&request.task.kind!==requiredKind)throw new Error(`本轮只允许 ${requiredKind} 委派；请按用户选定类型重新调用，原调用未创建任务。`);return {ok:true,value:request};}catch(error){return {ok:false,issues:[{path:"$",message:error instanceof Error?error.message:"参数无效。"}]};}}};
  return defineTool({name:"agent",description:"委派独立子任务。start 立即返回 ID；只读子任务可并行，具备修改能力的子任务在共享工作区独占执行，父级文件读写须等待它结束；agent 状态/等待/取消保持可用。defined 选择角色，fork 继承完整历史且固定后台。前台随后 wait；status 查看、cancel 取消。主 Agent 与子任务均不进行人工审批，操作按当前工具能力、Plan/Do、工作区边界及拒绝规则直接执行或拒绝。结果自动投递；replyTruncated=true且replyStorage=saved时，用result按taskId、offset、limit分页读取模型完整正文，不必重新探索。可在start.task.output.files声明文件路径与可选contains字面量/sha256要求；终态后verify按当前权限独立重读检查，只验证声明的文件条件，不代表整个自然语言任务正确。最终回复不等于验收通过。"+(requiredKind?` 本轮用户限定所有新任务类型为 ${requiredKind}，其他类型会被拒绝。`:""),inputSchema,mutability:"read-only",scheduling:"barrier",budget:"parent-run",permission:{targetKind:"context",resolve:()=>({kind:"context",reference:"agent"})},async execute(request,context){try{if(request.operation==="start"&&requiredKind&&request.task.kind!==requiredKind)return toolFailure("invalid-arguments",`本轮只允许 ${requiredKind} 委派；原调用未创建任务。`,{retryable:true});return await execute(request,context);}catch(error){return toolFailure(context.signal.aborted?"cancelled":error instanceof Error&&error.message.includes("上限")?"limit-exceeded":"invalid-arguments",error instanceof Error?error.message:"委派失败。");}}});
}
