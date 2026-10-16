import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoadSkillTool } from './load-skill';
import { SkillError } from '@/core/skills/types';
import { ToolRegistry } from './registry';
import { createModeToolPolicy } from './mode-policy';
test('系统加载工具在 Plan 中可见，无效参数不调用加载器', () => {
    let calls = 0;
    const tool = createLoadSkillTool(async () => { calls++; throw new SkillError('not-found', '不存在'); });
    const access = createModeToolPolicy(new ToolRegistry([tool]), 'plan');
    assert.equal(access.definitions()[0]?.function.name, 'load_skill');
    assert.equal(access.prepare('load_skill', { name: 'sample' }).kind, 'failure');
    assert.equal(calls, 0);
    assert.equal(access.prepare('load_skill', { name: 'sample', arguments: '' }).kind, 'ready');
});
