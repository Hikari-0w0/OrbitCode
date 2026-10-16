import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SkillSession } from './service';
import { loadSkillCatalog } from './catalog';
import { validSkillState } from '@/core/skills/types';
test('激活失败不改变旧快照，幂等及持久化校验拒绝伪造状态', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-state-'));
    try {
        const dir = path.join(root, '.orbitcode/skills');
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 'sample.md'), '---\nname: sample\ndescription: 示例\nallowed-tools: []\nmode: shared\n---\n{{arg:1}}');
        const catalog = await loadSkillCatalog({ workspaceRoot: root, userRoot: path.join(root, 'user'), builtinRoot: path.join(root, 'builtin') });
        const session = new SkillSession(undefined, catalog, { tools: () => new Set(), providerId: 'p', modelIds: new Set(['p']) });
        const { activation } = await session.resolve('sample', '正文', new AbortController().signal);
        session.activate(activation);
        session.activate(activation);
        assert.equal(session.snapshot().generation, 1);
        const old = session.snapshot();
        await assert.rejects(session.resolve('sample', '', new AbortController().signal));
        assert.deepEqual(session.snapshot(), old);
        assert.ok(validSkillState(old));
        assert.equal(validSkillState({ ...old, active: [...old.active, ...old.active] }), false);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test('激活数量和字节上限失败保留原集合', async () => {
    const { emptySkillState } = await import('@/core/skills/types');
    const catalog = { revision: 'r', entries: new Map(), blocked: [], diagnostics: [], complete: true };
    const session = new SkillSession(emptySkillState(), catalog, { tools: () => new Set(), providerId: 'p', modelIds: new Set(['p']) });
    const activation = (name: string, instructions = '内容') => ({ definition: { name, description: '说明', mode: 'shared' as const, allowedTools: [] }, source: 'project' as const, definitionHash: 'a'.repeat(64), resourceRoot: '/tmp', arguments: '', instructions, resourceHashes: {} });
    for (let i = 0; i < 8; i++)
        session.activate(activation(`skill-${i}`));
    const before = session.snapshot();
    assert.throws(() => session.activate(activation('overflow')));
    assert.deepEqual(session.snapshot(), before);
    assert.throws(() => session.activate(activation('skill-0', 'x'.repeat(128 * 1024 + 1))));
    assert.deepEqual(session.snapshot(), before);
});
test('指定模型不可用、共享模型冲突和未发现外部工具不隐式回退', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-model-'));
    try {
        const dir = path.join(root, '.orbitcode/skills');
        await mkdir(dir, { recursive: true });
        for (const [name, extra, tools] of [['missing', 'model: absent', ''], ['mismatch', 'model: second', ''], ['external', '', 'mcp__notdiscovered__tool']])
            await writeFile(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: 简介\nallowed-tools: [${tools}]\nmode: shared\n${extra}\n---\n正文`);
        const session = new SkillSession(undefined, await loadSkillCatalog({ workspaceRoot: root, userRoot: path.join(root, 'user'), builtinRoot: path.join(root, 'builtin') }), { tools: () => new Set(), providerId: 'primary', modelIds: new Set(['primary', 'second']) });
        for (const name of ['missing', 'mismatch', 'external'])
            await assert.rejects(session.resolve(name, '', new AbortController().signal));
        assert.equal(session.active().length, 0);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('第 65 个资源指纹和模型窗口预算失败都保留原激活集合', async () => {
    const catalog = { revision: 'r', entries: new Map(), blocked: [], diagnostics: [], complete: true };
    const session = new SkillSession(undefined, catalog, { tools: () => new Set(), providerId: 'p', modelIds: new Set(['p']), validateCapacity: active => { if (active.some(item => item.instructions.includes('超出模型窗口'))) throw new Error('模型窗口预算不足'); } });
    const activation = { definition: { name: 'resource', description: '说明', mode: 'shared' as const, allowedTools: [] }, source: 'project' as const, definitionHash: 'a'.repeat(64), resourceRoot: '/tmp', arguments: '', instructions: '正文', resourceHashes: {} };
    session.activate(activation);
    for (let index = 0; index < 64; index++) session.resourceHash('resource', `${index}.txt`, 'b'.repeat(64));
    const before = session.snapshot();
    assert.throws(() => session.resourceHash('resource', '65.txt', 'c'.repeat(64)), /超过 64/);
    assert.deepEqual(session.snapshot(), before);
    assert.throws(() => session.activate({ ...activation, instructions: '超出模型窗口' }), /模型窗口/);
    assert.deepEqual(session.snapshot(), before);
});
