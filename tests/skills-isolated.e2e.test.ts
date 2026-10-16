import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { runtimeFixture, waitUntil } from "./helpers/runtime-fixture";
import { writeSkill, say, call } from "./helpers/skill-fixture";
for (const choice of ['once', 'deny'] as const)
    test(`独立 Skill 实时审批 ${choice} 并回传有证据摘要`, async () => {
        let count = 0;
        const fixture = await runtimeFixture(() => ++count === 1 ? call('write_file', { path: 'child.txt', content: 'child' }, 'child-write') : say(count === 2 ? '子执行完成' : '主回复'), { terminal: true });
        try {
            await writeSkill(fixture, 'worker', { mode: 'isolated', tools: ['write_file'] });
            const running = fixture.controller.handleLine('/skill run worker 参数');
            await waitUntil(() => /\/approve ([\w-]+) </.test(fixture.output()));
            const id = /\/approve ([\w-]+) </.exec(fixture.output())?.[1];
            assert.ok(id);
            assert.equal(fixture.server.requests.length, 1);
            await fixture.controller.handleLine(`/approve ${id} ${choice}`);
            await running;
            if (choice === 'once')
                assert.equal(await readFile(path.join(fixture.root, 'child.txt'), 'utf8'), 'child');
            else
                await assert.rejects(readFile(path.join(fixture.root, 'child.txt')));
            const saved = await fixture.checkpoint();
            assert.equal(saved.skills?.active.length, 0);
            assert.match(JSON.stringify(fixture.server.requests.at(-1)?.body), /实际结果摘要/);
            assert.equal(fixture.errors(), '');
            const parent = await fixture.log.findAllForConversation(saved.summary.id);
            assert.equal(parent.length, 1);
            assert.equal(parent[0].sideEffect, choice === 'once' ? 'applied' : 'none');
            assert.ok(saved.displayMessages.at(-1)?.toolExecutions?.some(tool => tool.name === 'Skill worker / write_file'));
            assert.ok(!JSON.stringify(saved.context).includes('child-write'));
        }
        finally {
            await fixture.close();
        }
    });
test('子独立递归拒绝且父取消能结束审批等待', async () => {
    let count = 0;
    const fixture = await runtimeFixture(() => ++count === 1 ? call('load_skill', { name: 'worker', arguments: '' }) : say('子结束'), { terminal: true });
    try {
        await writeSkill(fixture, 'worker', { mode: 'isolated', tools: [] });
        await fixture.controller.handleLine('/skill run worker');
        assert.match(JSON.stringify(fixture.server.requests[1]?.body), /不允许递归/);
        assert.equal(fixture.errors(), '');
    }
    finally {
        await fixture.close();
    }
});

test('独立 Skill 指定第二个已配置模型，主会话模型绑定保持原值', async () => {
    const { writeFile } = await import('node:fs/promises');
    const fixture = await runtimeFixture(() => say('由所选模型完成'));
    try {
        const file = path.join(fixture.root, 'orbitcode.yaml');
        await writeFile(file, (await readFile(file, 'utf8')) + `  - name: secondary\n    protocol: openai\n    model: child-model\n    base_url: ${fixture.server.baseUrl}\n    api_key: FIXTURE_KEY\n    context:\n      window_tokens: 128000\n`);
        const root = await writeSkill(fixture, 'worker', { mode: 'isolated', tools: [] });
        const entry = path.join(root, 'SKILL.md');
        await writeFile(entry, (await readFile(entry, 'utf8')).replace('mode: isolated\n', 'mode: isolated\nmodel: secondary\n'));
        await fixture.controller.handleLine('/skill run worker');
        assert.equal(fixture.errors(), '', fixture.output());
        assert.match(JSON.stringify(fixture.server.requests[0]?.body), /"model":"child-model"/, fixture.output());
        assert.match(JSON.stringify(fixture.server.requests[1].body), /"model":"test-model"/);
        assert.equal((await fixture.checkpoint()).summary.providerId, 'primary');
        assert.equal(fixture.errors(), '');
    } finally { await fixture.close(); }
});
