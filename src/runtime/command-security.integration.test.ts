import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRuntime } from "@/runtime/agent-runtime";
import { ConversationService } from "@/runtime/conversation-service";
import { ConversationRuntimeManager } from "@/runtime/conversation-runtime-manager";
import { ConversationOperationGuard } from "@/runtime/conversation-operation-guard";
import { PermissionSessionManager } from "@/runtime/permission-session-manager";
import { LocalConversationStore } from "@/lib/local-conversation-store";
import { EMPTY_SETTINGS } from "@/runtime/settings-types";
import { parseCommandSecurity } from "@/tools/command-security";
import type { ProviderContext } from "@/runtime/config";
import type { ChatProvider } from "@/models/provider";

test("Web/CLI共用运行层按轮固定安全配置，保存新设置不改变正在执行的命令", async () => {
  const directory=await mkdtemp(path.join(tmpdir(),"orbitcode-security-runtime-"));
  let runtime:AgentRuntime|undefined;
  try {
    const root=path.join(directory,"workspace"),data=path.join(directory,"data");await mkdir(root);await mkdir(data);
    const store=new LocalConversationStore(path.join(data,"conversations"));const manager=new ConversationRuntimeManager();const guard=new ConversationOperationGuard(manager,store);const permissions=new PermissionSessionManager();
    let context:ProviderContext={environment:{TEST_KEY:"synthetic-only"},maxIterations:4,maxRuntimeMs:10000,
      providers:[{name:"p",protocol:"openai",model:"fixture",baseUrl:"http://127.0.0.1",apiKeyEnvironmentVariable:"TEST_KEY",context:{windowTokens:64000,singleToolResultTokens:8000,toolResultGroupTokens:12000,recentMessagesTokens:10000,automaticReserveTokens:13000,manualReserveTokens:3000,previewChars:2000}}],
      managedSettings:{...EMPTY_SETTINGS,commandSecurity:parseCommandSecurity({network:"deny",maxTimeoutMs:600000})}};
    const descriptions:string[]=[];const executed:string[]=[];let changed=false;
    const provider:ChatProvider={async *stream(messages,options){
      if(options.toolChoice==="none"){yield {type:"text-delta",text:"[]"};yield {type:"done",finishReason:"stop"};return;}
      const lastUser=messages.findLastIndex(message=>message.role==="user");
      if(messages.slice(lastUser+1).some(message=>message.role==="tool")){yield {type:"text-delta",text:"验证完成"};yield {type:"done",finishReason:"stop"};return;}
      const description=options.tools?.find(tool=>tool.function.name==="run_command")?.function.description;assert.ok(description);descriptions.push(description);
      if(!changed){changed=true;context={...context,managedSettings:{...EMPTY_SETTINGS,commandSecurity:parseCommandSecurity({network:"allow"})}};}
      yield {type:"tool-call",call:{id:`call-${descriptions.length}`,name:"run_command",argumentsJson:JSON.stringify({command:"test-command",timeout_ms:descriptions.length===1?300000:1000})}};
      yield {type:"done",finishReason:"tool-call"};
    }};
    runtime=new AgentRuntime({userConfigRoot:data,store,manager,guard,permissions,
      sandbox:{async probe(){throw new Error("不能使用启动时旧沙箱");},async run(){throw new Error("不能使用启动时旧沙箱");}},
      createSandbox:snapshot=>{const security=parseCommandSecurity(snapshot.managedSettings?.commandSecurity);return {security,async probe(){return {available:true};},async run(){executed.push(security.network);return {stdout:"ok",stderr:"",exitCode:0,terminationSignal:null,timedOut:false,cancelled:false,stdoutTruncated:false,stderrTruncated:false};}};},
      log:{async append(){}},loadConfig:async()=>context,loadWorkspaces:async()=>({entries:[{id:"w",name:"fixture",rootPath:root}],summaries:[{id:"w",name:"fixture",available:true,isDefault:true}],defaultWorkspaceId:"w"}),loadMcp:async()=>({servers:[],diagnostics:[]}),createProvider:()=>provider});
    const service=new ConversationService(store,manager,guard,async()=>context);let checkpoint=await service.create({workspaceId:"w",providerId:"p"});
    for(const source of ["web","cli"] as const){
      const session=permissions.createSession();
      for await(const event of runtime.streamTurn({conversationId:checkpoint.summary.id,expectedRevision:checkpoint.summary.revision,permissionSessionId:session.id,input:"执行验证",mode:"do",modeTurn:1,source,signal:new AbortController().signal})){
        if(event.type==="finished")assert.equal(event.persistence.status,"saved");
      }
      checkpoint=await service.load(checkpoint.summary.id);
    }
    assert.deepEqual(executed,["deny","allow"]);
    assert.match(descriptions[0],/网络已关闭/);assert.match(descriptions[0],/600000ms/);
    assert.match(descriptions[1],/允许联网/);assert.match(descriptions[1],/120000ms/);
  }finally{await runtime?.close();await rm(directory,{recursive:true,force:true});}
});
