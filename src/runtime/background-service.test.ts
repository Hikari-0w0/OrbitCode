import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareBackground, resumeReminder, memoryStores } from "./background-service";
import { LocalConversationStore } from "@/lib/local-conversation-store";
import { parseCandidate } from "./memory-validation";
test("背景索引按作用域签发，人工修改使引用过期，提醒用轮次时间", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "background-"));
    try {
        const workspaceRoot = path.join(root, "w"), userConfigRoot = path.join(root, "u");
        await mkdir(workspaceRoot);
        await mkdir(userConfigRoot);
        await writeFile(path.join(workspaceRoot, "AGENTS.md"), "中文");
        const cp = await new LocalConversationStore(path.join(root, "conversations")).create({ workspaceId: "w", providerId: "p" });
        const store = memoryStores(workspaceRoot, userConfigRoot).project;
        await store.commit({ expectedRevision: "empty", source: { conversationId: cp.summary.id, turnId: "t", savedRevision: 1, lifecycleEpoch: cp.lifecycleEpoch ?? "e" }, candidates: [parseCandidate({ category: "preference", scope: "project", title: "语言", description: "中文", body: "中文正文", evidence: [{ kind: "user-stated", messageId: "u" }] })] });
        const background = await prepareBackground({ workspaceRoot, userConfigRoot, checkpoint: cp });
        assert.match(background.snapshot.optional.projectInstructions ?? "", /中文/);
        const ref = /memory:\/\/[a-f0-9-]+/.exec(background.snapshot.optional.memoryIndex ?? "")?.[0];
        assert.ok(ref);
        const request = { reference: ref, offset: 0, limit: 8000, signal: new AbortController().signal };
        assert.equal((await background.readMemory(request)).content, "中文正文");
        await assert.rejects(background.readMemory({ ...request, reference: "memory://foreign" }));
        const snap = await store.load();
        await store.update(snap.revision, snap.notes[0].id, null);
        await assert.rejects(background.readMemory(request));
        const old = { ...cp, displayMessages: [{ id: "u", role: "user" as const, content: "x", state: "complete" as const }], lastTurn: { turnId: "t", endedAt: "2026-01-01T00:00:00Z", stopReason: "final-response" as const, memoryEligibility: true } };
        assert.equal(resumeReminder(old, new Date("2026-01-01T23:59:59Z")), undefined);
        assert.match(resumeReminder(old, new Date("2026-01-02T00:00:00Z")) ?? "", /86400/);
        assert.match(resumeReminder({...old, lastTurn: undefined}, new Date("2026-01-02T00:00:00Z")) ?? "", /未知/);
        assert.match(resumeReminder(old, new Date("2025-12-31T00:00:00Z")) ?? "", /未知/);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("用户级背景跨项目复用，项目正文及本轮引用不跨项目",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"memory-scopes-"));try{
 const w1=path.join(root,"one"),w2=path.join(root,"two"),u=path.join(root,"user");await mkdir(w1);await mkdir(w2);await mkdir(u);
 const cp=await new LocalConversationStore(path.join(root,"conversations")).create({workspaceId:"w",providerId:"p"});
 const source={conversationId:cp.summary.id,turnId:"t",savedRevision:1,lifecycleEpoch:cp.lifecycleEpoch??"e"};
 const candidate=parseCandidate({category:"preference",scope:"user",title:"全局",description:"所有项目中文",body:"所有项目使用中文",evidence:[{kind:"user-stated",messageId:"u"}]});
 const stores=memoryStores(w1,u);await stores.user.commit({expectedRevision:"empty",source,candidates:[candidate]});await stores.project.commit({expectedRevision:"empty",source,candidates:[{...candidate,scope:"project",title:"本项目",description:"仅项目一",body:"项目一专属"}]});
 const one=await prepareBackground({workspaceRoot:w1,userConfigRoot:u,checkpoint:cp}),two=await prepareBackground({workspaceRoot:w2,userConfigRoot:u,checkpoint:cp});
 assert.match(one.snapshot.optional.memoryIndex??"",/仅项目一/);assert.match(two.snapshot.optional.memoryIndex??"",/所有项目中文/);assert.doesNotMatch(two.snapshot.optional.memoryIndex??"",/仅项目一/);
 const reference=/memory:\/\/[a-f0-9]+/.exec(one.snapshot.optional.memoryIndex??"")?.[0];assert.ok(reference);await assert.rejects(two.readMemory({reference,offset:0,limit:8000,signal:new AbortController().signal}));
 }finally{await rm(root,{recursive:true,force:true});}
});
