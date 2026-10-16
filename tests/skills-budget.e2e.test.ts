import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { runtimeFixture } from "./helpers/runtime-fixture";
import { writeSkill, say, call } from "./helpers/skill-fixture";

test("同一主回合第 5 次独立调用在创建子模型前被拒绝", async () => {
    let parents = 0, children = 0;
    const fixture = await runtimeFixture(request => {
        if (JSON.stringify(request.body).includes('Skill worker 已经加载并激活，完整操作指令')) { children++; return say("子完成"); }
        if (++parents <= 5) return call("load_skill", { name: "worker", arguments: "" }, `load-${parents}`);
        return say("独立调用次数已达上限，停止继续调用。");
    }, { iterations: "12" });
    try {
        await writeSkill(fixture, "worker", { mode: "isolated", tools: [] });
        await fixture.controller.handleLine("依次调用 worker");
        assert.equal(children, 4);
        assert.equal(parents, 6);
        assert.match(JSON.stringify(fixture.server.requests.at(-1)?.body), /本回合独立 Skill 调用最多 4 次/);
        const logs = await fixture.log.findAllForConversation((await fixture.checkpoint()).summary.id);
        assert.equal(logs.length, 1);
        assert.equal(logs[0].tools.filter(tool => tool.name === "load_skill" && tool.status === "failed").length, 1);
    } finally { await fixture.close(); }
});

test("实际模型窗口不足时拒绝激活，旧状态保留且没有模型请求", async () => {
    const fixture = await runtimeFixture(() => say("不应被调用"), { context: "      automatic_reserve_tokens: 4000\n" });
    try {
        await writeSkill(fixture, "large", { tools: [], body: "{{arguments}}".repeat(8) });
        const config = path.join(fixture.root, "orbitcode.yaml");
        await writeFile(config, (await readFile(config, "utf8")).replace("window_tokens: 128000", "window_tokens: 32000"));
        await fixture.controller.handleLine(`/skill run large ${"参".repeat(4000)}`);
        assert.equal(fixture.server.requests.length, 0);
        assert.equal((await fixture.checkpoint()).skills?.active.length, 0);
        assert.match(fixture.output(), /capacity: 激活指令超过模型上下文预算/);
    } finally { await fixture.close(); }
});
