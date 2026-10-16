import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { SkillPanel } from './skill-panel';
test('Skill 面板静态呈现列表入口和一致命令，无会话不显示', () => {
    const props = { conversationId: 'conversation', revision: 0, disabled: false, onRun: () => { }, onChanged: async () => { } };
    assert.match(renderToStaticMarkup(<SkillPanel {...props}/>), /刷新 Skill 定义/);
    assert.match(renderToStaticMarkup(<SkillPanel {...props}/>), /\/skill run/);
    assert.equal(renderToStaticMarkup(<SkillPanel {...props} conversationId=""/>), '');
});
