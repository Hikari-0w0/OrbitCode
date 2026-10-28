import {ChildHandoff} from "@/runtime/child-execution/handoff";
import { createChildTaskPlan } from "@/runtime/child-execution/task-plan";
import type { ModelRequestBudget } from "@/runtime/child-execution/request-budget";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentMode } from "@/core/agent-events";
import type { ContextManager } from "@/core/context/context-manager";
import type { ContextStore } from "@/core/context/types";
import type { ActivatedSkill } from "@/core/skills/types";
import type { OptionalPromptContext, PromptEnvironment } from "@/core/system-prompt/types";
import type { TaskScope, SubAgentLimits, TaskView } from "@/core/sub-agents/types";
import type { ChatProvider } from "@/models/provider";
import type { ResolvedProviderConfig } from "@/models/config";
import type { WorkspaceBoundary } from "@/tools/types";
import type { CommandSandbox } from "@/tools/command-sandbox";
import type { RegisteredTool } from "@/tools/registry";
import { successfulToolResult } from "@/tools/registry";
import { createAgentTool } from "@/tools/agent";
import { ChildToolPolicy } from "@/tools/child-tool-policy";
import { TaskPreparationError } from "@/runtime/task-transitions";
import { LocalContextStore } from "@/lib/local-context-store";
import type { BackgroundTaskManager } from "@/runtime/background-task-manager";
import { createChildPermissions } from "@/runtime/child-permissions";
import type { PermissionMode, PermissionRule } from "@/core/permissions/types";
import type { SkillCatalog } from "@/runtime/skills/catalog";
import type { RunLogOptions } from "@/runtime/agent-run-tracker";
import { prepareChildContext } from "@/runtime/child-execution/context-preparation";
import { createChildSession } from "@/runtime/child-execution/session-factory";
import { runChildExecution } from "@/runtime/child-execution/runner";
import type { WorkspaceExecutionCoordinator } from "@/runtime/workspace-execution-coordinator";
import type { PermissionGateway } from "@/tools/permission-gateway";
import type { AgentCatalog } from "./catalog";
import { childInstructions } from "./child-instructions";
import { assessChildOutput } from "@/runtime/child-execution/output-verifier";
export function createDelegationTool(input:{
  requestBudget: ModelRequestBudget;
  toolFailurePolicy?: import("@/core/tool-failure-budget").ToolFailurePolicy;
  verifyRead?: (path: string, context: import("@/tools/types").ToolExecutionContext) => Promise<import("@/tools/types").ToolExecutionResult>;
  parentExecution?: import("@/core/sub-agents/parent-execution").ParentExecutionContract;
  childResults: import("@/lib/child-result-store").ChildResultStore;
  readMemory?: import("@/tools/read-memory").MemoryContentReader;
  tasks:BackgroundTaskManager;limits:SubAgentLimits;scope:TaskScope;turnId:string;workspace:WorkspaceBoundary;contextManager:ContextManager;parentStore:ContextStore;
  currentTools?:()=>Promise<ReadonlySet<string>>;
  toolDescriptors?:()=>readonly import("@/tools/registry").ToolDescriptor[];
  catalog:(signal:AbortSignal)=>Promise<AgentCatalog>;skills:SkillCatalog;active:()=>readonly ActivatedSkill[];parentTools:()=>ReadonlySet<string>;
  modelIds:ReadonlySet<string>;parentConfig:ResolvedProviderConfig;resolveConfig:(id:string)=>ResolvedProviderConfig;provider:(config:ResolvedProviderConfig)=>ChatProvider;
  parentIterations:number;parentRuntimeMs:number;mode:AgentMode;parentMode:PermissionMode;rules:readonly PermissionRule[];currentPermissions:()=>Promise<{mode:PermissionMode;rules:readonly PermissionRule[];agentMode?:AgentMode}>;
  sandbox:CommandSandbox;optional:OptionalPromptContext;environment:PromptEnvironment;writes:WorkspaceExecutionCoordinator;runLog:RunLogOptions;
  initialize:(gateway:PermissionGateway,signal:AbortSignal,deadlineAt:number,leases:{release():Promise<void>}[])=>Promise<readonly RegisteredTool[]>;
}) {
  return createAgentTool(async(request,execution)=>{
    if(request.operation==="verify") {
      const task=input.tasks.get(input.scope,request.taskId);
      if(task.state.status!=="terminal"||!task.admission?.output)throw new Error("只能验收已结束且声明产物的任务。");
      const read=input.verifyRead;
      if(!read)throw new Error("当前入口未配置独立文件验收。");
      const contract=task.admission.output;
      const lease=await input.writes.acquireTask(input.workspace.root,"read-only",execution.signal);
      let assessment:Awaited<ReturnType<typeof assessChildOutput>>;
      try{assessment=await lease.run(()=>assessChildOutput(contract,path=>read(path,execution)));}
      finally{lease.release("complete");}
      input.tasks.recordAcceptance(input.scope,task.id,assessment);
      return successfulToolResult({taskId:task.id,acceptance:assessment},"none");
    }
    if(request.operation==="result") return successfulToolResult(await input.childResults.read(input.scope,request.taskId,request.offset??0,request.limit??4000,execution.signal),"none");
    if(request.operation==="status") {
      const tasks=request.taskId?[input.tasks.get(input.scope,request.taskId)]:input.tasks.list(input.scope);
      return successfulToolResult({tasks:tasks.map(task=>({id:task.id,kind:task.kind,role:task.role??null,state:task.state.status,workspaceAccess:task.workspaceAccess??null,background:task.background,deadlineAt:task.deadlineAt,delivery:task.delivery.status,
        ...(task.acceptance?{acceptance:{status:task.acceptance.status,scope:task.acceptance.scope,checkedAt:task.acceptance.checkedAt}}:{}),...(task.timing?{timing:{current:task.timing.current,elapsedMs:task.timing.elapsedMs,stopRequested:task.timing.stopRequested??null,stopLatencyMs:task.timing.stopLatencyMs??null}}:{})}))},"none");
    }
    if(request.operation==="cancel") { const task=await input.tasks.cancel(input.scope,request.taskId);return successfulToolResult({id:task.id,state:task.state.status},"none"); }
    if(request.operation==="wait") { const result=await input.tasks.wait(input.scope,request.taskId,Math.max(1,Math.min(request.timeoutMs??input.limits.waitSeconds*1000,execution.deadlineMs-Date.now())),execution.signal);return successfulToolResult({id:result.task.id,wait:result.reason,state:result.task.state.status,stopReason:result.task.state.status==="terminal"?result.task.state.result.stopReason:null},"none"); }
    const existing=input.tasks.created(input.scope,input.turnId,execution.callId??"invalid",request.task);
    if(existing)return admissionResult(existing);
    const catalog=request.task.role?await input.catalog(execution.signal):undefined;
    if(request.task.role&&!catalog?.complete)throw new Error("角色目录存在诊断，修复后再委派。");
    const role=request.task.role?catalog?.entries.get(request.task.role)?.role:undefined;
    if(request.task.role&&!role)throw new Error("找不到指定角色。");
    const config=role&&role.model!=="inherit"?input.resolveConfig(role.model):input.parentConfig;
    const parentTools=input.parentTools();
    const plan=createChildTaskPlan({task:request.task,requestBudget:input.requestBudget,role,config,workspace:input.workspace,parentTools,descriptors:input.toolDescriptors?.()??[],
      history:request.task.kind==="fork"?input.contextManager.delegationSnapshot():[],activeSkills:request.task.kind==="fork"?input.active():[],
      limits:input.limits,parentIterations:input.parentIterations,parentRuntimeMs:input.parentRuntimeMs,mode:input.mode,parentPermissionMode:input.parentMode,
      rules:input.rules,optional:input.optional,environment:input.environment});
    const tools=new Set(plan.specification.tools);
    const view=await input.tasks.start({scope:input.scope,turnId:input.turnId,callId:execution.callId??"invalid",specification:plan.specification,signal:execution.signal,prepare:async(contract,taskSignal)=>{
      const {taskId:id,deadlineAt,specification}=contract;
      const {task,limits:{maxIterations},workspace:{access:workspaceAccess}}=specification;
      const root=await mkdtemp(path.join(tmpdir(),"orbitcode-agent-"));
      const store=new LocalContextStore(root);
      const permissions=createChildPermissions({workspace:input.workspace,mode:specification.mode,parentMode:specification.permissions.parentMode,roleMode:specification.permissions.roleMode,rules:plan.rules,current:input.currentPermissions});
      const handoff=new ChildHandoff();
      const leases:{release():Promise<void>}[]=[];
      let child:Awaited<ReturnType<typeof createChildSession>>|undefined;
      let closing:Promise<void>|undefined;
      let workspaceLease:import("@/runtime/workspace-execution-coordinator").TaskWorkspaceLease|undefined;
      const close=()=>closing??=Promise.resolve().then(async()=>{
        // 先停执行器，再释放权限和租约，最后删除其上下文目录。
        const childResults=await Promise.allSettled([child?.close()]);
        const resourceResults=await Promise.allSettled(leases.map(l=>l.release()));
        const directoryResults=await Promise.allSettled([rm(root,{recursive:true,force:true})]);
        const failed=[...childResults,...resourceResults,...directoryResults].some(r=>r.status==="rejected");
        workspaceLease?.release(failed?"failed":"complete");
        if(failed)throw new Error("子资源清理失败。");
      });
      try {
        const {history,referenceAliases,manifest}=await prepareChildContext({contract,messages:plan.history,parentStore:input.parentStore,childStore:store,signal:taskSignal});
        return {context:manifest,close,acquire:async(signal:AbortSignal)=>{workspaceLease=await input.writes.acquireTask(plan.workspaceRoot,workspaceAccess,signal);},run:async(signal:AbortSignal)=>{
          if(!workspaceLease)throw new Error("子任务工作区资源未接纳。");
          return workspaceLease.run(async()=>{
          const needsMcp=specification.tools.some(name=>name.startsWith("mcp__"));
          const externalTools=needsMcp?await input.initialize(permissions.gateway,signal,deadlineAt,leases):[];
          for(const name of specification.requiredExternalTools)if(!externalTools.some(tool=>tool.name===name))throw new Error("子任务所需 MCP 工具未获授权或不可用。");
          child=await createChildSession({child:{id,store,history,referenceAliases,maxRuntimeMs:Math.max(1,deadlineAt-Date.now()),maxIterations},config:plan.config,provider:input.requestBudget.wrap(input.provider(plan.config),plan.config.maxOutputTokens),sandbox:input.sandbox,workspace:input.workspace,catalog:input.skills,readMemory:input.readMemory,inheritedSkills:plan.inheritedSkills,modelIds:input.modelIds,parentTools:tools,externalTools,restrict:access=>new ChildToolPolicy(access,tools,undefined,input.currentTools),options:{toolFailurePolicy: input.toolFailurePolicy,childExecutionFacts:()=>handoff.promptFacts(),maxIterations,maxRuntimeMs:Math.max(1,deadlineAt-Date.now()),writes:input.writes,promptEnvironment:plan.environment,optionalPromptContext:{...plan.optional,childRole:childInstructions(plan.role?.instructions)},permissionGatewayForMode:()=>permissions.gateway}});
          return runChildExecution({id,handoff,agent:child.agent,prompt:task.prompt+(specification.output?"\n本次声明的文件产物与确定性验收要求："+JSON.stringify(specification.output):""),mode:specification.mode,signal,deadlineAt,usage:child.modelUsage,saveReply:(reply,facts)=>input.childResults.save(contract.scope,id,reply,facts),runLog:{...input.runLog,providerId:specification.provider.id,conversationId:id,createRunId:()=>id,parentRunId:contract.turnId,parentCallId:contract.callId}});
          });
        }};
      }catch{try{await close();}catch{throw new TaskPreparationError("failed");}throw new TaskPreparationError("complete");}
    }});
    return admissionResult(view);
  }, input.parentExecution?.delegationKind);
}

function admissionResult(view:TaskView){return successfulToolResult({taskId:view.id,conversationId:view.conversationId,createdAt:view.createdAt,kind:view.kind,state:view.state.status,workspaceAccess:view.workspaceAccess??null,background:view.background,deadlineAt:view.deadlineAt,maxIterations:view.maxIterations,next:view.background?"后台完成后在安全边界交付结果":"调用 agent wait 等待此 ID，或在界面转后台"},"none");}
