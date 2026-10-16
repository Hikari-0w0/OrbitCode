import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWorkspaceBoundary } from '@/tools/workspace';
import { SkillSession } from './service';
import { SkillResources } from './resources';
import { loadSkillCatalog } from './catalog';
test('目录资源受边界约束并在内容变化后拒绝旧激活', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-res-'));
    try {
        const dir = path.join(root, '.orbitcode/skills/sample');
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 'SKILL.md'), '---\nname: sample\ndescription: 简介\nallowed-tools: [read_skill_resource]\nmode: shared\n---\n读取资源');
        await writeFile(path.join(dir, 'example.txt'), 'initial');
        const session = new SkillSession(undefined, await loadSkillCatalog({ workspaceRoot: root, userRoot: path.join(root, 'user'), builtinRoot: path.join(root, 'builtin') }), { tools: () => new Set(['read_skill_resource']), providerId: 'p', modelIds: new Set(['p']) });
        session.activate((await session.resolve('sample', '', new AbortController().signal)).activation);
        const workspace = await createWorkspaceBoundary(root);
        const resources = new SkillResources(session, workspace);
        const signal = new AbortController().signal;
        assert.equal((await resources.read('sample', 'example.txt', signal)).content, 'initial');
        assert.throws(() => resources.target('sample', '../escape'));
        await symlink('/etc/hosts', path.join(dir, 'escape'));
        await assert.rejects(resources.read('sample', 'escape', signal));
        await writeFile(path.join(dir, 'example.txt'), 'changed');
        await assert.rejects(resources.validate(signal));
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
