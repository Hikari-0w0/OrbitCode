import type { ModelUsageSummary } from "@/models/usage-tracker";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentEvent, AgentMode } from "@/core/agent-events";
import { SkillError, type ActivatedSkill } from "@/core/skills/types";
import { LocalContextStore } from "@/lib/local-context-store";
import type { ManagedContextMessage, ContextStore } from "@/core/context/types";
import type { ToolExecutionContext, ToolExecutionResult } from "@/tools/types";
import { successfulToolResult } from "@/tools/registry";
import { toolFailure } from "@/tools/types";
import { runAgentTurn } from "@/runtime/run-agent-turn";
import type { AgentSession } from "@/core/agent-loop";
import type { RunLogOptions } from "@/runtime/agent-run-tracker";
import { selectSkillHistory } from "./history";
import { SkillCommandCalls, SKILL_SUMMARY_GUIDANCE } from "./execution-summary";
function boundedText(value: string, bytes: number): string {
    return new TextDecoder().decode(Buffer.from(value).subarray(0, bytes), { stream: true });
}
function boundedSummaryLabel(value: string): string {
    const characters = Array.from(boundedText(value, 160));
    // JSON 转义也会占用摘要字节，限制序列化后的标签以保留命令事实的预算。
    while (Buffer.byteLength(JSON.stringify(characters.join(""))) > 162) characters.pop();
    return characters.join("");
}
export async function runIsolatedSkill(input: {
    activation: ActivatedSkill;
    parentId: string;
    parentHistory: readonly ManagedContextMessage[];
    parentStore: ContextStore;
    mode: AgentMode;
    context: ToolExecutionContext;
    iterations: number;
    runLog: RunLogOptions;
    create: (options: {
        id: string;
        store: LocalContextStore;
        history: Awaited<ReturnType<typeof selectSkillHistory>>;
        maxRuntimeMs: number;
        maxIterations: number;
    }) => Promise<{
        agent: AgentSession;
        modelUsage?: () => ModelUsageSummary;
        close: () => Promise<void>;
    }>;
}): Promise<ToolExecutionResult> {
    const runId = randomUUID(), definition = input.activation.definition;
    if (definition.mode !== "isolated")
        return toolFailure("invalid-arguments", "Skill 不是独立模式。");
    const root = await mkdtemp(path.join(os.tmpdir(), "orbitcode-skill-")), store = new LocalContextStore(root);
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(300000, input.context.deadlineMs - Date.now())));
    const signal = AbortSignal.any([input.context.signal, timeout]);
    let child: Awaited<ReturnType<typeof input.create>> | undefined;
    let sideEffect: "none" | "possible" | "applied" = "none";
    let terminal: Extract<AgentEvent, {
        type: "stopped";
    }> | undefined;
    const failures: string[] = [], tools: string[] = [], files: string[] = [], warnings: string[] = [];
    const commandCalls = new SkillCommandCalls();
    let result: ToolExecutionResult = toolFailure("execution-failed", "子执行尚未启动。");
    let cleanupFailed = false;
    try {
        const history = await selectSkillHistory({ messages: input.parentHistory, history: definition.history, parentId: input.parentId, childId: runId, parentStore: input.parentStore, childStore: store, signal });
        child = await input.create({ id: runId, store, history, maxRuntimeMs: Math.max(1, Math.min(300000, input.context.deadlineMs - Date.now())), maxIterations: Math.min(16, input.iterations) });
        for await (const item of runAgentTurn({ agent: child.agent, input: `Skill ${definition.name} 已经加载并激活，完整操作指令在 activatedSkills 中。请直接执行，不要再次调用 load_skill 加载当前 Skill；独立执行中仍禁止递归启动独立 Skill。用户参数：${input.activation.arguments || "（无）"}。历史若含不可用父会话引用，不得尝试访问。`, mode: input.mode, modeTurn: 1, signal, maxRuntimeMs: Math.max(1, Math.min(300000, input.context.deadlineMs - Date.now())), runLog: { ...input.runLog, conversationId: runId, createRunId: () => runId, modelUsage: child.modelUsage } })) {
            if (item.type === "warning") warnings.push(boundedSummaryLabel(item.detail));
            const event = item.type === "agent" ? item.event : item.type === "finished" ? item.stopped : undefined;
            if (!event || event.type === "skill-run")
                continue;
            if (event.type === "tool-started")
                sideEffect = sideEffect === "applied" ? "applied" : "possible";
            if (event.type === "tool-result") {
                if (event.result.sideEffect === "applied")
                    sideEffect = "applied";
                tools.push(`${event.name}: ${event.result.ok ? "成功" : event.result.error.kind}`);
                if (event.name === "run_command") commandCalls.record(event.result);
                if (!event.result.ok)
                    failures.push(event.result.error.kind);
            }
            if (event.type === "tool-result" && event.result.ok && typeof event.result.output === "object" && event.result.output !== null && !Array.isArray(event.result.output) && "path" in event.result.output && typeof event.result.output.path === "string" && files.length < 12)
                files.push(boundedSummaryLabel(event.result.output.path));
            if (event.type === "stopped")
                terminal = event;
            await input.context.emitSkillEvent?.({ type: "skill-run", iteration: 0, runId, name: definition.name, event });
        }
        if (terminal)
            sideEffect = sideEffect === "applied" ? "applied" : terminal.sideEffect;
        const header = { runId, skill: definition.name, stopReason: timeout.aborted && !input.context.signal.aborted ? "max-runtime" : terminal?.reason ?? "agent-error", sideEffect, verification: terminal?.verification?.status ?? "unverified", failures: failures.length, toolCount: tools.length, commandCalls: commandCalls.snapshot(), files, warnings: warnings.slice(0, 3) };
        const details = [SKILL_SUMMARY_GUIDANCE, "工具结果：", ...tools, "子最终回复（模型陈述）：", terminal?.finalMessage?.content ?? terminal?.detail ?? "未取得最终回复"].join("\n");
        const prefix = `${JSON.stringify(header)}\n`, marker = "\n[摘要已截断，查看子运行日志]";
        const budget = Math.max(0, Math.min(6000, 8192 - Buffer.byteLength(prefix) - Buffer.byteLength(marker)));
        const truncated = Buffer.byteLength(details) > budget;
        const summary = `${prefix}${boundedText(details, budget)}${truncated ? marker : ""}`;
        const output = { runId, summary, stopReason: header.stopReason, verification: header.verification, truncated };
        result = header.stopReason === "final-response" ? successfulToolResult(output, sideEffect) : { ...toolFailure(input.context.signal.aborted ? "cancelled" : timeout.aborted ? "timeout" : "execution-failed", `独立 Skill 停止：${header.stopReason}`, { sideEffect, retryable: false }), output };
    }
    catch (error) {
        result = toolFailure(signal.aborted ? "cancelled" : error instanceof SkillError && error.code === "capacity" ? "limit-exceeded" : "execution-failed", error instanceof SkillError ? `${error.code}: ${error.message}` : "独立 Skill 启动或执行失败；不会自动重试。", { sideEffect });
    }
    finally {
        try {
            await child?.close();
        }
        catch {
            cleanupFailed = true;
        }
        try {
            await rm(root, { recursive: true, force: true });
        }
        catch {
            cleanupFailed = true;
        }
    }
    if (cleanupFailed)
        return { ...toolFailure("execution-failed", "子执行已结束，但部分资源清理失败。", { sideEffect }), output: { runId, summary: `子执行资源清理失败，请检查运行记录。副作用：${sideEffect}` } };
    return result;
}
