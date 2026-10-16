import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSkillCatalog } from './catalog';
import { LOCAL_SKILL_TOOLS } from './definition';
test('三个内置样板均严格有效并声明现有工具', async () => {
    const catalog = await loadSkillCatalog({ workspaceRoot: '/nonexistent-workspace', userRoot: '/nonexistent-user' });
    assert.equal(catalog.complete, true);
    assert.deepEqual([...catalog.entries.keys()].sort(), ['commit', 'review', 'test']);
    for (const item of catalog.entries.values())
        for (const name of item.definition.allowedTools)
            assert.ok(LOCAL_SKILL_TOOLS.has(name));
    assert.ok(!catalog.entries.get('review')?.definition.allowedTools.includes('run_command'));
    assert.match(catalog.entries.get('commit')?.body ?? '', /不默认推送/);
});
