import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFile, writeFile, rm } from "node:fs/promises";
import { runtimeFixture } from "./helpers/runtime-fixture";
import { writeSkill, say, call } from "./helpers/skill-fixture";
import { record } from "@/runtime/skills/definition";
test("两阶段加载、下一迭代工具交集、跨回合保存及停用清空", async () => {
    let count = 0;
    const fixture = await runtimeFixture(() => ++count === 1 ? call('load_skill', { name: 'tight', arguments: '用户参数' }) : say('按流程回复'));
    try {
        const root = await writeSkill(fixture, 'tight', { tools: ['read_file'] });
        await fixture.controller.handleLine('处理请求');
        const first = JSON.stringify(fixture.server.requests[0].body), second = fixture.server.requests[1].body;
        assert.match(first, /tight 简介/);
        assert.doesNotMatch(first, /独特操作正文/);
        assert.match(JSON.stringify(second), /独特操作正文 用户参数/);
        assert.match(JSON.stringify(second), /所有面向用户的过程说明和最终回复都使用中文/);
        assert.ok(record(second));
        assert.ok(Array.isArray(second.tools));
        assert.deepEqual(second.tools.map(tool => record(tool) && record(tool.function) ? tool.function.name : undefined), ['read_file', 'load_skill']);
        const saved = await fixture.checkpoint();
        assert.equal(saved.skills?.active.length, 1);
        await writeFile(path.join(root, 'SKILL.md'), (await readFile(path.join(root, 'SKILL.md'), 'utf8')).replace('独特操作正文', '新版操作正文'));
        await fixture.controller.handleLine('/skills refresh');
        await fixture.controller.handleLine('后续请求');
        assert.match(JSON.stringify(fixture.server.requests.at(-1)?.body), /独特操作正文 用户参数/);
        await fixture.controller.handleLine('/skill deactivate tight');
        assert.equal((await fixture.checkpoint()).skills?.active.length, 0);
        await fixture.controller.handleLine('/skill run tight 新参数');
        assert.match(JSON.stringify(fixture.server.requests.at(-1)?.body), /新版操作正文 新参数/);
        const latest = await fixture.checkpoint();
        await fixture.conversations.clear({ conversationId: latest.summary.id, expectedRevision: latest.summary.revision });
        assert.equal((await fixture.checkpoint()).skills, undefined);
        await rm(root, { recursive: true });
    }
    finally {
        await fixture.close();
    }
});
test("同批次 load_skill 后旧列表中的写工具无法执行", async () => {
    let count = 0;
    const { toolCallDelta, TOOL_FINISH_EVENT, TRANSPORT_DONE_EVENT } = await import('./helpers/openai-mock');
    const fixture = await runtimeFixture(() => ++count === 1 ? { chunks: [{ data: toolCallDelta({ name: 'load_skill', id: 'load', index: 0, argumentsJson: '{"name":"tight","arguments":""}' }) + toolCallDelta({ name: 'write_file', id: 'write', index: 1, argumentsJson: '{"path":"escape.txt","content":"bad"}' }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT }] } : say('受限'));
    try {
        await writeSkill(fixture, 'tight', { tools: [] });
        await fixture.controller.handleLine('/permissions permissive');
        await fixture.controller.handleLine('处理');
        await assert.rejects(readFile(path.join(fixture.root, 'escape.txt')));
        assert.match(fixture.output(), /permission-denied/);
    }
    finally {
        await fixture.close();
    }
});

test('共享 Skill 指令在真实自动和手动上下文压缩后持续保留', async () => {
    let summaries = 0;
    const fixture = await runtimeFixture(request => {
        if (record(request.body) && request.body.tool_choice === 'none') {
            summaries++;
            return say(JSON.stringify({ analysisDraft: '压缩已完成历史', summary: { taskGoals: ['继续任务'], completedWork: ['已完成历史回合'], keyDecisions: [], fileChanges: [], toolResults: [], errors: [], nextSteps: ['继续'] } }));
        }
        return say('历史回复'.repeat(2000));
    }, { context: '      recent_messages_tokens: 100\n      automatic_reserve_tokens: 4000\n' });
    try {
        await writeSkill(fixture, 'persistent', { tools: [] });
        await writeSkill(fixture, 'other', { tools: [], body: 'OTHER_ACTIVE_MARKER {{arguments}}' });
        const config = path.join(fixture.root, 'orbitcode.yaml');
        await writeFile(config, (await readFile(config, 'utf8')).replace('window_tokens: 128000', 'window_tokens: 32000'));
        await fixture.controller.handleLine('/skill run persistent 保留的参数');
        await fixture.controller.handleLine('/skill run other 第二个参数');
        for (let index = 0; index < 10; index++) await fixture.controller.handleLine(`后续问题${index}`);
        assert.ok(summaries > 0, '自动压缩必须实际请求摘要模型');
        const before = summaries;
        await fixture.controller.handleLine('/compress');
        assert.ok(summaries > before, '手动压缩必须实际请求摘要模型');
        await fixture.controller.handleLine('压缩后继续');
        const requests = fixture.server.requests.filter(request => record(request.body) && request.body.tool_choice !== 'none');
        assert.match(JSON.stringify(requests.at(-1)?.body), /独特操作正文 保留的参数/);
        assert.match(JSON.stringify(requests.at(-1)?.body), /OTHER_ACTIVE_MARKER 第二个参数/);
        assert.equal((await fixture.checkpoint()).skills?.active.length, 2);
        assert.equal(fixture.errors(), '');
    } finally { await fixture.close(); }
});
