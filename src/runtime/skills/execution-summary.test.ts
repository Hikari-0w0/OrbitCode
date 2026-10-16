import assert from "node:assert/strict";
import test from "node:test";
import { successfulToolResult } from "@/tools/registry";
import { toolFailure } from "@/tools/types";
import { SkillCommandCalls } from "./execution-summary";

test("命令调用摘要保留未知退出码、超时与拒绝，不把拒绝算成命令执行成功", () => {
    const calls = new SkillCommandCalls();
    calls.record(toolFailure("permission-denied", "消息不得复制到摘要"));
    calls.record({ ...toolFailure("timeout", "超时"), output: { exitCode: null, timedOut: true, cancelled: false, stdout: "不能泄漏输出" } });
    calls.record(successfulToolResult({ exitCode: 0, timedOut: false, cancelled: false }));
    assert.deepEqual(calls.snapshot(), { count: 3, succeeded: 1, failed: 2, omitted: 0, results: [
        { sequence: 1, ok: false, errorKind: "permission-denied" },
        { sequence: 2, ok: false, errorKind: "timeout", exitCode: null, timedOut: true, cancelled: false },
        { sequence: 3, ok: true, exitCode: 0, timedOut: false, cancelled: false },
    ] });
});

test("命令调用摘要截取最近 16 条，仍保留所有调用计数及省略数量", () => {
    const calls = new SkillCommandCalls();
    for (let index = 0; index < 40; index++) calls.record(index % 2 ? toolFailure("cancelled", "取消") : successfulToolResult({ exitCode: 0 }));
    const snapshot = calls.snapshot();
    assert.equal(snapshot.count, 40);
    assert.equal(snapshot.succeeded, 20);
    assert.equal(snapshot.failed, 20);
    assert.equal(snapshot.omitted, 24);
    assert.equal(snapshot.results.length, 16);
    assert.equal(snapshot.results[0].sequence, 25);
    assert.equal(snapshot.results.at(-1)?.sequence, 40);
    snapshot.results.pop();
    assert.equal(calls.snapshot().results.length, 16);
});
