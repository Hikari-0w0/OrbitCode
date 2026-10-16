import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeFixture } from './helpers/runtime-fixture';
import { writeSkill, say, call } from './helpers/skill-fixture';
import { streamAgentResponse } from '@/web/chat-handler';
import { parseWebChatEvents, readWebStream } from '@/web/chat-contract';
import { skillHttp } from '@/web/skill-http';
test('Web SSE 子事件可解码，目录接口不泄露正文，停用采用修订号', async () => {
    const fixture = await runtimeFixture(() => say('完成'));
    const session = fixture.permissions.createSession();
    try {
        await writeSkill(fixture, 'worker', { mode: 'isolated' });
        const checkpoint = await fixture.checkpoint();
        const request = (method = 'GET', body?: unknown) => new Request('http://localhost/api/skills', { method, headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
        const catalog = await skillHttp(request(), checkpoint.summary.id, fixture.runtime);
        assert.equal(catalog.status, 200);
        assert.doesNotMatch(await catalog.text(), /独特操作正文|resourceRoot|allowedTools/);
        assert.equal(fixture.server.requests.length, 0);
        const prepared = await fixture.runtime.prepare({ conversationId: checkpoint.summary.id, expectedRevision: 0, input: '/skill run worker', mode: 'plan', modeTurn: 1, permissionSessionId: session.id, source: 'web', signal: new AbortController().signal });
        const response = streamAgentResponse({ ...prepared, request: request() });
        assert.ok(response.body);
        const events = [];
        for await (const event of parseWebChatEvents(readWebStream(response.body)))
            events.push(event);
        assert.ok(events.some(event => event.type === 'skill-run'));
        assert.equal(events.at(-1)?.type, 'stopped');
        const latest = await fixture.checkpoint();
        assert.equal(latest.skills?.active.length, 0);
        const stale = await skillHttp(request('POST', { action: 'deactivate', name: 'worker', expectedRevision: 0 }), checkpoint.summary.id, fixture.runtime);
        assert.equal(stale.status, 409);
    }
    finally {
        fixture.permissions.closeSession(session.id);
        await fixture.close();
    }
});
test('Web Plan 加载写操作 Skill 不暴露或执行写工具', async () => {
    let count = 0;
    const fixture = await runtimeFixture(() => ++count === 1 ? call('write_file', { path: 'plan.txt', content: 'forbidden' }) : say('受限'));
    const session = fixture.permissions.createSession();
    try {
        await writeSkill(fixture, 'planworker', { tools: ['write_file'] });
        const c = await fixture.checkpoint();
        const prepared = await fixture.runtime.prepare({ conversationId: c.summary.id, expectedRevision: 0, input: '/skill run planworker', mode: 'plan', modeTurn: 1, permissionSessionId: session.id, source: 'web', signal: new AbortController().signal });
        const response = streamAgentResponse({ ...prepared, request: new Request('http://localhost/api/chat') });
        assert.ok(response.body);
        const events = [];
        for await (const event of parseWebChatEvents(readWebStream(response.body)))
            events.push(event);
        assert.ok(events.some(event => event.type === 'tool-result' && !event.result.ok));
    }
    finally {
        fixture.permissions.closeSession(session.id);
        await fixture.close();
    }
});

test('Web 列表选择携带旧目录修订号时拒绝执行且不请求模型', async () => {
    const fixture = await runtimeFixture(() => say('不应调用'));
    const session = fixture.permissions.createSession();
    try {
        await writeSkill(fixture, 'selected');
        const checkpoint = await fixture.checkpoint();
        await assert.rejects(fixture.runtime.prepare({ conversationId: checkpoint.summary.id, expectedRevision: checkpoint.summary.revision, skillCatalogRevision: '0'.repeat(64), input: '/skill run selected', mode: 'do', modeTurn: 1, permissionSessionId: session.id, source: 'web', signal: new AbortController().signal }), /目录已更新/);
        assert.equal(fixture.server.requests.length, 0);
        assert.equal((await fixture.guard.inspect(checkpoint.summary.id)).status, 'idle');
        assert.equal((await fixture.checkpoint()).summary.revision, 0);
    } finally { fixture.permissions.closeSession(session.id); await fixture.close(); }
});
