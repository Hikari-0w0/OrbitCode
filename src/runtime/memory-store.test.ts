import fs from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "./memory-store";
import { parseCandidate } from "./memory-validation";
test("版本提交、去重、人工修改与墓碑", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "memory-"));
    try {
        const store = new MemoryStore(path.join(root, "memory"), "project", root), source = { conversationId: "c", turnId: "t", savedRevision: 1, lifecycleEpoch: "e" };
        const candidate = parseCandidate({ category: "preference", scope: "project", title: "语言", description: "使用中文", body: "使用中文", evidence: [{ kind: "user-stated", messageId: "u" }] });
        const first = await store.commit({ expectedRevision: "empty", candidates: [candidate], source });
        assert.equal(first.status, "saved");
        const snap = await store.load();
        assert.equal(snap.notes.length, 1);
        assert.equal((await store.commit({ expectedRevision: snap.revision, candidates: [candidate], source })).status, "saved");
        assert.equal((await store.load()).notes.length, 1);
        const target = path.join(store.root, "generations", snap.revision, "notes", `${snap.notes[0].id}.md`);
        await writeFile(target, (await readFile(target, "utf8")).replace(/\n使用中文\n$/, "\n人工更新\n"));
        assert.equal((await store.commit({ expectedRevision: snap.revision, candidates: [candidate], source: { ...source, turnId: "t2" } })).status, "rejected");
        const changed = await store.load();
        assert.equal(changed.notes[0].body, "人工更新");
        assert.notEqual(changed.revision, snap.revision);
        const deleted = await store.update(changed.revision, changed.notes[0].id, null);
        assert.equal(deleted.notes.length, 0);
        await store.commit({ expectedRevision: deleted.revision, candidates: [candidate], source });
        assert.equal((await store.load()).notes.length, 0);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("两个进程竞争相同修订，旧写入被拒绝且不丢失已提交笔记", async () => {
    const { spawn } = await import("node:child_process");
    const root = await mkdtemp(path.join(os.tmpdir(), "memory-process-"));
    try {
        const target = path.join(root, "memory");
        const writer = (turn: string) => new Promise<string>((resolve, reject) => {
            const code = `const {MemoryStore}=require('./src/runtime/memory-store.ts');const store=new MemoryStore(${JSON.stringify(target)},'project',${JSON.stringify(root)});store.commit({expectedRevision:'empty',source:{conversationId:'c',turnId:${JSON.stringify(turn)},savedRevision:1,lifecycleEpoch:'e'},candidates:[{category:'preference',scope:'project',title:${JSON.stringify(turn)},description:'中文',body:${JSON.stringify(turn)},evidence:[{kind:'user-stated',messageId:'u'}]}]}).then(result=>process.stdout.write(result.status));`;
            const child = spawn(process.execPath, ["--import", "tsx", "-e", code], { cwd: process.cwd() });
            let output = "", errors = "";
            child.stdout.on("data", chunk => { output += chunk.toString(); });
            child.stderr.on("data", chunk => { errors += chunk.toString(); });
            child.on("error", reject);
            child.on("exit", status => status === 0 ? resolve(output) : reject(new Error(errors)));
        });
        const results = await Promise.all([writer("t1"), writer("t2")]);
        assert.deepEqual(results.sort(), ["rejected", "saved"]);
        assert.equal((await new MemoryStore(target, "project", root).load()).notes.length, 1);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("正文、索引、清单及 HEAD 写入失败保持旧完整笔记",async(context)=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"memory-atomic-"));try{
 const store=new MemoryStore(path.join(root,"memory"),"project",root),source={conversationId:"c",turnId:"t1",savedRevision:1,lifecycleEpoch:"e"};
 const candidate=parseCandidate({category:"preference",scope:"project",title:"语言",description:"中文",body:"中文",evidence:[{kind:"user-stated",messageId:"u"}]});
 await store.commit({expectedRevision:"empty",source,candidates:[candidate]});const before=await store.load();
 const original=fs.rename;for(const stage of ["notes","index.md","manifest.json","HEAD.json"]){context.mock.method(fs,"rename",async(...args:Parameters<typeof fs.rename>)=>{const target=String(args[1]);if(stage==="notes"?path.basename(path.dirname(target))==="notes":path.basename(target)===stage)throw new Error("模拟提交写入失败");return original(...args);});
 await assert.rejects(store.commit({expectedRevision:before.revision,source:{...source,turnId:"t2"},candidates:[{...candidate,title:"格式",body:"格式规则"}]}));
 assert.deepEqual(await store.load(),before);context.mock.restoreAll();}
 }finally{context.mock.restoreAll();await rm(root,{recursive:true,force:true});}
});

test("实际索引容量不足拒绝新候选并保留旧修订",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"memory-capacity-"));try{
 const store=new MemoryStore(path.join(root,"memory"),"project",root);let rejected=false;
 for(let batch=0;batch<8;batch++){
  const before=await store.load();const candidates=Array.from({length:8},(_,i)=>parseCandidate({category:"preference",scope:"project",title:`规则${batch*8+i}`,description:"中".repeat(160),body:`长期规则${batch*8+i}`,evidence:[{kind:"user-stated",messageId:"u"}]}));
  const result=await store.commit({expectedRevision:before.revision,candidates,source:{conversationId:"c",turnId:`t${batch}`,savedRevision:batch+1,lifecycleEpoch:"e"}});
  if(result.status==="rejected"){assert.equal(result.reason,"capacity");assert.deepEqual(await store.load(),before);rejected=true;break;}
 }
 assert.equal(rejected,true);assert.ok(Buffer.byteLength((await store.load()).index)<=25000);
 }finally{await rm(root,{recursive:true,force:true});}
});
