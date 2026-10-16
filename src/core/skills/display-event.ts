import type { BaseAgentEvent } from "@/core/agent-events";
import type { SkillRunEvent } from "@/core/skills/types";
// 子执行只把工具证据加入展示时间线，不合并模型历史或完成验证状态。
export function skillDisplayEvent(run: SkillRunEvent): BaseAgentEvent | undefined {
    const event = run.event, name = (tool: string) => `Skill ${run.name} / ${tool}`, id = (call: string) => `${run.runId}:${call}`;
    if (event.type === "tool-call")
        return { ...event, iteration: run.iteration, call: { ...event.call, id: id(event.call.id), name: name(event.call.name) } };
    if (event.type === "tool-started" || event.type === "tool-result" || event.type === "permission-requested" || event.type === "permission-resolved")
        return { ...event, iteration: run.iteration, callId: id(event.callId), name: name(event.name) };
    return undefined;
}
