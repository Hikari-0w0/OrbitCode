import path from "node:path";
import { realpath } from "node:fs/promises";
import { SkillError } from "@/core/skills/types";
import { readBounded, within, BoundedFileCapacityError } from "@/lib/bounded-files";
import { isProtectedPath } from "@/tools/protected-paths";
import type { WorkspaceBoundary } from "@/tools/types";
import type { SkillSession } from "./service";
import { hashText } from "./definition";
export class SkillResources {
    constructor(private readonly session: SkillSession, private readonly workspace: WorkspaceBoundary) { }
    target(name: string, resource: string): string {
        const active = this.session.active().find(item => item.definition.name === name);
        if (!active || !resource || resource.includes("\\") || resource.startsWith("/") || resource.split("/").some(part => part === ".." || part === "." || !part))
            throw new SkillError("boundary-denied", "资源必须属于已激活 Skill，使用目录内相对路径。");
        const target = path.resolve(active.resourceRoot, resource);
        if (!within(this.workspace.root, target) || !within(active.resourceRoot, target))
            throw new SkillError("boundary-denied", "附属资源超出授权 Workspace，请放入工作区后使用。");
        const relative = path.relative(this.workspace.root, target).split(path.sep).join("/");
        if (isProtectedPath(relative))
            throw new SkillError("boundary-denied", "资源属于受保护路径。");
        return relative;
    }
    async read(name: string, resource: string, signal: AbortSignal): Promise<{
        content: string;
        path: string;
    }> {
        const relative = this.target(name, resource), active = this.session.active().find(item => item.definition.name === name);
        if (!active)
            throw new SkillError("not-found", "Skill 未激活。");
        const root = await realpath(active.resourceRoot);
        if (root !== active.resourceRoot || !within(await realpath(this.workspace.root), root))
            throw new SkillError("boundary-denied", "资源目录链接越界。");
        const file = await readBounded(root, path.join(root, resource), 128 * 1024, signal).catch(error => {
            if (error instanceof BoundedFileCapacityError) throw new SkillError("capacity", "Skill 单次资源读取超过 128 KiB，请缩小资源后重新读取。");
            throw error;
        });
        const canonicalRelative = path.relative(await realpath(this.workspace.root), file.realPath).split(path.sep).join("/");
        if (isProtectedPath(canonicalRelative))
            throw new SkillError("boundary-denied", "资源链接指向受保护路径。");
        // 并发读取结束时使用最新指纹，避免两个读取各自以旧快照覆盖对方。
        const committed = this.session.active().find(item => item.definition.name === name);
        if (!committed || committed.definitionHash !== active.definitionHash || committed.arguments !== active.arguments) throw new SkillError("resource-stale", "读取期间激活定义发生变化。");
        const hash = hashText(file.content), previous = Object.hasOwn(committed.resourceHashes, resource) ? committed.resourceHashes[resource] : undefined;
        if (previous && previous !== hash)
            throw new SkillError("resource-stale", "已引用资源发生变化，请重新激活。");
        this.session.resourceHash(name, resource, hash);
        return { content: file.content, path: relative };
    }
    async validate(signal: AbortSignal): Promise<void> {
        for (const active of this.session.active())
            for (const [resource, hash] of Object.entries(active.resourceHashes)) {
                this.target(active.definition.name, resource);
                if (await realpath(active.resourceRoot) !== active.resourceRoot || !within(await realpath(this.workspace.root), active.resourceRoot))
                    throw new SkillError("boundary-denied", "资源目录身份变化。");
                const read = await readBounded(active.resourceRoot, path.join(active.resourceRoot, resource), 128 * 1024, signal);
                if (isProtectedPath(path.relative(this.workspace.root, read.realPath).split(path.sep).join("/")))
                    throw new SkillError("boundary-denied", "资源链接指向受保护路径。");
                if (hashText(read.content) !== hash)
                    throw new SkillError("resource-stale", "已引用资源变化，请重新激活。");
            }
    }
}
