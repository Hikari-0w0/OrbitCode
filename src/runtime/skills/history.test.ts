import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { LocalContextStore } from '@/lib/local-context-store';
import { selectSkillHistory } from './history';
import type { ManagedContextMessage } from '@/core/context/types';
test('历史范围按用户回合截取并把卸载引用复制为子会话专属引用', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-history-'));
    try {
        const parentStore = new LocalContextStore(path.join(root, 'parent')), childStore = new LocalContextStore(path.join(root, 'child'));
        const signal = new AbortController().signal;
        const payload = await parentStore.write({ sessionId: 'parent', content: '原始工具结果', signal });
        const messages: ManagedContextMessage[] = [{ kind: 'user', content: '第一轮' }, { kind: 'assistant', content: '第一轮回复' }, { kind: 'user', content: '第二轮' }, { kind: 'assistant-tool-call', content: null, toolCalls: [{ id: 'tool', name: 'read_file', argumentsJson: '{}' }] }, { kind: 'tool-result', toolCallId: 'tool', payload: { storage: 'offloaded', reference: payload.reference, preview: '预览', originalBytes: 18, estimatedTokens: 6 } }, { kind: 'assistant', content: '第二轮回复' }];
        const base = { messages, parentId: 'parent', childId: 'child', parentStore, childStore, signal };
        assert.deepEqual(await selectSkillHistory({ ...base, history: { kind: 'none' } }), []);
        const recent = await selectSkillHistory({ ...base, history: { kind: 'recent', turns: 1 } });
        assert.equal(recent.length, 4);
        assert.deepEqual(recent[0], messages[2]);
        const tool = recent[2];
        assert.ok(tool.kind === 'tool-result' && tool.payload.storage === 'offloaded');
        assert.notEqual(tool.payload.reference, payload.reference);
        assert.equal((await childStore.read({ sessionId: 'child', reference: tool.payload.reference, offset: 0, limit: 100, signal })).content, '原始工具结果');
        await assert.rejects(childStore.read({ sessionId: 'child', reference: payload.reference, offset: 0, limit: 100, signal }));
        assert.equal((await selectSkillHistory({ ...base, history: { kind: 'all' } })).length, 6);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('recent 历史遇到压缩摘要或回合不足时明确告知，不将摘要冒充最近回合', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-history-summary-'));
    try {
        const parentStore = new LocalContextStore(path.join(root, 'parent')), childStore = new LocalContextStore(path.join(root, 'child'));
        const summary: ManagedContextMessage = { kind: 'summary', summary: { taskGoals: ['压缩任务'], completedWork: ['早期任务'], keyDecisions: [], fileChanges: [], toolResults: [], errors: [], nextSteps: [] } };
        const messages: ManagedContextMessage[] = [summary, { kind: 'user', content: '保留的用户回合' }, { kind: 'assistant', content: '回复' }];
        const base = { messages, parentId: 'parent', childId: 'child', parentStore, childStore, signal: new AbortController().signal };
        const recent = await selectSkillHistory({ ...base, history: { kind: 'recent', turns: 3 } });
        assert.ok(recent.some(message => message.kind === 'boundary' && /已压缩/.test(message.content) && /实际.*1/.test(message.content)));
        assert.ok(!recent.some(message => message.kind === 'summary'));
        assert.deepEqual((await selectSkillHistory({ ...base, history: { kind: 'all' } }))[0], summary);
        await assert.rejects(selectSkillHistory({ ...base, messages: [{ kind: 'tool-result', toolCallId: 'orphan', payload: { storage: 'inline', content: '无配对' } }], history: { kind: 'all' } }));
        await assert.rejects(selectSkillHistory({ ...base, messages: [{ kind: 'assistant-tool-call', content: null, toolCalls: [{ id: 'missing', name: 'read_file', argumentsJson: '{}' }] }], history: { kind: 'all' } }));
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('历史普通消息与卸载内容展开分别触发 1 MiB 边界，不共享父引用', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-history-cap-'));
    try {
        const parentStore = new LocalContextStore(path.join(root, 'parent')), childStore = new LocalContextStore(path.join(root, 'child'));
        const signal = new AbortController().signal;
        const base = { parentId: 'parent', childId: 'child', parentStore, childStore, signal, history: { kind: 'all' as const } };
        await assert.rejects(selectSkillHistory({ ...base, messages: [{ kind: 'user', content: 'x'.repeat(1024 * 1024 + 1) }] }), /超过 1 MiB/);
        const blob = await parentStore.write({ sessionId: 'parent', content: 'x'.repeat(1024 * 1024 + 1), signal });
        await assert.rejects(selectSkillHistory({ ...base, messages: [{ kind: 'assistant-tool-call', content: null, toolCalls: [{ id: 'call', name: 'read_file', argumentsJson: '{}' }] }, { kind: 'tool-result', toolCallId: 'call', payload: { storage: 'offloaded', reference: blob.reference, preview: '预览', originalBytes: 1024 * 1024 + 1, estimatedTokens: 1 } }] }), /超过 1 MiB/);
        const safe = await selectSkillHistory({ ...base, messages: [{ kind: 'user', content: '请读取 context://v1/parent-private-reference' }] });
        assert.ok(!JSON.stringify(safe).includes('context://'));
    } finally { await rm(root, { recursive: true, force: true }); }
});
