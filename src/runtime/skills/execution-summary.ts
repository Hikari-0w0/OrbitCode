import type { ToolErrorKind, ToolExecutionResult } from "@/tools/types";

export const SKILL_SUMMARY_GUIDANCE = "摘要首行是运行时结构化事实；commandCalls 统计 run_command 调用结果，包含失败或被拒绝的调用，不等于 Shell 内子命令次数或文件行数。子最终回复是模型陈述；与结构化事实或实际工具结果冲突时，应指出差异，不照抄。报告须区分首次检查与追加复验，未核实文件最新内容时不要声称其具体行数。";

type CommandCallResult = {
    readonly sequence: number;
    readonly ok: boolean;
    readonly errorKind?: ToolErrorKind;
    readonly exitCode?: number | null;
    readonly timedOut?: boolean;
    readonly cancelled?: boolean;
};

export class SkillCommandCalls {
    private count = 0;
    private succeeded = 0;
    private readonly results: CommandCallResult[] = [];

    record(result: ToolExecutionResult): void {
        this.count++;
        if (result.ok) this.succeeded++;
        const output = result.output;
        const fields = output !== null && typeof output === "object" && !Array.isArray(output) ? output : undefined;
        this.results.push({
            sequence: this.count,
            ok: result.ok,
            ...(!result.ok ? { errorKind: result.error.kind } : {}),
            ...(fields && "exitCode" in fields && (fields.exitCode === null || typeof fields.exitCode === "number" && Number.isSafeInteger(fields.exitCode)) ? { exitCode: fields.exitCode } : {}),
            ...(fields && "timedOut" in fields && typeof fields.timedOut === "boolean" ? { timedOut: fields.timedOut } : {}),
            ...(fields && "cancelled" in fields && typeof fields.cancelled === "boolean" ? { cancelled: fields.cancelled } : {}),
        });
        // 保留最近结果及完整计数，不把命令正文、输出或任意错误消息复制进事实摘要。
        if (this.results.length > 16) this.results.shift();
    }

    snapshot() {
        return { count: this.count, succeeded: this.succeeded, failed: this.count - this.succeeded, omitted: this.count - this.results.length, results: this.results.map(item => ({ ...item })) };
    }
}
