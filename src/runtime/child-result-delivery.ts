import type { ManagedContextMessage } from "@/core/context/types";
import type { ChildExecutionHandoff, ChildExecutionResult, TaskScope, TaskView } from "@/core/sub-agents/types";
import type { BackgroundTaskManager } from "./background-task-manager";

const MAX_DELIVERY_BYTES = 16000;

function compactHandoff(handoff: ChildExecutionHandoff | undefined): ChildExecutionHandoff | undefined {
  if (!handoff) return undefined;
  const results = handoff.commandCalls.results.slice(-4);
  const paths = handoff.fileWrites.paths.slice(0, 4);
  return {
    ...handoff,
    ...(handoff.reads ? { reads: { ...(handoff.reads.contextSearches ? { contextSearches: handoff.reads.contextSearches } : {}), files: handoff.reads.files.slice(0, 4), matches: handoff.reads.matches.slice(0, 4), omitted: handoff.reads.omitted + Math.max(0, handoff.reads.files.length - 4) + Math.max(0, handoff.reads.matches.length - 4) } } : {}),
    commandCalls: { ...handoff.commandCalls, results, omitted: handoff.commandCalls.omitted + handoff.commandCalls.results.length - results.length },
    fileWrites: { ...handoff.fileWrites, paths, omitted: handoff.fileWrites.omitted + handoff.fileWrites.paths.length - paths.length },
  };
}

function deliveryFacts(taskId: string, result: ChildExecutionResult) {
  return {
    taskId, outputContract: result.outputContract, stopReason: result.stopReason, terminationSource: result.terminationSource, sideEffect: result.sideEffect, timing: result.timing,
    verification: { status: result.verification.status }, cleanup: result.cleanup,
    truncated: true, replyTruncated: true, replyStorage: result.replyStorage,
    evidenceRunId: result.evidenceRunId.slice(0, 128), evidenceLog: result.evidenceLog,
    failureCount: result.failureCount,
  };
}

function minimalHandoff(handoff: ChildExecutionHandoff | undefined) {
  if (!handoff) return undefined;
  return {
    reads: { files: [], matches: [], omitted: (handoff.reads?.omitted ?? 0) + (handoff.reads?.files.length ?? 0) + (handoff.reads?.matches.length ?? 0) + (handoff.reads?.contextSearches?.length ?? 0) },
    fileWrites: { scope: handoff.fileWrites.scope, paths: [], omitted: handoff.fileWrites.omitted + handoff.fileWrites.paths.length },
    commandCalls: {
      ...handoff.commandCalls,
      results: handoff.commandCalls.results.slice(-4).map(({ callId: _callId, ...facts }) => { void _callId; return facts; }),
      omitted: handoff.commandCalls.omitted + Math.max(0, handoff.commandCalls.results.length - 4),
    },
  };
}

function serializeResult(task: TaskView): string {
  if (task.state.status !== "terminal") throw new Error("未结束任务不能投递结果。");
  const result = task.state.result;
  let content = JSON.stringify({ ...result, activity: task.activity, activityOmitted: task.activityOmitted });
  if (Buffer.byteLength(content) <= MAX_DELIVERY_BYTES) return content;
  content = JSON.stringify({ ...deliveryFacts(task.id, result), finalReply: result.finalReply?.slice(0, 512), failures: result.failures.slice(0, 4), handoff: compactHandoff(result.handoff) });
  if (Buffer.byteLength(content) <= MAX_DELIVERY_BYTES) return content;
  // JSON 转义也占字节；极长路径按显式省略处理，命令退出事实和正文取回信息仍保留。
  return JSON.stringify({
    ...deliveryFacts(task.id, result),
    failures: result.failures.slice(0, 4).map(failure => ({ tool: failure.tool.slice(0, 160), kind: failure.kind.slice(0, 80), exitCode: failure.exitCode, timedOut: failure.timedOut })),
    handoff: minimalHandoff(result.handoff),
  });
}

export class ChildResultDelivery {
  private readonly receipts = new Set<string>();
  constructor(private readonly tasks: BackgroundTaskManager, private readonly scope: TaskScope, private readonly turnId: string, existing: readonly string[] = []) {
    const live = new Set(tasks.list(scope).map(task => task.id));
    for (const id of existing) if (live.has(id)) { this.receipts.add(id); tasks.commit(scope, id, 0); }
  }

  consume(): readonly Extract<ManagedContextMessage, { kind: "child-result" }>[] {
    const messages: Extract<ManagedContextMessage, { kind: "child-result" }>[] = [];
    for (const task of this.tasks.pending(this.scope).slice(0, 4)) {
      if (this.receipts.has(task.id) || task.state.status !== "terminal") continue;
      messages.push({ kind: "child-result", taskId: task.id, content: serializeResult(task) });
      this.receipts.add(task.id);
      this.tasks.stage(this.scope, task.id, this.turnId);
    }
    return messages;
  }

  snapshot() {
    const live = new Set(this.tasks.list(this.scope).map(task => task.id));
    return [...this.receipts].filter(id => live.has(id));
  }

  commit(revision: number) {
    const live = new Set(this.tasks.list(this.scope).map(task => task.id));
    for (const id of this.receipts) if (live.has(id)) this.tasks.commit(this.scope, id, revision);
  }
}
