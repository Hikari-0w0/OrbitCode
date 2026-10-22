import type { Dirent } from "node:fs";
import { isProtectedPath } from "@/tools/protected-paths";
import path from "node:path";
import { opendir, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SkillError, type SkillSource } from "@/core/skills/types";
import { nodeError, readBounded, within } from "@/lib/bounded-files";
import { hashText, parseSkill } from "./definition";
export type SkillCandidate = ReturnType<typeof parseSkill> & {
    readonly source: SkillSource;
    readonly file: string;
    readonly root: string;
    readonly resourceRoot: string;
};
export type SkillDiagnostic = {
    readonly source: SkillSource;
    readonly file: string;
    readonly detail: string;
};
export type SkillCatalog = {
    readonly revision: string;
    readonly entries: ReadonlyMap<string, SkillCandidate>;
    readonly blocked: readonly string[];
    readonly diagnostics: readonly SkillDiagnostic[];
    readonly complete: boolean;
    readonly overridden?: readonly {
        name: string;
        source: SkillSource;
    }[];
};
export function builtinSkillRoot(): string { return process.env.NEXT_RUNTIME ? path.join(process.cwd(), "skills") : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../skills"); }
export async function loadSkillCatalog(input: {
    workspaceRoot: string;
    userRoot: string;
    builtinRoot?: string;
    signal?: AbortSignal;
}): Promise<SkillCatalog> {
    const signal = AbortSignal.any([AbortSignal.timeout(5000), ...(input.signal ? [input.signal] : [])]);
    const entries = new Map<string, SkillCandidate>(), blocked = new Set<string>(), diagnostics: SkillDiagnostic[] = [];
    const overridden: {
        name: string;
        source: SkillSource;
    }[] = [];
    let total = 0, complete = true;
    const sources: readonly [
        SkillSource,
        string
    ][] = [["project", path.join(input.workspaceRoot, ".orbitcode/skills")], ["user", path.join(input.userRoot, "skills")], ["builtin", input.builtinRoot ?? builtinSkillRoot()]];
    for (const [source, root] of sources) {
        const layer = new Map<string, SkillCandidate | undefined>();
        try {
            signal.throwIfAborted();
            const items: Dirent[] = [];
            try {
                const directory = await opendir(/* turbopackIgnore: true */ root);
                for await (const item of directory) {
                    signal.throwIfAborted();
                    if (items.length >= 1024) throw new Error("Skill 来源目录项超过 1024。");
                    items.push(item);
                }
            }
            catch (error) {
                if (nodeError(error, "ENOENT")) continue;
                throw error;
            }
            const canonicalRoot = await realpath(/* turbopackIgnore: true */ root);
            if (source === "project" && !within(await realpath(input.workspaceRoot), canonicalRoot))
                throw new Error("项目 Skill 目录链接越界。");
            if (items.length > 1024)
                throw new Error("Skill 来源目录项超过 1024。");
            const files = items.filter(item => item.isDirectory() || item.isSymbolicLink() || item.name.endsWith(".md")).map(item => path.join(/* turbopackIgnore: true */ root, item.isDirectory() ? path.join(item.name, "SKILL.md") : item.name)).sort();
            if (files.length > 256)
                throw new Error("Skill 来源入口超过 256。");
            for (const file of files) {
                signal.throwIfAborted();
                let name: string | undefined;
                try {
                    const read = await readBounded(canonicalRoot, file, 64 * 1024, signal);
                    if (!within(canonicalRoot, read.realPath)) throw new Error("Skill 来源目录身份变化。");
                    if (isProtectedPath(path.relative(canonicalRoot, read.realPath).split(path.sep).join("/")))
                        throw new Error("入口指向受保护内容。");
                    total += Buffer.byteLength(read.content);
                    if (total > 8 * 1024 * 1024)
                        throw new SkillError("capacity", "入口累计超过 8 MiB。");
                    // 只在 YAML 可完整解析时恢复名称，避免损坏文件误阻断其他定义。
                    try {
                        const { parseDocument } = await import("yaml");
                        const front = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/u.exec(read.content);
                        if (front) {
                            const doc = parseDocument(front[1]);
                            if (!doc.errors.length) {
                                const value: unknown = doc.get("name");
                                if (typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value))
                                    name = value;
                            }
                        }
                    }
                    catch { /* 完整解析负责诊断。 */ }
                    const parsed = parseSkill(read.content);
                    name = parsed.definition.name;
                    if (layer.has(name)) {
                        layer.set(name, undefined);
                        diagnostics.push({ source, file: path.relative(root, file), detail: `同层 Skill 名称重复：${name}` });
                    }
                    else
                        layer.set(name, { ...parsed, source, file, root: canonicalRoot, resourceRoot: path.dirname(read.realPath) });
                }
                catch (error) {
                    if (nodeError(error, "ENOENT") && path.basename(file) === "SKILL.md")
                        continue;
                    if (name)
                        layer.set(name, undefined);
                    diagnostics.push({ source, file: path.relative(root, file), detail: error instanceof SkillError ? error.message : "入口不可读、链接越界或格式错误。" });
                    if (signal.aborted || error instanceof SkillError && error.code === "capacity")
                        throw error;
                }
            }
            for (const [name, candidate] of layer) {
                if (!entries.has(name) && !blocked.has(name)) {
                    if (candidate)
                        entries.set(name, candidate);
                    else
                        blocked.add(name);
                }
                else
                    overridden.push({ name, source });
            }
        }
        catch {
            diagnostics.push({ source, file: ".", detail: "Skill 来源扫描未完成、不可读或超过限制；请修复后刷新。" });
            complete = false;
        }
    }
    const summary = [...entries.values()].map(item => `${item.definition.name}: ${item.definition.description}`).join("\n");
    if (Buffer.byteLength(summary) > 16 * 1024)
        diagnostics.push({ source: "project", file: ".", detail: "全部来源的模型目录摘要超过 16 KiB；不会发送不完整目录，请缩减定义后刷新。" });
    return { revision: hashText(JSON.stringify([Array.from(entries, ([name, item]) => [name, item.source, item.hash]), [...blocked], diagnostics])), entries, blocked: [...blocked], diagnostics, complete, overridden };
}
