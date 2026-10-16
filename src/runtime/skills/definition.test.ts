import assert from "node:assert/strict";
import test from "node:test";
import { parseSkill, substituteSkill, argumentWords } from "./definition";
const skill = (front = "name: sample\ndescription: 简介\nallowed-tools: []\nmode: shared", body = "执行 {{arguments}}") => `---\n${front}\n---\n${body}`;
test("严格解析元信息并保留空白名单", () => {
    assert.deepEqual(parseSkill(skill()).definition, { name: "sample", description: "简介", allowedTools: [], mode: "shared" });
    assert.equal(parseSkill('\uFEFF' + skill().replaceAll('\n', '\r\n')).definition.name, "sample");
    for (const front of ["name: bad\nname: again", "name: [bad]", "name: &n sample", "name: sample\ndescription: 简介\nallowed-tools: [unknown]\nmode: shared", "name: sample\ndescription: 简介\nallowed-tools: []\nmode: shared\nhistory: {kind: all}"])
        assert.throws(() => parseSkill(skill(front)));
    assert.throws(() => parseSkill(skill(undefined, " ")));
});
test("参数只替换一次，不做 Shell 展开", () => {
    assert.deepEqual(argumentWords('"a b" c\\ d'), ["a b", "c d"]);
    assert.equal(substituteSkill('{{arguments}} {{arg:1}} \\{{arg:2}}', '"{{arguments}}"'), '"{{arguments}}" {{arguments}} {{arg:2}}');
    assert.equal(substituteSkill('{{arguments}}', '$(touch /tmp/forbidden)'), '$(touch /tmp/forbidden)');
    assert.throws(() => substituteSkill('{{arg:2}}', 'one'));
    assert.throws(() => argumentWords('"bad'));
});

test("所有元信息字段、非法模式、YAML 标签及多文档均严格拒绝", () => {
    const front = 'name: sample\ndescription: 简介\nallowed-tools: []\nmode: shared';
    for (const text of [
        skill(front + '\nunknown: value'),
        skill(front.replace('shared', 'parallel')),
        skill(front.replace('name: sample', 'name: !custom sample')),
        skill(front + '\n...\nname: other'),
        skill(front.replace('allowed-tools: []', 'allowed-tools: [read_file, read_file]')),
        skill(front.replace('description: 简介', 'description: |\n  多行\n  简介')),
        skill(front.replace('name: sample', 'name: 1invalid')),
        skill(front + '\nmodel: https://example.invalid'),
        skill(front.replace('mode: shared', 'mode: isolated\nhistory: {kind: recent, turns: 0}')),
        skill(front.replace('mode: shared', 'mode: isolated\nhistory: {kind: recent, turns: 51}')),
        skill(front.replace('mode: shared', 'mode: isolated\nhistory: {kind: none, turns: 1}')),
    ]) assert.throws(() => parseSkill(text));
    assert.throws(() => parseSkill(skill(front + '\n#' + 'x'.repeat(8192))));
    assert.throws(() => parseSkill(skill(front, 'x'.repeat(64 * 1024))));
    assert.throws(() => substituteSkill('{{arguments}}', '参'.repeat(6000)));
});
