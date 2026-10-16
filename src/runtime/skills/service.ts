import { SkillError, emptySkillState, type ActivatedSkill, type SkillState } from "@/core/skills/types";
import type { OptionalPromptContext } from "@/core/system-prompt/types";
import path from "node:path";
import { readBounded } from "@/lib/bounded-files";
import { substituteSkill, hashText } from "./definition";
import type { SkillCandidate, SkillCatalog } from "./catalog";
export class SkillSession {
    private current: SkillState;
    constructor(state: SkillState | undefined, readonly catalog: SkillCatalog, private readonly options: {
        readonly tools: () => ReadonlySet<string>;
        readonly providerId: string;
        readonly modelIds: ReadonlySet<string>;
        readonly validateCapacity?: (active: readonly ActivatedSkill[]) => void;
    }) { this.current = structuredClone(state ?? emptySkillState()); }
    snapshot(): SkillState { return structuredClone(this.current); }
    active(): readonly ActivatedSkill[] { return this.current.active; }
    async resolve(name: string, args: string, signal: AbortSignal): Promise<{
        candidate: SkillCandidate;
        activation: ActivatedSkill;
    }> {
        if (!this.catalog.complete)
            throw new SkillError("invalid-definition", "Skill 来源不完整，请修复诊断并刷新。");
        const candidate = this.catalog.entries.get(name);
        if (!candidate)
            throw new SkillError("not-found", "Skill 不存在或定义被阻断，请查看列表诊断。");
        const text = await readBounded(candidate.root, candidate.file, 64 * 1024, signal);
        if (hashText(text.content) !== candidate.hash)
            throw new SkillError("definition-stale", "Skill 定义已变化，请刷新后重试。");
        const definition = candidate.definition;
        if (definition.model && (!this.options.modelIds.has(definition.model) || definition.mode === "shared" && definition.model !== this.options.providerId))
            throw new SkillError("model-unavailable", "模型配置不可用，或共享 Skill 指定了不同模型；请使用独立模式。");
        const unknown = definition.allowedTools.filter(name => !this.options.tools().has(name));
        if (unknown.length)
            throw new SkillError("tool-unavailable", `Skill 工具不可用或待授权发现：${unknown.join(", ")}`);
        const existing = this.current.active.find(item => item.definition.name === name && item.definitionHash === candidate.hash && item.arguments === args && item.resourceRoot === candidate.resourceRoot);
        let resourceHashes: ActivatedSkill["resourceHashes"] = {};
        if (existing) {
            try {
                for (const [relative, hash] of Object.entries(existing.resourceHashes)) {
                    if (relative.split("/").some(part => part === ".." || !part) || path.isAbsolute(relative))
                        throw new SkillError("boundary-denied", "资源路径无效。");
                    const resource = await readBounded(candidate.resourceRoot, path.join(candidate.resourceRoot, relative), 128 * 1024, signal);
                    if (hashText(resource.content) !== hash)
                        throw new SkillError("resource-stale", "资源已变化。");
                }
                resourceHashes = existing.resourceHashes;
            }
            catch {
                signal.throwIfAborted();
            }
        }
        const activation: ActivatedSkill = { definition, source: candidate.source, definitionHash: candidate.hash, resourceRoot: candidate.resourceRoot, arguments: args, instructions: substituteSkill(candidate.body, args), resourceHashes };
        this.checkCapacity(definition.mode === "shared" ? [...this.current.active.filter(item => item.definition.name !== name), activation] : [activation]);
        return { candidate, activation };
    }
    activate(activation: ActivatedSkill): void {
        if (JSON.stringify(this.current.active.find(item => item.definition.name === activation.definition.name)) === JSON.stringify(activation))
            return;
        const active = [...this.current.active.filter(item => item.definition.name !== activation.definition.name), activation];
        this.checkCapacity(active);
        this.current = { version: 1, generation: this.current.generation + 1, active };
    }
    deactivate(name: string): void {
        const active = this.current.active.filter(item => item.definition.name !== name);
        if (active.length !== this.current.active.length)
            this.current = { version: 1, generation: this.current.generation + 1, active };
    }
    resourceHash(name: string, path: string, hash: string): void {
        const active = this.current.active.map(item => item.definition.name !== name ? item : { ...item, resourceHashes: { ...item.resourceHashes, [path]: hash } });
        if (active.some(item => Object.keys(item.resourceHashes).length > 64))
            throw new SkillError("capacity", "已引用资源超过 64 个。");
        this.current = { ...this.current, active };
    }
    prompt(base: OptionalPromptContext): OptionalPromptContext {
        const listing = [...this.catalog.entries.values()].map(item => `${item.definition.name}: ${item.definition.description}`).join("\n");
        const instructions = this.current.active.map(item => `Skill ${item.definition.name}（已经加载并激活，模式：${item.definition.mode}；直接执行当前指令，不要再次加载自身）\n${item.instructions}`).join("\n\n");
        return { ...base, ...(listing && Buffer.byteLength(listing) <= 16 * 1024 ? { availableSkills: listing } : {}), ...(instructions ? { activatedSkills: instructions } : { activatedSkills: undefined }) };
    }
    private checkCapacity(active: readonly ActivatedSkill[]): void {
        if (active.some(item => !item.instructions.trim()))
            throw new SkillError("invalid-arguments", "替换后 Skill 指令不能为空。");
        if (active.length > 8 || Buffer.byteLength(active.map(item => item.instructions).join("\n\n")) > 128 * 1024)
            throw new SkillError("capacity", "Skill 激活数量或指令总量超过限制。");
        this.options.validateCapacity?.(active);
    }
}
