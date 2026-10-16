import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadSkillCatalog } from "./catalog";
test("覆盖顺序、坏文件隔离和高层无效阻断", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orbit-skills-'));
    const workspaceRoot = path.join(root, 'project'), userRoot = path.join(root, 'user'), builtinRoot = path.join(root, 'builtin');
    const text = (description: string) => `---\nname: sample\ndescription: ${description}\nallowed-tools: []\nmode: shared\n---\n正文`;
    try {
        for (const dir of [path.join(workspaceRoot, '.orbitcode/skills'), path.join(userRoot, 'skills'), builtinRoot]) {
            await mkdir(dir, { recursive: true });
            await writeFile(path.join(dir, 'sample.md'), text(dir));
        }
        const options = { workspaceRoot, userRoot, builtinRoot };
        assert.equal((await loadSkillCatalog(options)).entries.get('sample')?.source, 'project');
        await writeFile(path.join(workspaceRoot, '.orbitcode/skills/broken.md'), 'invalid');
        assert.equal((await loadSkillCatalog(options)).entries.size, 1);
        await writeFile(path.join(workspaceRoot, '.orbitcode/skills/sample.md'), text('valid').replace('mode: shared', 'mode: wrong'));
        const catalog = await loadSkillCatalog(options);
        assert.equal(catalog.entries.size, 0);
        assert.ok(catalog.blocked.includes('sample'));
        assert.ok(catalog.diagnostics.length >= 2);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('同层冲突、缺目录、不可读来源和项目根链接逃逸都有独立诊断', async () => {
    const { symlink } = await import('node:fs/promises');
    const { SkillSession } = await import('./service');
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-catalog-errors-'));
    const workspaceRoot = path.join(root, 'project'), userRoot = path.join(root, 'user'), builtinRoot = path.join(root, 'builtin');
    const text = (name: string) => `---\nname: ${name}\ndescription: 说明\nallowed-tools: []\nmode: shared\n---\n正文`;
    try {
        const options = { workspaceRoot, userRoot, builtinRoot };
        assert.equal((await loadSkillCatalog(options)).complete, true);
        const project = path.join(workspaceRoot, '.orbitcode/skills');
        await mkdir(project, { recursive: true });
        await writeFile(path.join(project, 'a.md'), text('same'));
        await writeFile(path.join(project, 'b.md'), text('same'));
        await writeFile(path.join(project, 'valid.md'), text('valid'));
        await writeFile(path.join(root, 'outside.md'), text('outside'));
        await symlink(path.join(root, 'outside.md'), path.join(project, 'outside.md'));
        const duplicate = await loadSkillCatalog(options);
        assert.ok(duplicate.blocked.includes('same'));
        assert.ok(duplicate.entries.has('valid'));
        assert.ok(!duplicate.entries.has('outside'));
        assert.ok(duplicate.diagnostics.some(item => /重复/.test(item.detail)));
        await mkdir(userRoot, { recursive: true });
        await writeFile(path.join(userRoot, 'skills'), '不是目录');
        const unreadable = await loadSkillCatalog(options);
        assert.equal(unreadable.complete, false);
        const session = new SkillSession(undefined, unreadable, { tools: () => new Set(), providerId: 'p', modelIds: new Set(['p']) });
        await assert.rejects(session.resolve('valid', '', new AbortController().signal), /来源不完整/);
        await rm(project, { recursive: true });
        await mkdir(builtinRoot, { recursive: true });
        await symlink(builtinRoot, project);
        assert.equal((await loadSkillCatalog(options)).complete, false);
    } finally { await rm(root, { recursive: true, force: true }); }
});

for (const [kind, count] of [['entry', 257], ['directory', 1025]] as const) test(`目录扫描 ${kind} 上限不返回截断的可激活目录`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-catalog-limit-'));
    try {
        const dir = path.join(root, '.orbitcode/skills');
        await mkdir(dir, { recursive: true });
        await Promise.all(Array.from({ length: count }, (_, index) => writeFile(path.join(dir, `${index}.${kind === 'entry' ? 'md' : 'txt'}`), `---\nname: item-${index}\ndescription: 简介\nallowed-tools: []\nmode: shared\n---\n正文`)));
        const catalog = await loadSkillCatalog({ workspaceRoot: root, userRoot: path.join(root, 'user'), builtinRoot: path.join(root, 'builtin') });
        assert.equal(catalog.complete, false);
        assert.equal(catalog.entries.size, 0);
        assert.ok(catalog.diagnostics.some(item => /未完成/.test(item.detail)));
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('入口累计字节与目录摘要预算超限都有诊断，模型不收到不完整列表', async () => {
    const { SkillSession } = await import('./service');
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-catalog-bytes-'));
    const project = path.join(root, 'project/.orbitcode/skills'), user = path.join(root, 'user/skills');
    try {
        for (const dir of [project, user]) {
            await mkdir(dir, { recursive: true });
            await Promise.all(Array.from({ length: 80 }, (_, index) => writeFile(path.join(dir, `${index}.md`), `---\nname: item-${index}\ndescription: 简介\nallowed-tools: []\nmode: shared\n---\n${'x'.repeat(61000)}`)));
        }
        const options = { workspaceRoot: path.join(root, 'project'), userRoot: path.join(root, 'user'), builtinRoot: path.join(root, 'builtin') };
        assert.equal((await loadSkillCatalog(options)).complete, false);
        await rm(project, { recursive: true }); await rm(user, { recursive: true });
        await mkdir(project, { recursive: true });
        await Promise.all(Array.from({ length: 40 }, (_, index) => writeFile(path.join(project, `${index}.md`), `---\nname: item-${index}\ndescription: ${'介'.repeat(200)}\nallowed-tools: []\nmode: shared\n---\n正文`)));
        const catalog = await loadSkillCatalog(options);
        assert.equal(catalog.complete, true);
        assert.ok(catalog.diagnostics.some(item => /16 KiB/.test(item.detail)));
        const session = new SkillSession(undefined, catalog, { tools: () => new Set(), providerId: 'p', modelIds: new Set(['p']) });
        assert.equal(session.prompt({}).availableSkills, undefined);
    } finally { await rm(root, { recursive: true, force: true }); }
});
