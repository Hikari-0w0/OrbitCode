import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LocalSettingsStore } from '@/lib/local-settings-store';
import { LocalConversationStore } from '@/lib/local-conversation-store';
import { record } from '@/runtime/skills/definition';
import { startOpenAIMockServer } from '../tests/helpers/openai-mock';
import { say, call } from '../tests/helpers/skill-fixture';
const exec = promisify(execFile);
async function main() {
    const project = process.cwd(), root = path.resolve(process.argv[2] ?? `tmp/agent-evals/skill-terminal-${Date.now()}`);
    const workspace = path.join(root, 'workspace'), data = path.join(root, 'data');
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    let sequence = 0, releaseLong = () => { };
    const model = await startOpenAIMockServer(async request => {
        const id = ++sequence;
        await writeFile(path.join(root, `request-${id}.json`), JSON.stringify(request.body, null, 2));
        assert.ok(record(request.body) && Array.isArray(request.body.messages));
        const messages = request.body.messages.filter(record);
        const start = messages.findLastIndex(message => message.role === 'user');
        const user = String(messages[start]?.content ?? '');
        const afterTool = messages.slice(start).some(message => message.role === 'tool');
        if (user.includes('最大循环')) return call('read_file', { path: 'README.md' }, `loop-${id}`);
        if (user.includes('Skill live-independent 已经加载并激活')) {
            if (user.includes('子上限')) return call('read_file', { path: 'README.md' }, `child-loop-${id}`);
            if (user.includes('长运行')) {
                if (!afterTool) return call('start_process', { command: 'sleep 30' }, `process-${id}`);
                await new Promise<void>(resolve => { releaseLong = resolve; });
                return say('迟到响应不应复活已取消执行');
            }
            if (!afterTool) return call('write_file', { path: user.includes('拒绝') ? 'denied.txt' : 'allowed.txt', content: 'CHILD_WRITE_EVIDENCE' }, `child-write-${id}`);
        }
        if (!afterTool) {
            if (user.includes('受限工具')) return call('write_file', { path: 'forbidden.txt', content: '不得写入' }, `forbidden-${id}`);
            if (user.includes('工具失败')) return call('read_file', { path: 'missing.txt' }, `missing-${id}`);
            if (user.includes('无效参数')) return call('read_file', { path: 17 }, `invalid-${id}`);
            if (user.includes('命令非零')) return call('run_command', { command: `node -e "console.log('OUT_9');console.error('ERR_9');process.exit(9)"` }, `nonzero-${id}`);
            if (user.includes('命令超时')) return call('run_command', { command: 'sleep 2', timeout_ms: 100 }, `timeout-${id}`);
            if (user.startsWith('/skill run live-shared')) return call('read_file', { path: 'README.md' }, `read-${id}`);
        }
        return say(afterTool ? '已依据实际工具结果回复，失败及未验证事项保留。' : '主会话已接收结果，本轮完成。');
    });
    await new LocalSettingsStore(data).save(0, { schemaVersion: 1, providers: [{ id: 'fixture', displayName: '本地协议替身', model: 'local-fixture', baseUrl: model.baseUrl, enabled: true, credential: { kind: 'local', value: 'synthetic-terminal-key' }, context: { windowTokens: 128000, singleToolResultTokens: 8000, toolResultGroupTokens: 12000, recentMessagesTokens: 10000, automaticReserveTokens: 13000, manualReserveTokens: 3000, previewChars: 2000 } }], workspaces: [{ id: 'workspace', name: '终端隔离工作区', rootPath: workspace, enabled: true }], mcpServers: [], defaultProviderId: 'fixture', defaultWorkspaceId: 'workspace', maxIterations: 4, defaultPermissionMode: 'strict' });
    await mkdir(path.join(data, 'memory-state-v1'), { recursive: true });
    await writeFile(path.join(data, 'memory-state-v1/settings.json'), '{"enabled":false}');
    await writeFile(path.join(workspace, 'README.md'), 'TERMINAL_READ_EVIDENCE');
    for (const [name, mode, tools, body] of [
        ['live-shared', 'shared', ['read_file'], '读取 README.md：{{arguments}}'],
        ['live-independent', 'isolated', ['read_file', 'write_file', 'start_process'], '按授权执行：{{arguments}}'],
        ['needs-args', 'shared', [], '要求第二个参数 {{arg:2}}'],
    ] as const) {
        const dir = path.join(workspace, '.orbitcode/skills', name); await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} 验证\nallowed-tools: [${tools.join(', ')}]\nmode: ${mode}\n${mode === 'isolated' ? 'history: {kind: none}\n' : ''}---\n${body}`);
    }
    const socket = `orbitcode-skill-${process.pid}`, session = 'acceptance';
    const environment: NodeJS.ProcessEnv = { NODE_ENV: "test" };
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) if (process.env[key]) environment[key] = process.env[key];
    const tmux = (...args: string[]) => exec('tmux', ['-L', socket, ...args], { env: environment, maxBuffer: 4 * 1024 * 1024 });
    const capture = async () => (await tmux('capture-pane', '-p', '-J', '-S', '-20000', '-t', session)).stdout;
    const send = async (text: string) => { await tmux('send-keys', '-t', session, '-l', text); await tmux('send-keys', '-t', session, 'Enter'); };
    const wait = async (condition: () => Promise<boolean>, message: string) => { const deadline = Date.now() + 15000; while (Date.now() < deadline) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error(message); };
    const store = new LocalConversationStore(path.join(data, 'conversations-v1'));
    const approvals = new Set<string>();
    const approve = async (decision: string) => {
        let id: string | undefined;
        await wait(async () => { id = [...(await capture()).matchAll(/\/approve ([\w-]+) </g)].map(match => match[1]).find(value => !approvals.has(value)); return Boolean(id); }, '终端没有收到新审批');
        assert.ok(id); approvals.add(id); await send(`/approve ${id} ${decision}`);
    };
    let conversationId = '', revision = 0;
    const completed = async () => {
        await wait(async () => { const checkpoint = await store.load(conversationId); return checkpoint.summary.revision > revision && (await store.inspectActivity(conversationId)).status === 'idle'; }, '终端回合未正常保存');
        const checkpoint = await store.load(conversationId); revision = checkpoint.summary.revision; return checkpoint;
    };
    const cases: { name: string; revision: number; stopReason?: string }[] = [];
    let managedPid: number | undefined;
    try {
        await tmux('new-session', '-d', '-s', session, '-x', '240', '-y', '70', '-c', project, process.execPath, '--import', path.join(project, 'node_modules/tsx/dist/loader.mjs'), path.join(project, 'src/cli/main.ts'), '--data-dir', data);
        await wait(async () => (await capture()).includes('revision 0'), 'CLI 没有初始化');
        conversationId = (await store.list())[0].id;
        await send('/skills');
        await wait(async () => (await capture()).includes('live-independent'), '没有列出 Skill');
        for (const [argument, decision] of [['审批拒绝', 'deny'], ['审批允许', 'once']]) {
            await send(`/skill run live-independent ${argument}`); await approve(decision);
            const saved = await completed();
            assert.equal(saved.skills?.active.length, 0);
            cases.push({ name: argument, revision, stopReason: saved.summary.lastStopReason });
        }
        await assert.rejects(readFile(path.join(workspace, 'denied.txt')));
        assert.equal(await readFile(path.join(workspace, 'allowed.txt'), 'utf8'), 'CHILD_WRITE_EVIDENCE');
        await send('/skill run live-independent 长运行'); await approve('once');
        await wait(async () => { const matches = [...(await capture()).matchAll(/"pid": (\d+)/g)]; managedPid = Number(matches.at(-1)?.[1]); return Number.isSafeInteger(managedPid) && managedPid > 0; }, '没有获得真实子进程 PID');
        await send('/cancel');
        const cancelled = await completed();
        assert.equal(cancelled.summary.lastStopReason, 'cancelled');
        assert.ok(managedPid); const childPid = managedPid;
        await wait(async () => { try { process.kill(childPid, 0); return false; } catch { return true; } }, '子进程取消后仍存活');
        releaseLong();
        cases.push({ name: '长运行取消并清理进程', revision, stopReason: cancelled.summary.lastStopReason });
        await send('继续'); await completed();
        await send('/permissions permissive');
        for (const [input, errorKind] of [['/skill run no-such-skill', 'not-found'], ['/skill run needs-args only-one', 'invalid-arguments'], ['工具失败', 'not-found'], ['无效参数', 'invalid-arguments'], ['命令非零', 'command-failed'], ['命令超时', 'timeout']]) {
            await send(input); const saved = await completed();
            const last = saved.displayMessages.at(-1);
            const tools = last?.toolExecutions ?? [];
            assert.ok(JSON.stringify(last).includes(errorKind), `${input} 未记录 ${errorKind}`);
            if (input === '命令非零') assert.ok(tools.some(tool => !tool.result.ok && record(tool.result.output) && tool.result.output.exitCode === 9 && String(tool.result.output.stdout).includes('OUT_9') && String(tool.result.output.stderr).includes('ERR_9')));
            if (input === '命令超时') assert.ok(tools.some(tool => record(tool.result.output) && tool.result.output.timedOut === true));
            cases.push({ name: input, revision, stopReason: saved.summary.lastStopReason });
        }
        await send('最大循环'); const maximum = await completed(); assert.equal(maximum.summary.lastStopReason, 'max-iterations'); cases.push({ name: '主循环上限', revision, stopReason: maximum.summary.lastStopReason });
        await send('/skill run live-independent 子上限'); const childMaximum = await completed(); assert.match(JSON.stringify(childMaximum.context), /max-iterations/); cases.push({ name: '子循环上限', revision });
        await send('/skill run live-shared 参数'); await completed();
        await send('受限工具'); const restricted = await completed(); assert.match(JSON.stringify(restricted.displayMessages.at(-1)), /permission-denied/); await assert.rejects(readFile(path.join(workspace, 'forbidden.txt'))); cases.push({ name: '未授权工具', revision });
        const pane = await capture();
        await writeFile(path.join(root, 'tmux.txt'), pane);
        await writeFile(path.join(root, 'result.json'), JSON.stringify({ passed: true, root, conversationId, revision, cases, managedPid, modelRequests: sequence, permissionRequests: approvals.size }, null, 2));
        console.log(JSON.stringify({ passed: true, cases: cases.length, root }));
        await send('/exit');
    } finally {
        releaseLong();
        await tmux('kill-server').catch(() => undefined);
        await model.close();
    }
}
main().catch(error => { console.error(error instanceof Error ? error.message : '终端验证失败'); process.exitCode = 1; });
