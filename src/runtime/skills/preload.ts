import { SKILL_SUMMARY_GUIDANCE } from "./execution-summary";
import type { AgentSession } from "@/core/agent-loop";
import type { AgentEvent } from "@/core/agent-events";
import { SkillEventQueue } from "@/core/skills/event-queue";
import type { SkillRunEvent } from "@/core/skills/types";
import type { SkillLoader } from "@/tools/load-skill";
import type { WorkspaceBoundary, ToolExecutionResult } from "@/tools/types";
export function preloadSkill(agent: AgentSession, request: {
    name: string;
    arguments: string;
}, load: SkillLoader, workspace: WorkspaceBoundary, deadlineMs: number): AgentSession {
    return { getHistory: () => agent.getHistory(), async *streamTurn(options): AsyncIterable<AgentEvent> {
            const startedAt = Date.now();
            const controller = new AbortController();
            const signal = AbortSignal.any([options.signal, controller.signal]);
            const queue = new SkillEventQueue<SkillRunEvent | {
                type: "loaded";
                result: ToolExecutionResult;
            }>();
            const execution = load(request, { workspace, signal, deadlineMs, emitSkillEvent: event => signal.aborted ? Promise.resolve() : queue.push(event) }).then(result => queue.push({ type: "loaded", result }));
            let result: ToolExecutionResult | undefined;
            try {
                for (;;) {
                    const event = await queue.next();
                    if (!event)
                        break;
                    if (event.type === "loaded") {
                        result = event.result;
                        break;
                    }
                    yield { ...event, iteration: 1 };
                }
            }
            finally {
                controller.abort();
                queue.close();
                await execution;
            }
            const output = result?.output;
            const summary = typeof output === "object" && output !== null && !Array.isArray(output) && "summary" in output ? String(output.summary) : undefined;
            if (!result || options.signal.aborted || !result.ok && !summary) {
                yield { type: "stopped", reason: options.signal.aborted ? "cancelled" : "agent-error", iterations: 0, durationMs: Date.now() - startedAt, sideEffect: result?.sideEffect ?? "possible", detail: result && !result.ok ? result.error.message : "Skill 调用已取消。" };
                return;
            }
            for await (const event of agent.streamTurn({ ...options, input: `${options.input}${summary ? `\n独立 Skill 的实际结果摘要：\n${summary}\n${SKILL_SUMMARY_GUIDANCE}\n请据此回复，不重复执行。` : ""}` })) {
                if (event.type === "stopped")
                    yield { ...event, durationMs: Date.now() - startedAt, sideEffect: result.sideEffect === "applied" || event.sideEffect === "applied" ? "applied" : result.sideEffect === "possible" || event.sideEffect === "possible" ? "possible" : "none" };
                else
                    yield event;
            }
        } };
}
