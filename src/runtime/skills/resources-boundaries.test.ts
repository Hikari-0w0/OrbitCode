import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadSkillCatalog } from "./catalog";
import { SkillSession } from "./service";
import { SkillResources } from "./resources";
import { createWorkspaceBoundary } from "@/tools/workspace";
import { ToolRegistry } from "@/tools/registry";
import { createReadSkillResourceTool } from "@/tools/read-skill-resource";
import { writeFileTool } from "@/tools/write-file";
import { SkillToolPolicy } from "@/tools/skill-policy";
import { createModeToolPolicy } from "@/tools/mode-policy";
import { PermissionGateway } from "@/tools/permission-gateway";

async function resourceFixture(source: "project" | "user" = "project") {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "skill-resource-boundary-")));
    const project = path.join(root, "workspace"), user = path.join(root, "user");
    const entry = path.join(source === "project" ? path.join(project, ".orbitcode/skills") : path.join(user, "skills"), "example");
    await mkdir(project, { recursive: true }); await mkdir(entry, { recursive: true });
    await writeFile(path.join(entry, "SKILL.md"), "---\nname: example\ndescription: 资源\nallowed-tools: [read_skill_resource, write_file]\nmode: shared\n---\n按资源执行");
    const session = new SkillSession(undefined, await loadSkillCatalog({ workspaceRoot: project, userRoot: user, builtinRoot: path.join(root, "builtin") }), { tools: () => new Set(["read_skill_resource", "write_file"]), providerId: "p", modelIds: new Set(["p"]) });
    const signal = new AbortController().signal;
    session.activate((await session.resolve("example", "", signal)).activation);
    const workspace = await createWorkspaceBoundary(project);
    return { root, entry, session, workspace, signal, resources: new SkillResources(session, workspace), close: () => rm(root, { recursive: true, force: true }) };
}

test("目录型四类资源只读，绝对路径、保护文件和链接不能越过边界", async () => {
    const fixture = await resourceFixture();
    try {
        for (const resource of ["templates/template.md", "examples/example.md", "scripts/check.mjs", "references/guide.md"]) {
            await mkdir(path.dirname(path.join(fixture.entry, resource)), { recursive: true });
            await writeFile(path.join(fixture.entry, resource), "import {writeFileSync} from 'node:fs'; writeFileSync('executed.txt', '不应执行');");
            assert.match((await fixture.resources.read("example", resource, fixture.signal)).content, /不应执行/);
        }
        await assert.rejects(readFile(path.join(fixture.workspace.root, "executed.txt")));
        for (const invalid of ["../outside", "/etc/hosts", "a/../b", "a\\b", "./a", ".env", "private.pem"]) assert.throws(() => fixture.resources.target("example", invalid));
        await writeFile(path.join(fixture.workspace.root, "private.pem"), "SYNTHETIC_PRIVATE_RESOURCE");
        await symlink(path.join(fixture.workspace.root, "private.pem"), path.join(fixture.entry, "link.md"));
        await assert.rejects(fixture.resources.read("example", "link.md", fixture.signal));
        assert.equal(Object.keys(fixture.session.active()[0].resourceHashes).length, 4);
        await fixture.resources.validate(fixture.signal);
    } finally { await fixture.close(); }
});

test("用户级入口可以激活，但不会授予工作区外的附属资源读取权", async () => {
    const fixture = await resourceFixture("user");
    try {
        await writeFile(path.join(fixture.entry, "guide.md"), "USER_SCOPE_MUST_NOT_ESCAPE");
        assert.equal(fixture.session.active().length, 1);
        assert.throws(() => fixture.resources.target("example", "guide.md"), /超出授权 Workspace/);
        assert.deepEqual(fixture.session.active()[0].resourceHashes, {});
    } finally { await fixture.close(); }
});

test("超大资源返回明确的 limit-exceeded，不退化为不明加载错误", async () => {
    const fixture = await resourceFixture();
    try {
        await writeFile(path.join(fixture.entry, "big.md"), "x".repeat(128 * 1024 + 1));
        const registry = new ToolRegistry([createReadSkillResourceTool(fixture.resources)]);
        const result = await registry.execute("read_skill_resource", { name: "example", path: "big.md" }, { workspace: fixture.workspace, signal: fixture.signal, deadlineMs: Date.now() + 1000 });
        assert.ok(!result.ok);
        assert.equal(result.error.kind, "limit-exceeded");
        assert.match(result.error.message, /128 KiB/);
        assert.deepEqual(fixture.session.active()[0].resourceHashes, {});
    } finally { await fixture.close(); }
});

for (const timing of ["before-execution", "after-permission"]) test(`已引用资源在 ${timing} 变化，无需审批仍不能绕过资源复检`, async () => {
    const fixture = await resourceFixture();

    try {
        await writeFile(path.join(fixture.entry, "rules.md"), "原资源");
        await fixture.resources.read("example", "rules.md", fixture.signal);
        const policy = new SkillToolPolicy(createModeToolPolicy(new ToolRegistry([writeFileTool]), "do"), () => fixture.session.active(), undefined, signal => fixture.resources.validate(signal));
        const prepared = policy.prepare("write_file", { path: "not-created.txt", content: "禁止旧资源副作用" });
        assert.equal(prepared.kind, "ready");
        if (prepared.kind !== "ready") throw new Error("准备失败");
        const gateway = new PermissionGateway({ agentMode: "do", permissionMode: () => "strict", workspace: fixture.workspace, loadRules: async () => [] });
        const authorization = await gateway.authorize(prepared.call, "write", fixture.signal);
        assert.equal(authorization.kind, "allowed");
        if (authorization.kind !== "allowed") throw new Error("权限拒绝");
        if (timing === "before-execution") await writeFile(path.join(fixture.entry, "rules.md"), "执行前变更");
        if (timing === "after-permission") await writeFile(path.join(fixture.entry, "rules.md"), "检查后变更");
        const result = await policy.executePrepared(prepared.call, { workspace: fixture.workspace, signal: fixture.signal, deadlineMs: Date.now() + 1000 });
        assert.ok(!result.ok);
        assert.equal(result.error.kind, "conflict");
        await assert.rejects(readFile(path.join(fixture.workspace.root, "not-created.txt")));
    } finally { await fixture.close(); }
});
