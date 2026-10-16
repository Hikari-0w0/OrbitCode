import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatProvider } from "@/models/provider";
import type { ConversationCheckpoint } from "@/core/conversations/types";
import { extractMemory, buildMemoryInput } from "./memory-extractor";
export function savedFixture(): ConversationCheckpoint { return { schemaVersion: 1, lifecycleEpoch: "e", lastTurn: { turnId: "t", endedAt: new Date().toISOString(), stopReason: "final-response", memoryEligibility: true }, summary: { schemaVersion: 1, id: "c", title: "test", revision: 1, workspaceId: "w", providerId: "p", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, mode: "do", modeTurn: 1, displayMessages: [{ id: "u", role: "user", content: "项目以后使用中文", state: "complete" }, { id: "a", role: "assistant", content: "已记录", state: "complete" }], context: { messages: [], consecutiveSummaryFailures: 0 } }; }
test("无工具提取拒绝伪造来源和工具响应，输入凭据脱敏", async () => {
    const checkpoint = savedFixture();
    const response = [{ category: "preference", scope: "project", title: "语言", description: "中文", body: "本项目中文", evidence: [{ kind: "user-stated", messageId: "u" }] }];
    const provider: ChatProvider = { async *stream(messages, options) { assert.equal(options.toolChoice, "none"); assert.deepEqual(options.tools, []); assert.ok(messages.length === 2); yield { type: "text-delta", text: JSON.stringify(response) }; yield { type: "done", finishReason: "stop" }; } };
    assert.equal((await extractMemory({ provider, checkpoint, secrets: [], windowTokens: 32000, signal: new AbortController().signal })).length, 1);
    assert.ok(!JSON.stringify(buildMemoryInput({ ...checkpoint, displayMessages: [{ ...checkpoint.displayMessages[0], content: "api_key=FAKESENTINEL" }, checkpoint.displayMessages[1]] }, ["FAKESENTINEL"]).messages).includes("FAKESENTINEL"));
    const bad: ChatProvider = { async *stream() { yield { type: "tool-call", call: { id: "x", name: "read_file", argumentsJson: "{}" } }; } };
    await assert.rejects(extractMemory({ provider: bad, checkpoint, secrets: [], windowTokens: 32000, signal: new AbortController().signal }));
});


test("提取网络错误、无效协议和超限输入均安全拒绝且不重试", async () => {
    const checkpoint = savedFixture();
    for (const output of ["invalid JSON", "{}", JSON.stringify(Array.from({ length: 9 }, () => ({}))), "x".repeat(16001)]) {
        let calls = 0;
        const provider: ChatProvider = { async *stream() { calls++; yield { type: "text-delta", text: output }; yield { type: "done", finishReason: "stop" }; } };
        await assert.rejects(extractMemory({ provider, checkpoint, secrets: [], windowTokens: 32000, signal: new AbortController().signal }));
        assert.equal(calls, 1);
    }
    let calls = 0;
    const provider: ChatProvider = { async *stream() { calls++; throw new Error("FAKE_PROVIDER_SECRET"); yield { type: "done", finishReason: "stop" }; } };
    await assert.rejects(extractMemory({ provider, checkpoint, secrets: [], windowTokens: 32000, signal: new AbortController().signal }), error => error instanceof Error && !error.message.includes("FAKE_PROVIDER_SECRET"));
    assert.equal(calls, 1);
    await assert.rejects(extractMemory({ provider, checkpoint: { ...checkpoint, displayMessages: [{ ...checkpoint.displayMessages[0], content: "x".repeat(32001) }, checkpoint.displayMessages[1]] }, secrets: [], windowTokens: 32000, signal: new AbortController().signal }));
    await assert.rejects(extractMemory({ provider, checkpoint, secrets: [], windowTokens: 100, signal: new AbortController().signal }));
    assert.equal(calls, 1);
});

test("只用当前用户与新工具观察提取，旧笔记与助手自述不提供新证据", async () => {
    const { emptyResultMeta } = await import("@/tools/types");
    const cp = savedFixture();
    const checkpoint: ConversationCheckpoint = { ...cp, displayMessages: [cp.displayMessages[0], { ...cp.displayMessages[1], content: "ASSISTANT_ONLY_UNVERIFIED", toolExecutions: [
        { iteration: 1, sequence: 0, callId: "old", name: "read_memory", argumentsJson: "{}", state: "succeeded", result: { ok: true, output: "OLD_MEMORY_ONLY", sideEffect: "none", meta: emptyResultMeta() } },
        { iteration: 1, sequence: 1, callId: "new", name: "read_file", argumentsJson: "{}", state: "succeeded", result: { ok: true, output: "FRESH_FILE_FACT", sideEffect: "none", meta: emptyResultMeta() } },
    ] }] };
    const input = buildMemoryInput(checkpoint, []), serialized = JSON.stringify(input.messages);
    assert.ok(!serialized.includes("ASSISTANT_ONLY_UNVERIFIED"));
    assert.ok(!serialized.includes("OLD_MEMORY_ONLY"));
    assert.ok(serialized.includes("FRESH_FILE_FACT"));
    assert.deepEqual([...input.evidence.toolCalls], ["new"]);
});

test("纠正只允许已提供的项目目标；单条非法候选不拖累其他有效候选", async () => {
    const { parseCandidate } = await import("./memory-validation");
    const cp = savedFixture();
    const checkpoint: ConversationCheckpoint = { ...cp, displayMessages: [{ ...cp.displayMessages[0], content: "纠正：项目使用中文" }, cp.displayMessages[1]] };
    const source = { conversationId: "c", turnId: "t", savedRevision: 1, lifecycleEpoch: "e" };
    const base = { category: "preference" as const, scope: "project" as const, title: "语言", description: "中文", body: "中文", evidence: [{ kind: "user-stated" as const, messageId: "u" }] };
    const projectNote = { ...base, id: "project-note", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), sources: [source] };
    const userNote = { ...projectNote, scope: "user" as const, id: "user-note" };
    const built = buildMemoryInput(checkpoint, [], [userNote, projectNote]);
    assert.deepEqual([...built.evidence.replaceableNotes?.keys() ?? []], ["project-note"]);
    assert.throws(() => parseCandidate({ ...base, category: "correction", replaces: "user-note" }, built.evidence), /同作用域/);
    assert.equal(parseCandidate({ ...base, category: "correction", replaces: "project-note" }, built.evidence).replaces, "project-note");
    let rejected = 0;
    const provider: ChatProvider = { async *stream() { yield { type: "text-delta", text: JSON.stringify([{ ...base, category: "correction", replaces: "user-note" }, base]) }; yield { type: "done", finishReason: "stop" }; } };
    const result = await extractMemory({ provider, checkpoint, secrets: [], existing: [userNote, projectNote], windowTokens: 32000, signal: new AbortController().signal, onRejectedCandidates: count => { rejected = count; } });
    assert.equal(result.length, 1); assert.equal(rejected, 1);
});

test("纯记忆查询零提取请求，新偏好声明仍可提取", async () => {
    const { emptyResultMeta } = await import("@/tools/types");
    const cp = savedFixture();
    const checkpoint: ConversationCheckpoint = { ...cp, displayMessages: [{ ...cp.displayMessages[0], content: "请读取项目知识及纠正记录，当前有效标记是什么？" }, { ...cp.displayMessages[1], toolExecutions: [{ iteration: 1, sequence: 0, callId: "old", name: "read_memory", argumentsJson: "{}", state: "succeeded", result: { ok: true, output: "旧笔记", sideEffect: "none", meta: emptyResultMeta() } }] }] };
    let calls = 0;
    const provider: ChatProvider = { async *stream() { calls++; yield { type: "text-delta", text: "[]" }; yield { type: "done", finishReason: "stop" }; } };
    for (const text of [checkpoint.displayMessages[0].content, "请读取相关长期笔记：当前项目此前记住的真实标记是什么？"]) {
        assert.deepEqual(await extractMemory({ provider, checkpoint: { ...checkpoint, displayMessages: [{ ...checkpoint.displayMessages[0], content: text }, checkpoint.displayMessages[1]] }, secrets: [], windowTokens: 32000, signal: new AbortController().signal }), []);
    }
    assert.equal(calls, 0);
    await extractMemory({ provider, checkpoint: { ...checkpoint, displayMessages: [{ ...checkpoint.displayMessages[0], content: "请读取旧笔记，并记住：今后所有项目使用中文。" }, checkpoint.displayMessages[1]] }, secrets: [], windowTokens: 32000, signal: new AbortController().signal });
    assert.equal(calls, 1);
});
