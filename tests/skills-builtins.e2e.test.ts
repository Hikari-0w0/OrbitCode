import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runtimeFixture } from './helpers/runtime-fixture';
import { say, call } from './helpers/skill-fixture';
const exec = promisify(execFile);
test('内置 commit 在隔离 Git 仓库仅提交明确授权文件，无推送', async () => {
    let count = 0;
    const fixture = await runtimeFixture(() => ++count === 1 ? call('run_command', { command: "git -c core.hooksPath=/dev/null -c user.name=SkillFixture -c user.email=skill@example.invalid commit --no-gpg-sign --only allowed.txt -m '验证授权范围'" }) : say('提交完成，覆盖范围有限'));
    try {
        await fixture.runtime.memory.setEnabled(false);
        for (const [name, body] of [['allowed.txt', 'old'], ['other.txt', 'old']])
            await writeFile(path.join(fixture.root, name), body);
        await exec('git', ['init', '-q'], { cwd: fixture.root });
        await exec('git', ['add', '--', 'allowed.txt', 'other.txt'], { cwd: fixture.root });
        await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=SkillFixture', '-c', 'user.email=skill@example.invalid', 'commit', '--no-gpg-sign', '-qm', 'baseline'], { cwd: fixture.root });
        await writeFile(path.join(fixture.root, 'allowed.txt'), 'new');
        await writeFile(path.join(fixture.root, 'other.txt'), 'unrelated');

        await fixture.controller.handleLine('/skill run commit allowed.txt');
        const changed = await exec('git', ['show', '--format=', '--name-only', 'HEAD'], { cwd: fixture.root });
        assert.equal(changed.stdout.trim(), 'allowed.txt');
        assert.equal((await exec('git', ['diff', '--name-only'], { cwd: fixture.root })).stdout.trim(), 'other.txt');
        assert.equal((await exec('git', ['remote'], { cwd: fixture.root })).stdout.trim(), '');
        assert.equal(fixture.errors(), '');
        assert.ok((await fixture.checkpoint()).displayMessages.at(-1)?.toolExecutions?.some(item => item.result.ok));
    }
    finally {
        await fixture.close();
    }
});
test('内置 test 保留 npm 检查失败的退出码及 stdout/stderr', async () => {
    let count = 0;
    const fixture = await runtimeFixture(() => ++count <= 3 ? call('run_command', { command: `npm run ${['lint', 'typecheck', 'build'][count - 1]}` }, `npm-${count}`) : say('typecheck 失败，不能声称检查全部通过'));
    try {
        await fixture.runtime.memory.setEnabled(false);
        await writeFile(path.join(fixture.root, 'package.json'), JSON.stringify({ scripts: { lint: 'node -e "console.log(123)"', typecheck: 'node -e "console.error(456);process.exit(7)"', build: 'node -e "console.log(789)"' } }));

        await fixture.controller.handleLine('/skill run test npm检查');
        const saved = await fixture.checkpoint();
        const tools = saved.displayMessages.at(-1)?.toolExecutions ?? [];
        assert.equal(tools.length, 3);
        assert.ok(tools.some(tool => !tool.result.ok && JSON.stringify(tool.result).includes('"exitCode":7') && JSON.stringify(tool.result).includes('456')));
        assert.ok(JSON.stringify(tools).includes('123'));
        assert.ok(JSON.stringify(tools).includes('789'));
        assert.equal(saved.displayMessages.at(-1)?.verification?.status, 'unverified');
    }
    finally {
        await fixture.close();
    }
});
test('内置 review 可读取授权文件但保持文件内容不变', async () => {
    let count = 0;
    const fixture = await runtimeFixture(() => ++count === 1 ? call('read_file', { path: 'review.txt' }) : say('只读审查完成'));
    try {
        await fixture.runtime.memory.setEnabled(false);
        await writeFile(path.join(fixture.root, 'review.txt'), 'review source');
        await fixture.controller.handleLine('/skill run review review.txt');
        assert.equal(await readFile(path.join(fixture.root, 'review.txt'), 'utf8'), 'review source');
        assert.equal(fixture.errors(), '');
        assert.ok((await fixture.checkpoint()).displayMessages.at(-1)?.toolExecutions?.every(tool => tool.result.sideEffect === 'none'));
    }
    finally {
        await fixture.close();
    }
});
