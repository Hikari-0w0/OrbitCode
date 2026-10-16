import type { BaseAgentEvent } from "@/core/agent-events";
import type { ToolName } from "@/tools/types";
export type SkillHistory = {
    readonly kind: "none";
} | {
    readonly kind: "all";
} | {
    readonly kind: "recent";
    readonly turns: number;
};
export type SkillDefinition = {
    readonly name: string;
    readonly description: string;
    readonly allowedTools: readonly ToolName[];
    readonly model?: string;
} & ({
    readonly mode: "shared";
} | {
    readonly mode: "isolated";
    readonly history: SkillHistory;
});
export type SkillSource = "project" | "user" | "builtin";
export type ActivatedSkill = {
    readonly definition: SkillDefinition;
    readonly source: SkillSource;
    readonly definitionHash: string;
    readonly resourceRoot: string;
    readonly arguments: string;
    readonly instructions: string;
    readonly resourceHashes: Readonly<Record<string, string>>;
};
export type SkillState = {
    readonly version: 1;
    readonly generation: number;
    readonly active: readonly ActivatedSkill[];
};
export type SkillFailureCode = "invalid-definition" | "invalid-arguments" | "not-found" | "tool-unavailable" | "model-unavailable" | "definition-stale" | "resource-stale" | "boundary-denied" | "capacity" | "busy" | "conflict" | "cancelled" | "execution-failed";
export class SkillError extends Error {
    constructor(readonly code: SkillFailureCode, message: string) { super(message); this.name = "SkillError"; }
}
export type SkillRunEvent = {
    readonly type: "skill-run";
    readonly iteration: number;
    readonly runId: string;
    readonly name: string;
    readonly event: BaseAgentEvent;
};
export const emptySkillState = (): SkillState => ({ version: 1, generation: 0, active: [] });
export function validSkillState(value: unknown): value is SkillState {
    const object = (item: unknown): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item);
    const exact = (item: Record<string, unknown>, fields: readonly string[]) => Object.keys(item).every(key => fields.includes(key));
    if (!object(value) || !exact(value, ["version", "generation", "active"]) || value.version !== 1 || !Number.isSafeInteger(value.generation) || Number(value.generation) < 0 || !Array.isArray(value.active) || value.active.length > 8)
        return false;
    const names = new Set<string>();
    let total = 0;
    for (const item of value.active) {
        if (!object(item) || !exact(item, ["definition", "source", "definitionHash", "resourceRoot", "arguments", "instructions", "resourceHashes"]) || !object(item.definition) || !object(item.resourceHashes))
            return false;
        const definition = item.definition;
        if (!exact(definition, ["name", "description", "allowedTools", "mode", "history", "model"]) || typeof definition.name !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(definition.name) || names.has(definition.name) || typeof definition.description !== "string" || !definition.description.trim() || Array.from(definition.description).length > 200 || /[\r\n]/u.test(definition.description) || !Array.isArray(definition.allowedTools) || definition.allowedTools.length > 64 || definition.allowedTools.some(tool => typeof tool !== "string" || !/^[a-z][A-Za-z0-9_-]{0,127}$/.test(tool)) || new Set(definition.allowedTools).size !== definition.allowedTools.length)
            return false;
        if (definition.model !== undefined && (typeof definition.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(definition.model)))
            return false;
        if (definition.mode === "shared") {
            if (definition.history !== undefined)
                return false;
        }
        else if (definition.mode === "isolated") {
            const history = definition.history;
            if (!object(history) || !exact(history, history.kind === "recent" ? ["kind", "turns"] : ["kind"]) || !["none", "all", "recent"].includes(String(history.kind)) || history.kind === "recent" && (!Number.isInteger(history.turns) || Number(history.turns) < 1 || Number(history.turns) > 50))
                return false;
        }
        else
            return false;
        if (!["project", "user", "builtin"].includes(String(item.source)) || typeof item.definitionHash !== "string" || !/^[a-f0-9]{64}$/.test(item.definitionHash) || typeof item.resourceRoot !== "string" || !item.resourceRoot || item.resourceRoot.length > 4096 || typeof item.arguments !== "string" || new TextEncoder().encode(item.arguments).byteLength > 16 * 1024 || typeof item.instructions !== "string" || !item.instructions.trim() || Object.keys(item.resourceHashes).length > 64)
            return false;
        if (Object.entries(item.resourceHashes).some(([key, hash]) => !key || key.length > 1024 || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)))
            return false;
        names.add(definition.name);
        total += new TextEncoder().encode(item.instructions).byteLength;
    }
    return total <= 128 * 1024;
}
