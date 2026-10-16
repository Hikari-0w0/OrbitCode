import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemoryService } from "./memory-service";
import { ConversationService } from "./conversation-service";
import { ConversationOperationGuard } from "./conversation-operation-guard";
import { ConversationRuntimeManager } from "./conversation-runtime-manager";
import { LocalConversationStore } from "@/lib/local-conversation-store";
import { memoryStores } from "./background-service";
import type { ChatProvider } from "@/models/provider";
import type { ResolvedProviderConfig } from "@/models/config";
test("提取尚未返回时关闭、清空或删除均禁止迟到提交", async () => {
    for (const action of ["off", "clear", "delete"] as const) {
        const dir = await mkdtemp(path.join(os.tmpdir(), "memory-race-"));
        try {
            const user = path.join(dir, "user"), workspace = path.join(dir, "workspace");
            await mkdir(user);
            await mkdir(workspace);
            const store = new LocalConversationStore(path.join(dir, "conversations")), manager = new ConversationRuntimeManager(), guard = new ConversationOperationGuard(manager, store), memory = new MemoryService(user, store, guard), service = new ConversationService(store, manager, guard, async () => { throw new Error(); });
            service.configureMemory(memory, async () => { });
            const cp = await store.create({ providerId: "p", workspaceId: "w" });
            const result = await store.save({ conversationId: cp.summary.id, expectedRevision: 0, checkpoint: { ...cp, lastTurn: { turnId: "t", endedAt: new Date().toISOString(), stopReason: "final-response", memoryEligibility: true }, displayMessages: [{ id: "u", role: "user", content: "中文", state: "complete" }, { id: "a", role: "assistant", content: "收到", state: "complete" }] } });
            assert.ok(result.status === "saved");
            let ready: () => void = () => { }, release: () => void = () => { };
            const started = new Promise<void>(resolve => { ready = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
            const provider: ChatProvider = { async *stream() { ready(); await barrier; yield { type: "text-delta", text: '[{"category":"preference","scope":"project","title":"中文","description":"中文","body":"中文","evidence":[{"kind":"user-stated","messageId":"u"}]}]' }; yield { type: "done", finishReason: "stop" }; } };
            const config: ResolvedProviderConfig = { name: "p", protocol: "openai", model: "fixture", baseUrl: "http://127.0.0.1", apiKey: "fake", apiKeyEnvironmentVariable: "FAKE", context: { windowTokens: 32000, singleToolResultTokens: 8000, toolResultGroupTokens: 12000, recentMessagesTokens: 10000, automaticReserveTokens: 13000, manualReserveTokens: 3000, previewChars: 2000 } };
            memory.scheduleSavedTurn(result.checkpoint, workspace, config, provider);
            await started;
            if (action === "off")
                await memory.setEnabled(false);
            else
                await service[action]({ conversationId: cp.summary.id, expectedRevision: 1 });
            release();
            await memory.jobs.idle();
            assert.equal((await memoryStores(workspace, user).project.load()).notes.length, 0);
            assert.equal((await memory.inspect())[0].status, "abandoned");
            memory.close();
        }
        finally {
            await rm(dir, { recursive: true, force: true });
        }
    }
});

test("另一端前台请求短暂等待后台提交，不丢弃用户输入",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"memory-foreground-"));try{
 const store=new LocalConversationStore(root),cp=await store.create({providerId:"p",workspaceId:"w"});
 const first=new ConversationOperationGuard(new ConversationRuntimeManager(),store),second=new ConversationOperationGuard(new ConversationRuntimeManager(),new LocalConversationStore(root));
 const background=await first.begin(cp.summary.id,"memory-commit");let settled=false;
 const waiting=second.begin(cp.summary.id,"agent").then(operation=>{settled=true;return operation;});
 await new Promise<void>(resolve=>setTimeout(resolve,30));assert.equal(settled,false);await background.finish();const foreground=await waiting;assert.equal(foreground.kind,"agent");await foreground.finish();
 }finally{await rm(root,{recursive:true,force:true});}
});
