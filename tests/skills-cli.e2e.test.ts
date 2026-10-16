import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { runtimeFixture, waitUntil } from './helpers/runtime-fixture';
import { writeSkill, say, call } from './helpers/skill-fixture';
test('独立 Skill 等待审批时取消，父会话可继续且无副作用', async () => {
    let count = 0;
    const fixture = await runtimeFixture(() => ++count === 1 ? call('write_file', { path: 'cancelled.txt', content: 'no' }) : say('继续'), { terminal: true });
    try {
        await writeSkill(fixture, 'worker', { mode: 'isolated', tools: ['write_file'] });
        const running = fixture.controller.handleLine('/skill run worker');
        await waitUntil(() => fixture.output().includes('需要授权'));
        fixture.controller.cancel();
        await running;
        await assert.rejects(readFile(path.join(fixture.root, 'cancelled.txt')));
        assert.match(fixture.output(), /停止：cancelled/);
        await fixture.controller.handleLine('继续');
        assert.equal(fixture.controller.busy, false);
        assert.equal(fixture.errors(), '');
    }
    finally {
        await fixture.close();
    }
});
test('独立 Skill 有限最大轮数终止，非交互审批不会自动放行', async () => {
    let count = 0;
    const fixture = await runtimeFixture(() => ++count === 1 ? call('write_file', { path: 'deny.txt', content: 'no' }) : call('read_file', { path: 'missing.txt' }, `read-${count}`), { iterations: '2' });
    try {
        await writeSkill(fixture, 'worker', { mode: 'isolated', tools: ['write_file', 'read_file'] });
        await fixture.controller.handleLine('/skill run worker');
        await assert.rejects(readFile(path.join(fixture.root, 'deny.txt')));
        assert.match(JSON.stringify(fixture.server.requests.map(request => request.body)), /max-iterations|独立 Skill/);
        assert.match(fixture.output(), /非交互输入无法审批/);
    }
    finally {
        await fixture.close();
    }
});
test('父取消传播至独立 Skill 已启动的真实受管进程', async () => {
    let count = 0, release = () => { };
    const fixture = await runtimeFixture(async () => { if (++count === 1)
        return call('start_process', { command: 'sleep 30' }, 'managed'); if (count === 2)
        await new Promise<void>(resolve => { release = resolve; }); return say('停止'); }, { terminal: true });
    try {
        await writeSkill(fixture, 'worker', { mode: 'isolated', tools: ['start_process'] });
        await fixture.controller.handleLine('/permissions permissive');
        const running = fixture.controller.handleLine('/skill run worker');
        await waitUntil(() => fixture.server.requests.length === 2, 5000);
        const pid = Number(/"pid": (\d+)/.exec(fixture.output())?.[1]);
        assert.ok(Number.isSafeInteger(pid) && pid > 0);
        fixture.controller.cancel();
        release();
        await running;
        await waitUntil(() => { try {
            process.kill(pid, 0);
            return false;
        }
        catch {
            return true;
        } }, 5000);
        assert.match(fixture.output(), /停止：cancelled/);
    }
    finally {
        release();
        await fixture.close();
    }
});
