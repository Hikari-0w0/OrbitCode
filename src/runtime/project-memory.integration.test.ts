import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRuntime } from "./agent-runtime";
import { ConversationService } from "./conversation-service";
import { LocalConversationStore } from "@/lib/local-conversation-store";
import { ConversationRuntimeManager } from "./conversation-runtime-manager";
import { ConversationOperationGuard } from "./conversation-operation-guard";
import { PermissionSessionManager } from "./permission-session-manager";
import { MacOsSeatbeltCommandSandbox } from "@/tools/macos-seatbelt-sandbox";
import type { ChatProvider, ConversationMessage } from "@/models/provider";
import type { ProviderContext } from "./config";
test("共享运行层实际工具→保存重试→原配置笔记→另一端恢复读取", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "project-memory-flow-"));
    let runtime: AgentRuntime | undefined;
    try {
        const root = path.join(dir, "workspace"), data = path.join(dir, "data");
        await mkdir(root);
        await mkdir(data);
        await writeFile(path.join(root, "README.md"), "真实工作区内容");
        await writeFile(path.join(root, "AGENTS.md"), "根约定");
        const store = new LocalConversationStore(path.join(data, "conversations")), manager = new ConversationRuntimeManager(), guard = new ConversationOperationGuard(manager, store), permissions = new PermissionSessionManager();
        const context: ProviderContext = { environment: { FAKE: "fake-only" }, maxIterations: 4, maxRuntimeMs: 10000, providers: [{ name: "p", protocol: "openai", model: "fixture", baseUrl: "http://127.0.0.1", apiKeyEnvironmentVariable: "FAKE", context: { windowTokens: 64000, singleToolResultTokens: 8000, toolResultGroupTokens: 12000, recentMessagesTokens: 10000, automaticReserveTokens: 13000, manualReserveTokens: 3000, previewChars: 2000 } }] };
        let currentContext = context;
        const providerModels: string[] = [];
        const originalSave = store.save.bind(store);
        let failFirstSave = true;
        store.save = async input => { if (input.checkpoint.lastTurn && failFirstSave) { failFirstSave = false; throw new Error("模拟保存失败"); } return originalSave(input); };
        const captured: (readonly ConversationMessage[])[] = [];
        const provider: ChatProvider = { async *stream(messages, options) {
                captured.push(messages);
                if (options.toolChoice === "none") {
                    const raw: unknown = JSON.parse(String(messages.at(-1)?.content));
                    assert.ok(Array.isArray(raw));
                    const u = raw.find(x => x.kind === "user-stated");
                    yield { type: "text-delta", text: JSON.stringify([{ category: "preference", scope: "project", title: "语言", description: "中文", body: "项目使用中文", evidence: [{ kind: "user-stated", messageId: u.messageId }] }]) };
                    yield { type: "done", finishReason: "stop" };
                    return;
                }
                const hasMemoryReference = /memory:\/\/[a-f0-9]{20}/.test(JSON.stringify(messages));
                assert.equal(options.tools?.some(tool => tool.function.name === "read_memory"), hasMemoryReference);
                const lastUser = messages.findLastIndex(x => x.role === "user"), tool = messages.slice(lastUser + 1).find(x => x.role === "tool");
                if (!tool) {
                    const all = JSON.stringify(messages), ref = /memory:\/\/[a-f0-9]+/.exec(all)?.[0];
                    yield { type: "tool-call", call: { id: `c${captured.length}`, name: ref ? "read_memory" : "read_file", argumentsJson: JSON.stringify(ref ? { reference: ref, offset: 0, limit: 100 } : { path: "README.md" }) } };
                    yield { type: "done", finishReason: "tool-call" };
                }
                else {
                    yield { type: "text-delta", text: "完整回复" };
                    yield { type: "done", finishReason: "stop" };
                }
            } };
        runtime = new AgentRuntime({ userConfigRoot: data, store, manager, guard, permissions, sandbox: new MacOsSeatbeltCommandSandbox(), log: { async append() { } }, loadConfig: async () => currentContext, loadWorkspaces: async () => ({ entries: [{ id: "w", name: "测试", rootPath: root }], summaries: [{ id: "w", name: "测试", available: true, isDefault: true }], defaultWorkspaceId: "w" }), loadMcp: async () => ({ servers: [], diagnostics: [] }), createProvider: config => { providerModels.push(config.model); return provider; } });
        const service = new ConversationService(store, manager, guard, async () => context);
        service.configureMemory(runtime.memory, cp => runtime!.scheduleSaved(cp));
        let cp = await service.create({ workspaceId: "w", providerId: "p" });
        const permission = permissions.createSession();
        for await (const event of runtime.streamTurn({ conversationId: cp.summary.id, expectedRevision: 0, permissionSessionId: permission.id, input: "项目使用中文", mode: "do", modeTurn: 1, source: "web", signal: new AbortController().signal }))
            if (event.type === "finished")
                assert.equal(event.persistence.status, "failed");
        assert.equal((await runtime.memory.inspect()).length, 0);
        currentContext = {...context, providers: context.providers.map(provider => ({...provider, model: "changed-after-turn"}))};
        await service.retrySave({conversationId: cp.summary.id, expectedRevision: 0});
        await runtime.memory.jobs.idle();
        assert.deepEqual(providerModels.slice(0,2), ["fixture", "fixture"]);
        assert.equal((await (await runtime.memoryStoresFor(cp.summary.id)).project.load()).notes.length, 1);
        cp = await service.load(cp.summary.id);
        const permission2 = permissions.createSession();
        for await (const event of runtime.streamTurn({ conversationId: cp.summary.id, expectedRevision: cp.summary.revision, permissionSessionId: permission2.id, input: "读取记忆", mode: "do", modeTurn: 2, source: "cli", signal: new AbortController().signal }))
            if (event.type === "finished")
                assert.equal(event.stopped.reason, "final-response");
        await runtime.memory.jobs.idle();
        assert.ok(captured.some(messages => messages.some(x => x.role === "tool" && x.content.includes("项目使用中文"))));
        await service.clear({ conversationId: cp.summary.id, expectedRevision: (await store.load(cp.summary.id)).summary.revision });
        assert.notEqual((await store.load(cp.summary.id)).lifecycleEpoch, cp.lifecycleEpoch);
    }
    finally {
        await runtime?.close();
        await runtime?.memory.jobs.idle();
        await rm(dir, { recursive: true, force: true });
    }
});
