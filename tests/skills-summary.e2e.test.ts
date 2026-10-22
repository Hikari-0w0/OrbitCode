import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture";
import { writeSkill, say, call } from "./helpers/skill-fixture";
import { record } from "@/runtime/skills/definition";

for (const explicit of [true, false]) test(`独立命令事实经${explicit ? "显式预加载" : "模型 load_skill"}进入主请求，未被子错误陈述覆盖`, async () => {
    let count = 0;
    const fixture = await runtimeFixture(() => {
        count++;
        if (!explicit && count === 1) return call("load_skill", { name: "worker", arguments: "" }, "load-child");
        const index = count - (explicit ? 1 : 2);
        if (index < 4) return call("run_command", { command: `node -e "process.exit(${index === 1 ? 7 : 0})"` }, `command-${index}`);
        return say(index === 4 ? "只执行三次，记录只有三行。" : "已核对运行时事实：四次调用。");
    });
    try {
        await writeSkill(fixture, "worker", { mode: "isolated", tools: ["run_command"] });

        await fixture.controller.handleLine(explicit ? "/skill run worker" : "执行 worker 对应流程");
        const child = fixture.server.requests[explicit ? 0 : 1].body;
        assert.match(JSON.stringify(child), /已经加载并激活/);
        assert.match(JSON.stringify(child), /不要再次调用 load_skill/);
        const parent = fixture.server.requests.at(-1)?.body;
        assert.ok(record(parent) && Array.isArray(parent.messages));
        let summary: string | undefined;
        for (const message of parent.messages) {
            if (!record(message) || typeof message.content !== "string") continue;
            const line = message.content.split("\n").find(item => item.startsWith('{"runId":'));
            if (line) summary = line;
            try {
                const payload: unknown = JSON.parse(message.content);
                if (record(payload) && record(payload.output) && typeof payload.output.summary === "string") summary = payload.output.summary.split("\n")[0];
            } catch { /* 普通对话不是 JSON。 */ }
        }
        assert.ok(summary);
        const header: unknown = JSON.parse(summary);
        assert.ok(record(header) && record(header.commandCalls) && Array.isArray(header.commandCalls.results));
        assert.equal(header.commandCalls.count, 4);
        assert.deepEqual(header.commandCalls.results.map(item => record(item) ? item.exitCode : undefined), [0, 7, 0, 0]);
        assert.match(JSON.stringify(parent), /子最终回复（模型陈述）/);
        assert.match(JSON.stringify(parent), /追加复验/);
        assert.match(JSON.stringify(parent), /不等于 Shell 内子命令次数或文件行数/);
        assert.equal((await fixture.checkpoint()).skills?.active.length, 0);
        assert.equal(fixture.errors(), "");
    } finally { await fixture.close(); }
});
