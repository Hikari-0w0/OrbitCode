import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadAgentCatalog } from "./catalog";
test("项目角色优先，重复/坏定义/越界不回退，已有快照不变", async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'orbitcode-roles-'));
  try {
    const dir=path.join(root,'.orbitcode/agents'); await mkdir(dir,{recursive:true});
    const body=await readFile('agents/explorer.md','utf8');
    await writeFile(path.join(dir,'explorer.md'),body.replace('只读探索代码与上下文','项目探索'));
    const load=()=>loadAgentCatalog({workspaceRoot:root,userRoot:root});
    const before=await load(); assert.equal(before.entries.get('explorer')?.source,'project');
    await writeFile(path.join(dir,'explorer.md'),body.replace('max-iterations: 16','max-iterations: 0'));
    assert.equal((await load()).entries.has('explorer'),false);
    assert.equal(before.entries.get('explorer')?.role.description,'项目探索');
    await writeFile(path.join(dir,'explorer.md'),body); await writeFile(path.join(dir,'duplicate.md'),body);
    assert.equal((await load()).entries.has('explorer'),false);
    await symlink('/etc/passwd',path.join(dir,'escape.md')); assert.equal((await load()).complete,false);
  } finally { await rm(root,{recursive:true,force:true}); }
});
test('用户覆盖内置且项目覆盖用户，逐层移除后重新发现',async()=>{const root=await mkdtemp(path.join(tmpdir(),'agent-layers-'));try{const user=path.join(root,'user'),project=path.join(root,'project');await mkdir(path.join(user,'agents'),{recursive:true});await mkdir(path.join(project,'.orbitcode/agents'),{recursive:true});const body=await readFile('agents/explorer.md','utf8');const load=()=>loadAgentCatalog({workspaceRoot:project,userRoot:user});assert.equal((await load()).entries.get('explorer')?.source,'builtin');await writeFile(path.join(user,'agents/explorer.md'),body);assert.equal((await load()).entries.get('explorer')?.source,'user');await writeFile(path.join(project,'.orbitcode/agents/explorer.md'),body);assert.equal((await load()).entries.get('explorer')?.source,'project');}finally{await rm(root,{recursive:true,force:true});}});
test('目录候选和提示摘要容量超限明确阻断，不发布残缺目录',async()=>{const root=await mkdtemp(path.join(tmpdir(),'agent-capacity-'));try{const dir=path.join(root,'.orbitcode/agents');await mkdir(dir,{recursive:true});const body=await readFile('agents/explorer.md','utf8');await Promise.all(Array.from({length:129},(_,i)=>writeFile(path.join(dir,`role-${i}.md`),body.replace('name: explorer',`name: role-${i}`).replace('description: 只读探索代码与上下文','description: '+'a'.repeat(200)))));const catalog=await loadAgentCatalog({workspaceRoot:root,userRoot:root});assert.equal(catalog.complete,false);assert.match(catalog.summary,/错误|超限/);assert.ok(catalog.diagnostics.length>0);}finally{await rm(root,{recursive:true,force:true});}});
