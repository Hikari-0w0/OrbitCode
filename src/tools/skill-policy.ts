import type { ActivatedSkill } from "@/core/skills/types";
import type { ToolAccess } from "@/tools/mode-policy";
import type { PreparedToolCall, ToolPreparationResult } from "@/tools/registry";
import { toolFailure, type ToolExecutionContext, type ToolExecutionResult } from "@/tools/types";
export class SkillToolPolicy implements ToolAccess {
    constructor(private readonly base: ToolAccess, private readonly active: () => readonly ActivatedSkill[], private readonly parent?: ReadonlySet<string>, private readonly revalidate?: (signal: AbortSignal) => Promise<void>) { }
    private allowed(name: string): boolean { return name === "load_skill" || (!this.parent || this.parent.has(name)) && this.active().every(item => item.definition.allowedTools.some(tool => tool === name)); }
    definitions() { return this.base.definitions().filter(item => this.allowed(item.function.name)); }
    classify(name: string) { const decision = this.base.classify(name); return decision.kind === "allowed" && !this.allowed(name) ? { kind: "denied" as const } : decision; }
    prepare(name: string, args: unknown): ToolPreparationResult { return !this.allowed(name) ? { kind: "failure", result: toolFailure("permission-denied", "Skill 工具白名单不允许此调用。", { retryable: true }) } : this.base.prepare(name, args); }
    async executePrepared(call: PreparedToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult> {
        if (!this.allowed(call.name))
            return toolFailure("permission-denied", "Skill 工具白名单已变化，此调用被拒绝。", { retryable: true });
        if (call.name !== "load_skill") {
            try {
                await this.revalidate?.(context.signal);
            }
            catch {
                return toolFailure("conflict", "Skill 资源已变化，请重新激活。", { retryable: true });
            }
        }
        return this.base.executePrepared(call, context);
    }
    async execute(name: string, args: unknown, context: ToolExecutionContext) { const prepared = this.prepare(name, args); return prepared.kind === "failure" ? prepared.result : this.executePrepared(prepared.call, context); }
}
