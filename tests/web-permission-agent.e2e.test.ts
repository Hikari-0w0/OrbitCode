import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentLoop } from "@/core/agent-loop";
import type {
  ChatProvider,
  ConversationMessage,
  ModelStreamEvent,
} from "@/models/provider";
import { createModeToolPolicy } from "@/tools/mode-policy";
import {
  loadPermissionRules,
  type PermissionConfigLocations,
} from "@/tools/permission-config";
import { PermissionGateway } from "@/tools/permission-gateway";
import { readFileTool } from "@/tools/read-file";
import { ToolRegistry } from "@/tools/registry";
import { createWorkspaceBoundary } from "@/tools/workspace";
import { writeFileTool } from "@/tools/write-file";
import {
  parseWebChatEvents,
  readWebStream,
  type WebChatEvent,
} from "@/web/chat-contract";
import { streamAgentResponse } from "@/web/chat-handler";

test('Web SSE文件写入无需审批且正文不进入展示事件',async()=>{
 const f=await createFixture(),sentinel='WRITE_BODY_SENTINEL_SHOULD_NOT_REACH_SSE';try{const provider=new ScriptedProvider([toolScript('write','write_file',{path:'out.txt',content:sentinel}),finalScript('完成')]);const events=await runAgent(f,provider);assert.equal(await readFile(path.join(f.root,'out.txt'),'utf8'),sentinel);assert.deepEqual(events.filter(e=>['permission-requested','permission-resolved','tool-started','tool-result'].includes(e.type)).map(e=>e.type),['tool-started','tool-result']);assert.equal(JSON.stringify(events).includes(sentinel),false);assert.equal(JSON.stringify(events).includes(f.root),false);assert.equal(events.filter(e=>e.type==='stopped').length,1);}finally{await f.cleanup();}
});
test('Web显式deny直接拒绝目标，其余文件继续执行',async()=>{
 const f=await createFixture();try{await writeFile(f.locations.project,'rules:\n  "write_file(blocked.txt)": deny\n');const provider=new ScriptedProvider([toolScript('allowed','write_file',{path:'allowed.txt',content:'yes'}),toolScript('blocked','write_file',{path:'blocked.txt',content:'no'}),finalScript('完成')]);const events=await runAgent(f,provider);assert.equal(await readFile(path.join(f.root,'allowed.txt'),'utf8'),'yes');await assert.rejects(readFile(path.join(f.root,'blocked.txt')));assert.ok(events.some(e=>e.type==='tool-result'&&!e.result.ok&&e.result.error.kind==='permission-denied'));assert.equal(events.some(e=>e.type==='permission-requested'),false);}finally{await f.cleanup();}
});
test('Web旧ask规则不等待审批且不自动改写权限配置',async()=>{
 const f=await createFixture();try{const config='rules:\n  "write_file(*)": ask\n';await writeFile(f.locations.local,config);for(const value of ['first','second']){const events=await runAgent(f,new ScriptedProvider([toolScript('write','write_file',{path:'out.txt',content:value}),finalScript('完成')]));assert.equal(events.some(e=>e.type==='permission-requested'),false);assert.equal(await readFile(path.join(f.root,'out.txt'),'utf8'),value);}assert.equal(await readFile(f.locations.local,'utf8'),config);}finally{await f.cleanup();}
});

async function runAgent(fixture:Awaited<ReturnType<typeof createFixture>>,provider:ScriptedProvider):Promise<WebChatEvent[]> {
 const gateway=new PermissionGateway({agentMode:'do',workspace:fixture.workspace,loadRules:async()=>(await loadPermissionRules({workspaceRoot:fixture.root,toolTargets:fixture.registry.permissionTargets(),locations:fixture.locations})).rules});
 const agent=new AgentLoop(provider,mode=>createModeToolPolicy(fixture.registry,mode),fixture.workspace,{maxIterations:8,promptEnvironment:{workspace:{id:'test',name:'Test'},platform:'darwin',currentDate:'2026-10-22',timeZone:'Asia/Shanghai',pathSemantics:'workspace-relative-posix'},permissionGatewayForMode:()=>gateway});
 const response=streamAgentResponse({request:new Request('http://localhost/api/chat',{method:'POST'}),agent,input:'执行文件任务',mode:'do',modeTurn:1});assert.ok(response.body);const events:WebChatEvent[]=[];for await(const event of parseWebChatEvents(readWebStream(response.body)))events.push(event);return events;
}

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-permission-e2e-"));
  const userDirectory = path.join(root, "test-user");
  const orbitDirectory = path.join(root, ".orbitcode");
  await mkdir(userDirectory);
  await mkdir(orbitDirectory);
  const workspace = await createWorkspaceBoundary(root);
  const registry = new ToolRegistry([readFileTool, writeFileTool]);
  const locations: PermissionConfigLocations = {
    user: path.join(userDirectory, "permissions.yaml"),
    project: path.join(orbitDirectory, "permissions.yaml"),
    local: path.join(orbitDirectory, "permissions.local.yaml"),
  };
  return {
    root,
    workspace,
    registry,
    locations,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

class ScriptedProvider implements ChatProvider {
  readonly requests: ConversationMessage[][] = [];

  constructor(private readonly scripts: readonly (readonly ModelStreamEvent[])[]) {}

  stream(
    messages: readonly ConversationMessage[],
  ): AsyncIterable<ModelStreamEvent> {
    this.requests.push(messages.map((message) => ({ ...message })));
    const script = this.scripts[this.requests.length - 1];
    if (!script) throw new Error("测试缺少 Provider 脚本。");
    return emit(script);
  }
}

function toolScript(
  id: string,
  name: "read_file" | "write_file",
  input: Readonly<Record<string, string>>,
): readonly ModelStreamEvent[] {
  return [
    {
      type: "tool-call",
      call: { id, name, argumentsJson: JSON.stringify(input) },
    },
    { type: "done", finishReason: "tool-call" },
  ];
}

function finalScript(content: string): readonly ModelStreamEvent[] {
  return [
    { type: "text-delta", text: content },
    { type: "done", finishReason: "stop" },
  ];
}

async function* emit(
  events: readonly ModelStreamEvent[],
): AsyncIterable<ModelStreamEvent> {
  yield* events;
}
