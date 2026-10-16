import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillToolPolicy } from './skill-policy';
import { ToolRegistry, defineTool, successfulToolResult } from './registry';
import { createModeToolPolicy } from './mode-policy';
import { objectSchema } from './schema';
import type { ActivatedSkill } from '@/core/skills/types';
const active = (tools: ActivatedSkill['definition']['allowedTools']): ActivatedSkill => ({ definition: { name: 'test', description: '简介', mode: 'shared', allowedTools: tools }, source: 'project', definitionHash: 'a'.repeat(64), resourceRoot: '/tmp', arguments: '', instructions: '正文', resourceHashes: {} });
test('白名单交集和父上限同时限制可见及已准备执行，load_skill 唯一豁免', async () => {
    let ran = 0;
    const tool = defineTool({ name: 'read_file', description: '读取', inputSchema: objectSchema({}), mutability: 'read-only', permission: { targetKind: 'context', resolve: () => ({ kind: 'context', reference: 'test' }) }, async execute() { ran++; return successfulToolResult({}); } });
    let skills = [active(['read_file'])];
    const policy = new SkillToolPolicy(createModeToolPolicy(new ToolRegistry([tool]), 'do'), () => skills, new Set(['read_file']));
    const prepared = policy.prepare('read_file', {});
    assert.equal(prepared.kind, 'ready');
    skills = [...skills, active([])];
    assert.equal(policy.definitions().length, 0);
    assert.equal(policy.classify('read_file').kind, 'denied');
    if (prepared.kind === 'ready') {
        const result = await policy.executePrepared(prepared.call, { workspace: {} as never, signal: new AbortController().signal, deadlineMs: Date.now() + 1000 });
        assert.equal(result.ok, false);
    }
    assert.equal(ran, 0);
});
