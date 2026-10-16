import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { createWorkspaceBoundary } from '@/tools/workspace';
import { LocalContextStore } from '@/lib/local-context-store';
import type { ActivatedSkill } from '@/core/skills/types';
import type { AgentSession } from '@/core/agent-loop';
import { runIsolatedSkill } from './isolated-runner';
import { successfulToolResult } from '@/tools/registry';
import { toolFailure, type ToolExecutionResult } from '@/tools/types';
const activation: ActivatedSkill = { definition: { name: 'worker', description: '简介', mode: 'isolated', history: { kind: 'none' }, allowedTools: [] }, source: 'project', resourceRoot: '/tmp', definitionHash: 'a'.repeat(64), arguments: '', instructions: '操作', resourceHashes: {} };
test('独立调用总 deadline 包括工具等待，超时保留副作用且关闭资源', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-timeout-'));
    try {
        let closed = false;
        const agent: AgentSession = { getHistory: () => [], async *streamTurn({ signal }) { yield { type: 'tool-result', iteration: 1, callId: 'write', name: 'write_file', sequence: 0, result: { ok: true, output: { path: 'written.txt' }, sideEffect: 'applied', meta: { durationMs: 0, truncated: false, truncatedFields: [] } } }; await new Promise<void>(resolve => { if (signal.aborted)
                resolve();
            else
                signal.addEventListener('abort', () => resolve(), { once: true }); }); yield { type: 'stopped', reason: 'cancelled', iterations: 1, durationMs: 20, sideEffect: 'applied' }; } };
        const result = await runIsolatedSkill({ activation, parentId: 'parent', parentHistory: [], parentStore: new LocalContextStore(path.join(root, 'parent')), mode: 'do', context: { workspace: await createWorkspaceBoundary(root), signal: new AbortController().signal, deadlineMs: Date.now() + 80 }, iterations: 32, runLog: { sink: { append: async () => { } }, conversationId: 'parent', providerId: 'p', workspaceId: 'w', revisionBefore: 0 }, create: async (options) => { assert.equal(options.maxIterations, 16); return { agent, close: async () => { closed = true; } }; } });
        assert.equal(result.ok, false);
        assert.equal(result.sideEffect, 'applied');
        assert.match(JSON.stringify(result), /max-runtime/);
        assert.ok(closed);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test('子执行清理失败不可被报告为成功或抹去已应用副作用', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-cleanup-'));
    try {
        const result = await runIsolatedSkill({ activation, parentId: 'parent', parentHistory: [], parentStore: new LocalContextStore(path.join(root, 'parent')), mode: 'do', context: { workspace: await createWorkspaceBoundary(root), signal: new AbortController().signal, deadlineMs: Date.now() + 1000 }, iterations: 4, runLog: { sink: { append: async () => { } }, conversationId: 'parent', providerId: 'p', workspaceId: 'w', revisionBefore: 0 }, create: async () => ({ agent: { getHistory: () => [], async *streamTurn() { yield { type: 'stopped', reason: 'final-response', iterations: 1, durationMs: 1, sideEffect: 'applied', finalMessage: { role: 'assistant', content: '完成' } }; } }, close: async () => { throw new Error('cleanup failed'); } }) });
        assert.equal(result.ok, false);
        assert.equal(result.sideEffect, 'applied');
        assert.match(JSON.stringify(result), /清理失败/);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

for (const [label, prefix] of [['中文', '目录'.repeat(200)], ['JSON 转义', '\u0001'.repeat(200)]]) test(`超长${label}子结果保持 8 KiB 摘要上限和独立运行证据`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-summary-'));
    try {
        let requests = 0;
        const result = await runIsolatedSkill({ activation, parentId: 'parent', parentHistory: [], parentStore: new LocalContextStore(path.join(root, 'parent')), mode: 'do', context: { workspace: await createWorkspaceBoundary(root), signal: new AbortController().signal, deadlineMs: Date.now() + 1000 }, iterations: 4, runLog: { sink: { append: async () => { } }, conversationId: 'parent', providerId: 'p', workspaceId: 'w', revisionBefore: 0 }, create: async () => ({ agent: { getHistory: () => [], async *streamTurn() {
            requests++;
            for (let index = 0; index < 12; index++) yield { type: 'tool-result', iteration: 1, callId: `write-${index}`, name: 'write_file', sequence: index, result: { ok: true, output: { path: `${prefix}/${index}` }, sideEffect: 'applied', meta: { durationMs: 0, truncated: false, truncatedFields: [] } } };
            yield { type: 'stopped', reason: 'final-response', iterations: 1, durationMs: 1, sideEffect: 'applied', finalMessage: { role: 'assistant', content: '最终结果'.repeat(10000) } };
        } }, close: async () => { } }) });
        assert.equal(result.ok, true);
        assert.equal(result.sideEffect, 'applied');
        assert.equal(requests, 1);
        assert.ok(typeof result.output === 'object' && result.output !== null && 'summary' in result.output && typeof result.output.summary === 'string');
        const summary = result.output.summary;
        assert.ok(Buffer.byteLength(summary) <= 8192);
        assert.ok(!summary.includes('\uFFFD'));
        assert.match(summary, /摘要已截断/);
        const header = JSON.parse(summary.split('\n')[0]);
        assert.equal(header.stopReason, 'final-response');
        assert.equal(header.verification, 'unverified');
        assert.equal(header.sideEffect, 'applied');
        assert.equal(header.toolCount, 12);
        assert.equal(header.failures, 0);
        assert.ok(header.runId);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('独立子输入明确当前 Skill 已激活，直接执行且不得再次加载自身', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-active-input-'));
    try {
        const result = await runIsolatedSkill({ activation, parentId: 'parent', parentHistory: [], parentStore: new LocalContextStore(path.join(root, 'parent')), mode: 'do', context: { workspace: await createWorkspaceBoundary(root), signal: new AbortController().signal, deadlineMs: Date.now() + 1000 }, iterations: 4, runLog: { sink: { append: async () => { } }, conversationId: 'parent', providerId: 'p', workspaceId: 'w', revisionBefore: 0 }, create: async () => ({ agent: { getHistory: () => [], async *streamTurn({ input }) {
            assert.match(input, /已经加载并激活/);
            assert.match(input, /activatedSkills/);
            assert.match(input, /不要再次.*load_skill/);
            yield { type: 'stopped', reason: 'final-response', iterations: 1, durationMs: 0, sideEffect: 'none' };
        } }, close: async () => { } }) });
        assert.equal(result.ok, true);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('子最终文本声称三次检查时，运行时仍保留四次命令结果及原始退出码', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-command-facts-'));
    try {
        const result = await runIsolatedSkill({ activation, parentId: 'parent', parentHistory: [], parentStore: new LocalContextStore(path.join(root, 'parent')), mode: 'do', context: { workspace: await createWorkspaceBoundary(root), signal: new AbortController().signal, deadlineMs: Date.now() + 1000 }, iterations: 8, runLog: { sink: { append: async () => { } }, conversationId: 'parent', providerId: 'p', workspaceId: 'w', revisionBefore: 0 }, create: async () => ({ agent: { getHistory: () => [], async *streamTurn() {
            for (const [index, exitCode] of [0, 7, 0, 0].entries()) {
                const result: ToolExecutionResult = exitCode === 0 ? successfulToolResult({ exitCode, stdout: '正文不进入结构化事实', stderr: '' }, 'possible') : { ...toolFailure('command-failed', '失败'), output: { exitCode } };
                yield { type: 'tool-result', iteration: index + 1, callId: `command-${index}`, name: 'run_command', sequence: 0, result };
            }
            yield { type: 'stopped', reason: 'final-response', iterations: 5, durationMs: 1, sideEffect: 'possible', finalMessage: { role: 'assistant', content: '只执行三条检查，记录只有三行。' } };
        } }, close: async () => { } }) });
        assert.ok(result.output && typeof result.output === 'object' && 'summary' in result.output && typeof result.output.summary === 'string');
        const header: unknown = JSON.parse(result.output.summary.split('\n')[0]);
        assert.ok(header && typeof header === 'object' && 'commandCalls' in header);
        assert.deepEqual(header.commandCalls, { count: 4, succeeded: 3, failed: 1, omitted: 0, results: [
            { sequence: 1, ok: true, exitCode: 0 },
            { sequence: 2, ok: false, errorKind: 'command-failed', exitCode: 7 },
            { sequence: 3, ok: true, exitCode: 0 },
            { sequence: 4, ok: true, exitCode: 0 },
        ] });
        assert.ok(!JSON.stringify(header).includes('正文不进入结构化事实'));
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('临时上下文删除失败有明确清理错误，保留副作用且不泄漏后台任务', async context => {
    const fileSystem = await import('node:fs/promises');
    const originalRm = fileSystem.default.rm;
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-cleanup-parent-'));
    let temporary: string | undefined;
    let closed = false;
    const mock = context.mock.method(fileSystem.default, 'rm', async (...args: Parameters<typeof originalRm>) => {
        if (path.basename(String(args[0])).startsWith('orbitcode-skill-')) {
            temporary = String(args[0]);
            throw new Error('注入临时目录删除失败');
        }
        return originalRm(...args);
    });
    try {
        const result = await runIsolatedSkill({ activation, parentId: 'parent', parentHistory: [], parentStore: new LocalContextStore(path.join(root, 'parent')), mode: 'do', context: { workspace: await createWorkspaceBoundary(root), signal: new AbortController().signal, deadlineMs: Date.now() + 1000 }, iterations: 4, runLog: { sink: { append: async () => { } }, conversationId: 'parent', providerId: 'p', workspaceId: 'w', revisionBefore: 0 }, create: async () => ({ agent: { getHistory: () => [], async *streamTurn() { yield { type: 'stopped', reason: 'final-response', iterations: 1, durationMs: 0, sideEffect: 'applied' }; } }, close: async () => { closed = true; } }) });
        assert.ok(closed);
        assert.ok(temporary);
        assert.ok(!result.ok);
        assert.match(result.error.message, /清理失败/);
        assert.equal(result.sideEffect, 'applied');
    } finally { mock.mock.restore(); if (temporary) await originalRm(temporary, { recursive: true, force: true }); await originalRm(root, { recursive: true, force: true }); }
});
