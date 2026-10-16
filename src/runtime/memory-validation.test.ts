import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCandidate, parseNote, serializeNote } from "./memory-validation";
const candidate = { category: "preference", scope: "project", title: "语言", description: "使用中文", body: "项目使用中文", evidence: [{ kind: "user-stated", messageId: "u1" }] };
test("候选拒绝越权字段、无来源和凭据，Markdown 保留证据", () => {
    const input = { userMessages: new Set(["u1"]), toolCalls: new Set<string>() };
    const note = { ...parseCandidate(candidate, input), id: "n1", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), sources: [{ conversationId: "c", turnId: "t", savedRevision: 1, lifecycleEpoch: "e" }] };
    assert.deepEqual(parseNote(serializeNote(note)), note);
    for (const value of [{ ...candidate, path: "../x" }, { ...candidate, evidence: [{ kind: "user-stated", messageId: "bad" }] }, { ...candidate, body: "api_key=FAKESECRET123" }])
        assert.throws(() => parseCandidate(value, input));
    assert.throws(() => parseCandidate({ ...candidate, scope: "user" }, { ...input, userTexts: new Map([["u1", "本项目中文"]]) }));
    assert.equal(parseCandidate({ ...candidate, scope: "user" }, { ...input, userTexts: new Map([["u1", "以后所有项目都使用中文"]]) }).scope, "user");
    assert.throws(() => parseNote('---\na: &a hi\nb: *a\n---\ntext'));
});

test("四类候选保留证据性质，并拒绝明显进度和孤立日志",()=>{
 const input={userMessages:new Set(["u"]),toolCalls:new Set(["call"]),userTexts:new Map([["u","纠正：项目用中文；参考 https://example.com/docs"]])};
 const base={scope:"project",title:"约定",description:"长期资料",body:"长期约定"};
 const values=[{...base,category:"preference",evidence:[{kind:"user-stated",messageId:"u"}]},{...base,category:"correction",evidence:[{kind:"user-stated",messageId:"u"}]},{...base,category:"project-knowledge",evidence:[{kind:"tool-observed",callId:"call"}]},{...base,category:"reference",evidence:[{kind:"reference-only",source:"https://example.com/docs"}]}];
 for(const value of values)assert.equal(parseCandidate(value,input).category,value.category);
 for(const body of ["当前任务进度：30%","stdout: isolated log"])assert.throws(()=>parseCandidate({...values[0],body},input));
 assert.throws(()=>parseCandidate({...values[2],verified:true},input));
});


test("真实模型纠正协议必须使用 correction 并引用用户纠正依据", () => {
    const input = { userMessages: new Set(["u"]), toolCalls: new Set(["call"]), userTexts: new Map([["u", "纠正此前项目知识，以当前文件为准"]]) };
    const replacement = { category: "project-knowledge", scope: "project", title: "当前标记", description: "文件已更新", body: "当前标记为 MARBLE-93，旧标记已失效。", evidence: [{ kind: "user-stated", messageId: "u" }, { kind: "tool-observed", callId: "call" }], replaces: "existing-note" };
    assert.throws(() => parseCandidate(replacement, input), /仅明确纠正/);
    assert.equal(parseCandidate({ ...replacement, category: "correction" }, input).replaces, "existing-note");
    assert.throws(() => parseCandidate({ ...replacement, category: "correction", evidence: [{ kind: "tool-observed", callId: "call" }] }, input), /缺少明确纠正/);
    assert.throws(() => parseCandidate({ ...replacement, category: "correction", evidence: { kind: "user-stated", messageId: "u" } }, input), /字段无效/);
});

test("偏好问句与读取旧偏好不能作为新的偏好声明", () => {
    const value = { ...candidate, evidence: [{ kind: "user-stated", messageId: "u" }] };
    const input = (text: string) => ({ userMessages: new Set(["u"]), toolCalls: new Set(["old"]), userTexts: new Map([["u", text]]) });
    for (const text of ["我的跨项目总结格式偏好是什么？", "What is my preference?"])
        assert.throws(() => parseCandidate(value, input(text)), /偏好询问/);
    assert.throws(() => parseCandidate({ ...value, evidence: [{ kind: "tool-observed", callId: "old" }] }, input("读取长期笔记")), /新的用户偏好/);
    assert.equal(parseCandidate(value, input("我的格式偏好是什么？请记住：以后使用中文。 ")).category, "preference");
});
