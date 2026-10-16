import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgentTurn } from "./run-agent-turn";
import type { AgentStopReason } from "@/core/agent-events";
test("仅正常最终文本和成功保存触发，钩子在清理之后", async () => {
    for (const reason of ["final-response", "cancelled", "agent-error", "max-runtime", "max-iterations"] as const)
        for (const saved of [true, false]) {
            let scheduled = 0, cleaned = false;
            const run = runAgentTurn({ agent: { getHistory: () => [], async *streamTurn() { yield { type: "stopped", reason: reason as AgentStopReason, finalMessage: { role: "assistant", content: "done" }, iterations: 1, durationMs: 1, sideEffect: "none" }; } }, input: "x", mode: "do", modeTurn: 1, signal: new AbortController().signal, persistTurn: async () => saved ? { status: "saved", revision: 1 } : { status: "failed", detail: "disk" }, onFinished: () => { cleaned = true; }, onPersistedTurn: () => { assert.ok(cleaned); scheduled++; } });
            for await (const event of run)
                void event;
            assert.equal(scheduled, reason === "final-response" && saved ? 1 : 0);
        }
});
