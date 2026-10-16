import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { runtimeFixture } from './helpers/runtime-fixture';
import { writeSkill, say } from './helpers/skill-fixture';
test('独立 CLI 进程恢复同一激活快照且停用写入可由主进程读取', async () => {
    const fixture = await runtimeFixture(() => say('已执行'));
    try {
        await writeSkill(fixture, 'shared');
        await fixture.controller.handleLine('/skill run shared 保留参数');
        const before = await fixture.checkpoint();
        const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('tests/helpers/skill-cli-process.ts'), fixture.root, before.summary.id], { stdio: 'pipe' });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
        child.stdin.end('/skills\n继续\n/skill deactivate shared\n/exit\n');
        assert.equal(await exited, 0, stderr);
        assert.match(stdout, /shared/);
        assert.match(JSON.stringify(fixture.server.requests.at(-1)?.body), /独特操作正文 保留参数/);
        assert.equal((await fixture.checkpoint()).skills?.active.length, 0);
    }
    finally {
        await fixture.close();
    }
});

test('两个独立 CLI 进程同时停用同一旧修订，磁盘租约和 CAS 保证只提交一次', async () => {
    const { waitUntil } = await import('./helpers/runtime-fixture');
    const fixture = await runtimeFixture(() => say('已执行'));
    const children: ReturnType<typeof spawn>[] = [];
    try {
        await writeSkill(fixture, 'shared');
        await fixture.controller.handleLine('/skill run shared');
        const before = await fixture.checkpoint();
        const outputs = ['', ''], errors = ['', ''];
        const exitPromises = [0, 1].map(index => {
            const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('tests/helpers/skill-cli-process.ts'), fixture.root, before.summary.id], { stdio: 'pipe' });
            children.push(child);
            child.stdout?.on('data', chunk => { outputs[index] += chunk.toString(); });
            child.stderr?.on('data', chunk => { errors[index] += chunk.toString(); });
            return new Promise<number | null>(resolve => child.once('exit', resolve));
        });
        await waitUntil(() => outputs.every(output => output.includes(`revision ${before.summary.revision}`)), 5000);
        for (const child of children) child.stdin?.end('/skill deactivate shared\n/exit\n');
        assert.deepEqual((await Promise.all(exitPromises)).sort(), [0, 1], JSON.stringify(errors));
        const saved = await fixture.checkpoint();
        assert.equal(saved.summary.revision, before.summary.revision + 1);
        assert.equal(saved.skills?.active.length, 0);
        assert.equal(errors.filter(error => error.includes('[OrbitCode 错误]')).length, 1);
    } finally { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); await fixture.close(); }
});
