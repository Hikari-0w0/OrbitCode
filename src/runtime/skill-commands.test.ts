import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSkillCommand } from './skill-commands';
test('命令保留控制词，显式形式支持名称冲突和空格参数', () => {
    assert.deepEqual(parseSkillCommand('/skill run deactivate "a b"'), { kind: 'run', name: 'deactivate', arguments: '"a b"' });
    assert.deepEqual(parseSkillCommand('/skills refresh'), { kind: 'refresh' });
    assert.equal(parseSkillCommand('//skill sample'), undefined);
    assert.equal(parseSkillCommand('/plan'), undefined);
    assert.throws(() => parseSkillCommand('/skill deactivate'));
});
