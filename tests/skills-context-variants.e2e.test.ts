import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { runtimeFixture } from "./helpers/runtime-fixture";
import { writeSkill, say, call } from "./helpers/skill-fixture";
import { createPromptEnvironment } from "@/runtime/prompt-environment";
import { createAgentSession } from "@/runtime/agent-session-factory";
import { OpenAICompatibleProvider } from "@/models/openai-provider";
import { loadSkillCatalog } from "@/runtime/skills/catalog";
import { SkillSession } from "@/runtime/skills/service";
import { SkillResources } from "@/runtime/skills/resources";
import { ToolRegistry, successfulToolResult } from "@/tools/registry";
import { createLoadSkillTool } from "@/tools/load-skill";
import { createWorkspaceBoundary } from "@/tools/workspace";

test("无 ContextManager 的共用装配同样逐迭代更新多个激活，后续回合继续保留", async () => {
    let count = 0;
    const fixture = await runtimeFixture(() => ++count <= 2 ? call("load_skill", { name: count === 1 ? "first" : "second", arguments: count === 1 ? "甲" : "乙" }, `load-${count}`) : say("按两个流程回复"));
    try {
        await writeSkill(fixture, "first", { tools: [], body: "FIRST_INSTRUCTION_514 {{arguments}}" });
        await writeSkill(fixture, "second", { tools: [], body: "SECOND_INSTRUCTION_515 {{arguments}}" });
        const catalog = await loadSkillCatalog({ workspaceRoot: fixture.root, userRoot: path.join(fixture.root, 'user'), builtinRoot: path.join(fixture.root, 'builtin') });
        const skills = new SkillSession(undefined, catalog, { tools: () => new Set(['load_skill']), providerId: 'primary', modelIds: new Set(['primary']) });
        const workspace = await createWorkspaceBoundary(fixture.root);
        const registry = new ToolRegistry([createLoadSkillTool(async (request, context) => {
            const resolved = await skills.resolve(request.name, request.arguments, context.signal);
            skills.activate(resolved.activation);
            return successfulToolResult({ name: request.name });
        })]);
        const agent = createAgentSession({ provider: new OpenAICompatibleProvider({ model: 'test-model', baseUrl: fixture.server.baseUrl, apiKey: 'synthetic-fixture-secret' }), registry, workspace, skills, resources: new SkillResources(skills, workspace), options: { maxIterations: 8, promptEnvironment: createPromptEnvironment({ workspace: { id: "workspace", name: "Workspace" } }) } });
        for await (const event of agent.streamTurn({ input: '使用两个流程', mode: 'do', modeTurn: 1, signal: new AbortController().signal })) if (event.type === 'stopped') assert.equal(event.reason, 'final-response');
        assert.doesNotMatch(JSON.stringify(fixture.server.requests[0]?.body), /FIRST_INSTRUCTION_514|SECOND_INSTRUCTION_515/);
        assert.match(JSON.stringify(fixture.server.requests[1]?.body), /FIRST_INSTRUCTION_514 甲/);
        assert.doesNotMatch(JSON.stringify(fixture.server.requests[1]?.body), /SECOND_INSTRUCTION_515/);
        for await (const event of agent.streamTurn({ input: '继续', mode: 'do', modeTurn: 2, signal: new AbortController().signal })) if (event.type === 'stopped') assert.equal(event.reason, 'final-response');
        const last = JSON.stringify(fixture.server.requests.at(-1)?.body);
        assert.match(last, /FIRST_INSTRUCTION_514 甲/);
        assert.match(last, /SECOND_INSTRUCTION_515 乙/);
        assert.equal(skills.active().length, 2);
    } finally { await fixture.close(); }
});
