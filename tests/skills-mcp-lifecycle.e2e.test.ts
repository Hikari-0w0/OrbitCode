import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runtimeFixture, waitUntil } from "./helpers/runtime-fixture";
import { configureMcpFixture } from "./helpers/mcp-fixture";
import { writeSkill, say, call } from "./helpers/skill-fixture";
import { mcpToolName } from "@/tools/mcp-tool";

test("子 Skill 结束后父会话沿用同一 MCP 连接，子清理不关闭父租约", async () => {
    let requests = 0, pid: number | undefined;
    const name = mcpToolName("demo", "echo");
    const fixture = await runtimeFixture(() => {
        requests++;
        if (requests === 1) return call("load_skill", { name: "worker", arguments: "" }, "load-child");
        if (requests === 2) return call(name, { text: "CHILD_MCP_RESULT" }, "child-mcp");
        if (requests === 4) return call(name, { text: "PARENT_MCP_RESULT" }, "parent-mcp");
        return say(requests === 3 ? "子完成" : "父完成");
    });
    const mcp = await configureMcpFixture(fixture.root, "stdio");
    const permissions = fixture.permissions.createSession();
    try {
        await writeSkill(fixture, "worker", { mode: "isolated", tools: [name] });
        const checkpoint = await fixture.checkpoint();
        for await (const event of fixture.runtime.streamTurn({ conversationId: checkpoint.summary.id, expectedRevision: checkpoint.summary.revision, permissionSessionId: permissions.id, input: "先子再父调用 MCP", mode: "do", modeTurn: 1, source: "web", signal: new AbortController().signal })) {
            if (event.type === "initialization" && event.event.type === "runtime-permission-requested") fixture.permissions.resolveDecision(permissions.id, event.event.prompt.requestId, "allow-once");
            if (event.type === "agent") {
                const nested = event.event.type === "skill-run" ? event.event.event : event.event;
                if (nested.type === "permission-requested") fixture.permissions.resolveDecision(permissions.id, nested.prompt.requestId, "allow-once");
            }
            if (event.type === "finished") assert.equal(event.stopped.reason, "final-response");
        }
        const methods = (await readFile(mcp.callLog, "utf8")).trim().split("\n").map(line => JSON.parse(line).method);
        assert.equal(methods.filter(method => method === "initialize").length, 1);
        assert.equal(methods.filter(method => method === "tools/call").length, 2);
        assert.match(JSON.stringify(fixture.server.requests[2]?.body), /CHILD_MCP_RESULT/);
        assert.match(JSON.stringify(fixture.server.requests.at(-1)?.body), /PARENT_MCP_RESULT/);
        pid = Number(await readFile(mcp.marker, "utf8"));
        assert.ok(Number.isSafeInteger(pid));
        process.kill(pid, 0);
    } finally { fixture.permissions.closeSession(permissions.id); await fixture.close(); await mcp.close(); }
    assert.ok(pid !== undefined);
    const serverPid = pid;
    await waitUntil(() => { try { process.kill(serverPid, 0); return false; } catch { return true; } });
});
