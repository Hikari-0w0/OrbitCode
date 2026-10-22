import type { ChildExecutionResult, TaskState } from "@/core/sub-agents/types";
export type TaskStopReason = Extract<TaskState, {
    status: "stopping";
}>["reason"];
export class TaskPreparationError extends Error {
    constructor(readonly cleanup: ChildExecutionResult["cleanup"]) {
        super("子任务准备失败。");
    }
}
// 排队和执行共用停止归因，清理不能覆盖先发生的停止原因或工具副作用。
export function settleTaskResult(result: ChildExecutionResult, state: TaskState): ChildExecutionResult {
    if (state.status !== "stopping")
        return result;
    const { terminationSource: _previous, ...facts } = result;
    void _previous;
    if (state.reason === "max-runtime")
        return { ...facts, stopReason: "max-runtime" };
    return { ...facts, stopReason: "cancelled", terminationSource: state.reason === "runtime-closed" ? "runtime-close" : state.reason === "parent-cleared" ? "parent-cleared" : "user" };
}
