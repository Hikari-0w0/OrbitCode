import type { AgentSession } from "@/core/agent-loop";
import type { AgentMode, AgentEvent } from "@/core/agent-events";
import type { ChildExecutionResult, ChildToolFailure } from "@/core/sub-agents/types";
import type { ModelUsageSummary } from "@/models/usage-tracker";
import { runAgentTurn } from "@/runtime/run-agent-turn";
import type { RunLogOptions } from "@/runtime/agent-run-tracker";
import { targetFailureReason } from "@/tools/target-failure-reason";
import { ChildHandoff } from "./handoff";
export async function runChildExecution(input:{id:string;agent:AgentSession;prompt:string;mode:AgentMode;signal:AbortSignal;deadlineAt:number;usage:()=>ModelUsageSummary;runLog:RunLogOptions;handoff?:ChildHandoff;saveReply?:(reply:string,handoff:import("@/core/sub-agents/types").ChildExecutionHandoff)=>Promise<import("@/core/sub-agents/types").ChildReplyStorage>;observe?:(event:AgentEvent)=>void}):Promise<ChildExecutionResult> {
  let terminal:Extract<AgentEvent,{type:"stopped"}>|undefined;
  let sideEffect:ChildExecutionResult["sideEffect"]="none";
  const failures:ChildToolFailure[]=[];
  let failureCount=0;
  let evidenceLog:"saved"|"failed"="saved";
  const handoff = input.handoff ?? new ChildHandoff();
  const prompt = `以下是当前独立子 Agent 唯一需要执行的子任务。此前消息是父会话背景，其中的父级委派和等待步骤已由父处理。按当前子任务交付，不执行旧轮次的回复格式或编排。\n<orbitcode_current_subtask>\n${input.prompt}\n</orbitcode_current_subtask>`;
  for await(const item of runAgentTurn({agent:input.agent,input:prompt,mode:input.mode,modeTurn:1,signal:input.signal,maxRuntimeMs:Math.max(1,input.deadlineAt-Date.now()),runLog:{...input.runLog,modelUsage:input.usage}})) {
    if(item.type==="warning"&&item.kind==="run-log")evidenceLog="failed";
    const event=item.type==="agent"?item.event:item.type==="finished"?item.stopped:undefined;
    if(!event)continue;
    handoff.record(event);
    input.observe?.(event);
    if(event.type==="tool-started" && sideEffect==="none")sideEffect="possible";
    if(event.type==="tool-result") { if(event.result.sideEffect==="applied")sideEffect="applied"; if(!event.result.ok)failureCount++; if(!event.result.ok && failures.length<32) { const output=event.result.output; failures.push({tool:event.name.slice(0,160),kind:event.result.error.kind,callId:event.callId,iteration:event.iteration,...(targetFailureReason(event.result)?{targetFailureReason:targetFailureReason(event.result)}:{}),...(output && typeof output==="object" && "timedOut" in output && typeof output.timedOut==="boolean"?{timedOut:output.timedOut}:{}),...(output && typeof output==="object" && "exitCode" in output && (typeof output.exitCode==="number" || output.exitCode===null)?{exitCode:output.exitCode}:{})}); } }
    if(event.type==="stopped")terminal=event;
  }
  const reply=terminal?.finalMessage?.content??"";
  const handoffFacts = handoff.snapshot();
  let replyStorage: import("@/core/sub-agents/types").ChildReplyStorage | undefined;
  if(input.saveReply) { try { replyStorage=await input.saveReply(reply,handoffFacts); } catch { replyStorage={status:"unavailable",reason:"storage"}; } }
  const bounded=new TextDecoder().decode(Buffer.from(reply).subarray(0,4096),{stream:true});
  const verification=terminal?.verification;
  const checks=verification?.checks.slice(0,16).map(check=>({...check,criterion:check.criterion.slice(0,256),evidenceCallIds:check.evidenceCallIds.slice(0,16)}))??[];
  const blockers=verification?.blockers.slice(0,8).map(item=>item.slice(0,256))??[];
  return {taskId:input.id,stopReason:terminal?.reason??"agent-error",finalReply:bounded,replyTruncated:bounded!==reply,...(replyStorage?{replyStorage}:{}),failureCount,handoff:handoffFacts,failures,sideEffect:sideEffect==="applied"?sideEffect:terminal?.sideEffect??sideEffect,verification:{status:verification?.status??"unverified",checks,blockers},usage:input.usage(),cleanup:"complete",truncated:Boolean(handoffFacts.reads?.omitted)||handoffFacts.fileWrites.omitted>0||handoffFacts.commandCalls.omitted>0||bounded!==reply||failureCount>failures.length||Boolean(verification&&(verification.checks.length>16||verification.blockers.length>8||verification.checks.some(check=>check.criterion.length>256||check.evidenceCallIds.length>16)||verification.blockers.some(blocker=>blocker.length>256))),evidenceRunId:input.id,evidenceLog};
}
