import { SkillError } from "@/core/skills/types";
import { defineTool } from "@/tools/registry";
import { objectSchema, stringSchema } from "@/tools/schema";
import { toolFailure, type ToolExecutionContext, type ToolExecutionResult } from "@/tools/types";
export type SkillLoader = (input: {
    name: string;
    arguments: string;
}, context: ToolExecutionContext) => Promise<ToolExecutionResult>;
export function createLoadSkillTool(load: SkillLoader) {
    return defineTool({
        name: "load_skill", description: "加载 Skill 完整操作指令或执行独立 Skill。先从可用名称和简介选择；参数只作纯文本替换。加载不能放宽模式或权限。",
        inputSchema: objectSchema({ name: stringSchema({ minLength: 1, maxLength: 64, description: "Skill 唯一名称" }), arguments: stringSchema({ maxLength: 16 * 1024, description: "用户参数文本；无参数时传空字符串" }) }),
        mutability: "read-only", scheduling: "barrier", budget: "parent-run",
        permission: { targetKind: "context", resolve: input => ({ kind: "context", reference: `skill:${input.name}` }) },
        async execute(input, context) {
            try {
                return await load(input, context);
            }
            catch (error) {
                return skillFailure(error, context.signal);
            }
        },
    });
}
export function skillFailure(error: unknown, signal?: AbortSignal): ToolExecutionResult {
    if (signal?.aborted)
        return toolFailure("cancelled", "Skill 加载已取消。");
    if (error instanceof SkillError)
        return toolFailure(error.code === "capacity" ? "limit-exceeded" : error.code === "not-found" ? "not-found" : error.code === "tool-unavailable" || error.code === "boundary-denied" ? "permission-denied" : error.code.endsWith("stale") ? "conflict" : "invalid-arguments", `${error.code}: ${error.message}`, { retryable: true });
    return toolFailure("execution-failed", "Skill 加载失败，请检查来源与权限。", { retryable: true });
}
