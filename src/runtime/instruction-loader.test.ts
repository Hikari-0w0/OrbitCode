import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadInstructions } from "./instruction-loader";
test("指令来源、循环与 include 目录边界", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "instructions-")), workspaceRoot = path.join(dir, "w"), userConfigRoot = path.join(dir, "u");
    try {
        await mkdir(path.join(workspaceRoot, ".orbitcode"), { recursive: true });
        await mkdir(userConfigRoot);
        await writeFile(path.join(userConfigRoot, "instructions.md"), "用户规则");
        await writeFile(path.join(workspaceRoot, "AGENTS.md"), "根规则\n@include <child.md>");
        await writeFile(path.join(workspaceRoot, "child.md"), "子规则\n@include <AGENTS.md>");
        await writeFile(path.join(workspaceRoot, ".orbitcode/instructions.md"), "项目规则");
        const loaded = await loadInstructions({ workspaceRoot, userConfigRoot });
        assert.equal(loaded.status, "ready");
        if (loaded.status !== "ready")
            return;
        assert.deepEqual(loaded.instructions.map(x => x.source), ["user", "project-agents", "project-instructions"]);
        assert.match(loaded.instructions[1].content, /子规则/);
        assert.equal(loaded.diagnostics.length, 1);
        await writeFile(path.join(workspaceRoot, ".orbitcode/instructions.md"), "@include <../child.md>");
        assert.equal((await loadInstructions({ workspaceRoot, userConfigRoot })).status, "blocked");
        await writeFile(path.join(workspaceRoot, ".orbitcode/instructions.md"), "@include <link>");
        await symlink(path.join(userConfigRoot, "instructions.md"), path.join(workspaceRoot, ".orbitcode/link"));
        assert.equal((await loadInstructions({ workspaceRoot, userConfigRoot })).status, "blocked");
        for (let i = 0; i <= 6; i++)
            await writeFile(path.join(workspaceRoot, `d${i}.md`), i < 6 ? `@include <d${i + 1}.md>` : "end");
        await writeFile(path.join(workspaceRoot, ".orbitcode/instructions.md"), "project");
        await writeFile(path.join(workspaceRoot, "AGENTS.md"), "@include <d0.md>");
        assert.equal((await loadInstructions({ workspaceRoot, userConfigRoot })).status, "blocked");
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test("深度与数量限额、缺失及敏感引用均有界失败", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "include-limits-"));
    try {
        const workspaceRoot = path.join(dir, "w"), userConfigRoot = path.join(dir, "u");
        await mkdir(workspaceRoot);
        await mkdir(userConfigRoot);
        for (let i = 1; i <= 5; i++)
            await writeFile(path.join(workspaceRoot, `d${i}.md`), i < 5 ? `@include <d${i + 1}.md>` : "end");
        await writeFile(path.join(workspaceRoot, "AGENTS.md"), "@include <d1.md>");
        assert.equal((await loadInstructions({ workspaceRoot, userConfigRoot })).status, "ready");
        for (let i = 0; i < 32; i++)
            await writeFile(path.join(workspaceRoot, `f${i}.md`), "x");
        await writeFile(path.join(workspaceRoot, "AGENTS.md"), Array.from({ length: 31 }, (_, i) => `@include <f${i}.md>`).join("\n"));
        assert.equal((await loadInstructions({ workspaceRoot, userConfigRoot })).status, "ready");
        await writeFile(path.join(workspaceRoot, "AGENTS.md"), Array.from({ length: 32 }, (_, i) => `@include <f${i}.md>`).join("\n"));
        assert.equal((await loadInstructions({ workspaceRoot, userConfigRoot })).status, "blocked");
        for (const content of ["@include <missing>", "@include <https://example.com>", "@include </tmp/invalid>", "@include <.env>", "x".repeat(16001)]) {
            await writeFile(path.join(workspaceRoot, "AGENTS.md"), content);
            await writeFile(path.join(workspaceRoot, ".env"), "PRIVATE_TEST_SENTINEL");
            assert.equal((await loadInstructions({ workspaceRoot, userConfigRoot })).status, "blocked");
        }
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("单文件 16,000 字节及展开 48,000 字节的准确边界",async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),"instruction-bytes-"));try{
 const workspaceRoot=path.join(dir,"w"),userConfigRoot=path.join(dir,"u");await mkdir(path.join(workspaceRoot,".orbitcode"),{recursive:true});await mkdir(userConfigRoot);
 await writeFile(path.join(workspaceRoot,"AGENTS.md"),"x".repeat(16000));assert.equal((await loadInstructions({workspaceRoot,userConfigRoot})).status,"ready");
 for(const file of [path.join(workspaceRoot,"AGENTS.md"),path.join(workspaceRoot,".orbitcode/instructions.md"),path.join(userConfigRoot,"instructions.md")])await writeFile(file,"x".repeat(15999));
 assert.equal((await loadInstructions({workspaceRoot,userConfigRoot})).status,"ready");await writeFile(path.join(userConfigRoot,"instructions.md"),"x".repeat(16000));assert.equal((await loadInstructions({workspaceRoot,userConfigRoot})).status,"blocked");
 }finally{await rm(dir,{recursive:true,force:true});}
});
