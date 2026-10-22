import { ChildExecutionScheduler } from "./child-execution/scheduler";
import { randomUUID } from "node:crypto";
import type { AgentStart, ChildExecutionResult, SubAgentLimits, TaskScope, TaskView, TaskActivity } from "@/core/sub-agents/types";
import { DEFAULT_SUB_AGENT_LIMITS } from "@/core/sub-agents/types";
import { settleTaskResult, TaskPreparationError, type TaskStopReason } from "./task-transitions";
import { WorkspaceAccessError } from "@/tools/types";
import type { ChildTaskContract, ChildTaskSpecification, PreparedChildContextManifest } from "@/core/sub-agents/task-contract";
import { immutableSnapshot } from "@/lib/immutable-snapshot";
import { TaskPhaseTimeline } from "@/core/sub-agents/task-timing";
export type TaskExecution = {
    readonly context?: PreparedChildContextManifest;
    acquire?(signal: AbortSignal): Promise<void>;
    run(signal: AbortSignal): Promise<ChildExecutionResult>;
    close(): Promise<void>;
};
type BackgroundTaskRecord = {
    timing: TaskPhaseTimeline;
    contract: ChildTaskContract;
    prepare?: () => Promise<TaskExecution>;
    preparationStarted: boolean;
    scheduled: boolean;
    finalization?: Promise<void>;
    view: TaskView;
    key: string;
    turnId: string;
    controller: AbortController;
    execution?: TaskExecution;
    timer: ReturnType<typeof setTimeout>;
    frontTimer?: ReturnType<typeof setTimeout>;
    done: Promise<void>;
    finish(): void;
    waiting: Set<() => void>;
};
const same = (a: TaskScope, b: TaskScope) => a.conversationId === b.conversationId && a.lifecycleEpoch === b.lifecycleEpoch;
export class BackgroundTaskManager {
    readonly runtimeId = randomUUID();
    private readonly tasks = new Map<string, BackgroundTaskRecord>();
    private readonly scheduler: ChildExecutionScheduler;
    private preparing = 0;
    private completionSequence = 0;
    private readonly creationCalls = new Map<string, Set<string>>();
    async withForeground<T>(
        signal: AbortSignal,
        action: (signal: AbortSignal) => Promise<T>,
        resources?: { acquire(signal: AbortSignal): Promise<void>; close(): Promise<void> },
    ): Promise<T> {
        const outcome = await this.scheduler.run({
            signal, acquire: resources?.acquire,
            execute: async ownedSignal => {
                await Promise.resolve();
                ownedSignal.throwIfAborted();
                if (this.closed) throw new Error("运行时已关闭。");
                return action(ownedSignal);
            },
            cleanup: resources?.close,
        });
        if (!outcome.result.ok) throw outcome.result.error;
        if (outcome.cleanup === "failed") throw new Error("独立执行资源清理失败。");
        return outcome.result.value;
    }
    private closed = false;
    constructor(private limits: SubAgentLimits = DEFAULT_SUB_AGENT_LIMITS, private readonly now = Date.now, private readonly monotonicNow = () => performance.now()) { this.scheduler = new ChildExecutionScheduler(limits.concurrency); }
    configure(limits: SubAgentLimits) { this.limits = limits; this.scheduler.configure(limits.concurrency); this.pumpPreparation(); }
    list(scope: TaskScope): readonly TaskView[] { return [...this.tasks.values()].filter(r => same(scope, r.view)).map(r => this.snapshot(r)); }
    summary(scope: TaskScope): { readonly count: number; readonly running: number } {
      let count = 0, running = 0;
      for (const { view } of this.tasks.values()) {
        if (!same(scope, view)) continue;
        if (view.state.status !== "terminal") { count++; running++; }
        else if (view.delivery.status !== "committed" && view.delivery.status !== "invalidated") count++;
      }
      return { count, running };
    }
    get(scope: TaskScope, id: string): TaskView { return this.snapshot(this.require(scope, id)); }
    recordAcceptance(scope: TaskScope, id: string, acceptance: import("@/core/sub-agents/output-contract").ChildOutputAssessment): void {
        const record = this.require(scope, id);
        if (record.view.state.status !== "terminal" || record.view.delivery.status === "invalidated" || !record.contract.specification.output) throw new Error("只能验收已结束且声明产物的任务。");
        record.view = { ...record.view, acceptance: immutableSnapshot(acceptance) };
    }
    private snapshot(record: BackgroundTaskRecord): TaskView { return structuredClone({ ...record.view, timing: record.timing.snapshot(), deliveryTiming: record.timing.deliverySnapshot() }); }
    created(scope: TaskScope, turnId: string, callId: string, task?: AgentStart): TaskView | undefined {
        const key = JSON.stringify([scope.conversationId, scope.lifecycleEpoch, turnId, callId]);
        const existing = [...this.tasks.values()].find(record => record.key === key);
        if (existing) {
            if (task && taskIdentity(task) !== taskIdentity(existing.contract.specification.task))
                throw new Error("相同创建调用不能更换任务输入。");
            return this.get(scope, existing.view.id);
        }
        if (this.creationCalls.get(turnKey(scope, turnId))?.has(callId))
            throw new Error("该创建调用已退休，不能重新执行。");
        return undefined;
    }
    async start(input: {
        scope: TaskScope;
        turnId: string;
        callId: string;
        specification: ChildTaskSpecification;
        signal: AbortSignal;
        prepare(contract: ChildTaskContract, signal: AbortSignal): Promise<TaskExecution>;
    }): Promise<TaskView> {
        if (this.closed)
            throw new Error("运行时已关闭。");
        input.signal.throwIfAborted();
        const key = JSON.stringify([input.scope.conversationId, input.scope.lifecycleEpoch, input.turnId, input.callId]);
        const specification = immutableSnapshot(input.specification);
        const task = specification.task;
        const existing = this.created(input.scope, input.turnId, input.callId, task);
        if (existing)
            return existing;
        const calls = this.creationCalls.get(turnKey(input.scope, input.turnId)) ?? new Set<string>();
        if (calls.has(input.callId))
            throw new Error("该创建调用已退休，不能重新执行。");
        this.prune();
        if (this.tasks.size >= this.limits.capacity || calls.size >= this.limits.perTurn)
            throw new Error("子任务数量已达上限。");
        const maxIterations = Math.min(specification.limits.maxIterations, this.limits.maxIterations);
        const maxRuntimeMs = Math.min(specification.limits.maxRuntimeMs, this.limits.maxRuntimeMinutes * 60000);
        if (!Number.isSafeInteger(maxIterations) || maxIterations < 1 || !Number.isSafeInteger(maxRuntimeMs) || maxRuntimeMs < 1) throw new Error("子任务执行预算无效。");
        const timing = new TaskPhaseTimeline(this.monotonicNow);
        const id = randomUUID(), createdAt = this.now(), deadlineAt = createdAt + maxRuntimeMs;
        const contract: ChildTaskContract = immutableSnapshot({ version: 1, taskId: id, scope: input.scope, turnId: input.turnId, callId: input.callId, createdAt, deadlineAt,
            specification: { ...specification, limits: { maxIterations, maxRuntimeMs } } });
        const admission = admissionSummary(contract.specification);
        let finish!: () => void;
        const done = new Promise<void>(resolve => { finish = resolve; });
        const controller = new AbortController();
        const record: BackgroundTaskRecord = { key, turnId: input.turnId, contract, timing,
            prepare: () => input.prepare(contract, controller.signal), preparationStarted: false, scheduled: false,
            controller, done, finish, waiting: new Set(),
            view: { ...contract.scope, admission, activity: [{ type: "created", at: createdAt }], activityOmitted: 0, id, kind: task.kind, role: task.role, background: task.background, createdAt, deadlineAt, maxIterations, workspaceAccess: specification.workspace.access, state: { status: "preparing" }, delivery: { status: "pending" } },
            timer: setTimeout(() => { void this.stop(record, "max-runtime"); }, Math.max(1, deadlineAt - this.now())) };
        this.tasks.set(id, record);
        calls.add(input.callId);
        this.creationCalls.set(turnKey(input.scope, input.turnId), calls);
        // 已退休调用保留有界防重放窗口；活跃任务所属轮次不能被淘汰。
        if (this.creationCalls.size > 1024) {
            const liveTurns = new Set([...this.tasks.values()].map(task => turnKey(task.view, task.turnId)));
            for (const retiredTurn of this.creationCalls.keys()) {
                if (!liveTurns.has(retiredTurn)) {
                    this.creationCalls.delete(retiredTurn);
                    break;
                }
            }
        }
        // ID 发布即接纳；准备失败也属于这个任务，不能删除可见记录或重放副作用。
        if (!record.view.background)
            record.frontTimer = setTimeout(() => this.detach(input.scope, id), this.limits.waitSeconds * 1000);
        this.pumpPreparation();
        return this.get(input.scope, id);
    }
    private pumpPreparation() {
        if (this.closed)
            return;
        for (const record of this.tasks.values()) {
            if (this.preparing >= this.limits.concurrency)
                break;
            if (record.view.state.status !== "preparing" || record.preparationStarted)
                continue;
            record.preparationStarted = true;
            record.timing.enter("preparation");
            this.preparing++;
            void this.prepare(record);
        }
    }
    private async prepare(record: BackgroundTaskRecord) {
        try {
            record.controller.signal.throwIfAborted();
            if (!record.prepare)
                throw new Error("子任务准备入口已释放。");
            record.execution = await record.prepare();
            if (record.execution.context) record.view = { ...record.view, preparedContext: immutableSnapshot(record.execution.context) };
            if (record.controller.signal.aborted) {
                await this.finalize(record, this.failure(record, "cancelled"));
            }
            else {
                record.scheduled = true;
                if (record.execution.acquire) record.timing.enter("resource-wait");
                record.view = { ...record.view, state: { status: record.execution.acquire ? "waiting-resources" : "queued" } };
                void this.execute(record);
            }
        }
        catch (error) {
            await this.finalize(record, {
                ...this.failure(record, "agent-error"),
                failures: [{ tool: "agent", kind: "preparation-failed" }],
                cleanup: error instanceof TaskPreparationError ? error.cleanup : "complete",
            });
        }
        finally {
            record.prepare = undefined;
            this.preparing--;
            this.pumpPreparation();
        }
    }
    async wait(scope: TaskScope, id: string, timeoutMs: number, signal: AbortSignal) {
        const r = this.require(scope, id);
        this.trace(r, "waiting");
        if (r.view.state.status === "terminal")
            return { reason: "finished" as const, task: this.get(scope, id) };
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
            throw new Error("等待时限无效。");
        const reason = await new Promise<"finished" | "detached" | "timeout" | "cancelled">(resolve => {
            let settled = false;
            const finish = (reason: "finished" | "detached" | "timeout" | "cancelled") => { if (settled)
                return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); r.waiting.delete(changed); resolve(reason); };
            const changed = () => finish(r.view.state.status === "terminal" ? "finished" : "detached");
            const abort = () => finish("cancelled");
            const timer = setTimeout(() => finish("timeout"), timeoutMs);
            r.waiting.add(changed);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted)
                abort();
        });
        if (reason !== "finished")
            this.detach(scope, id);
        return { reason, task: this.get(scope, id) };
    }
    detach(scope: TaskScope, id: string) { const r = this.require(scope, id); if (!r.view.background)
        this.trace(r, "detached"); clearTimeout(r.frontTimer); r.view = { ...r.view, background: true }; for (const fn of [...r.waiting])
        fn(); }
    async cancel(scope: TaskScope, id: string) { const r = this.require(scope, id); await this.stop(r, "cancelled"); return this.get(scope, id); }
    pending(scope: TaskScope) { return this.list(scope).filter(t => t.state.status === "terminal" && (t.delivery.status === "pending" || t.delivery.status === "staged")).sort((a, b) => (a.completionSequence ?? 0) - (b.completionSequence ?? 0)); }
    stage(scope: TaskScope, id: string, turnId: string) { const r = this.require(scope, id); if (r.view.state.status === "terminal" && (r.view.delivery.status === "pending" || r.view.delivery.status === "staged")) {
        this.trace(r, "staged");
        r.timing.recordDelivery("staged");
        r.view = { ...r.view, delivery: { status: "staged", turnId } };
    } }
    commit(scope: TaskScope, id: string, revision: number) { const r = this.require(scope, id); if (r.view.state.status !== "terminal" || r.view.delivery.status === "invalidated" || r.view.delivery.status === "committed")
        return; this.trace(r, "committed"); r.timing.recordDelivery("committed"); r.view = { ...r.view, delivery: { status: "committed", revision } }; }
    async invalidate(scope: TaskScope) {
        const records = [...this.tasks.values()].filter(record => same(record.view, scope));
        for (const record of records) {
            this.trace(record, "invalidated");
            record.timing.recordDelivery("invalidated");
            record.view = { ...record.view, delivery: { status: "invalidated" } };
        }
        await Promise.all(records.map(record => this.stop(record, "parent-cleared")));
    }
    async close() {
        this.closed = true;
        const stopped = [...this.tasks.values()].map(record => this.stop(record, "runtime-closed"));
        await Promise.all([...stopped, this.scheduler.close()]);
    }
    private trace(r: BackgroundTaskRecord, type: TaskActivity["type"]) { const activity = [...(r.view.activity ?? []), { type, at: this.now() }]; const extra = Math.max(0, activity.length - 32); r.view = { ...r.view, activity: activity.slice(-32), activityOmitted: (r.view.activityOmitted ?? 0) + extra }; }
    private require(scope: TaskScope, id: string) { const r = this.tasks.get(id); if (!r || !same(scope, r.view))
        throw new Error("任务不存在或无权访问。"); return r; }
    private prune() { for (const [id, r] of this.tasks)
        if (r.view.state.status === "terminal" && (r.view.delivery.status === "committed" || r.view.delivery.status === "invalidated") && (this.tasks.size >= this.limits.capacity || this.now() - r.view.createdAt > 1800000))
            this.tasks.delete(id); }
    private async execute(record: BackgroundTaskRecord) {
        const execution = record.execution;
        if (!execution) { await this.finalize(record, this.failure(record, "agent-error")); return; }
        const outcome = await this.scheduler.run({
            signal: record.controller.signal,
            acquire: execution.acquire?.bind(execution),
            execute: signal => execution.run(signal),
            cleanup: async () => {
                record.timing.enter("cleanup");
                try { await execution.close(); }
                finally { record.timing.enter("finalization"); }
            },
            onQueued: () => {
                record.timing.enter("execution-queue");
                record.view = { ...record.view, state: { status: "queued" } };
            },
            onStart: () => {
                record.timing.enter("execution");
                this.trace(record, "started");
                record.view = { ...record.view, state: { status: "running", startedAt: this.now() } };
            },
        });
        const result: ChildExecutionResult = outcome.result.ok ? outcome.result.value : {
            ...this.failure(record, "agent-error"),
            sideEffect: outcome.started ? "possible" : "none",
            failures: record.controller.signal.aborted ? [] : [{ tool: "agent", kind: outcome.result.error instanceof WorkspaceAccessError ? outcome.result.error.kind : outcome.started ? "execution-failed" : "resource-acquisition-failed" }],
        };
        await this.finalize(record, outcome.cleanup === "failed" ? { ...result, cleanup: "failed" } : result, true);
    }
    private failure(r: BackgroundTaskRecord, reason: ChildExecutionResult["stopReason"]): ChildExecutionResult { return { taskId: r.view.id, stopReason: reason, failures: [], sideEffect: "none", verification: { status: "unverified", checks: [], blockers: [] }, usage: { scope: "self", categories: [] }, cleanup: "complete", truncated: false, evidenceRunId: r.view.id, evidenceLog: "unavailable" }; }
    private finalize(r: BackgroundTaskRecord, result: ChildExecutionResult, alreadyClosed = false): Promise<void> {
        // 在任何异步清理前占有终结权，取消/超时/关闭共享同一完成操作。
        r.finalization ??= Promise.resolve().then(async () => {
            try {
                if (!alreadyClosed) {
                    r.timing.enter("cleanup");
                    try { await r.execution?.close(); }
                    finally { r.timing.enter("finalization"); }
                }
            }
            catch {
                result = { ...result, cleanup: "failed" };
            }
            r.execution = undefined;
            r.prepare = undefined;
            result = settleTaskResult(result, r.view.state);
            clearTimeout(r.timer);
            clearTimeout(r.frontTimer);
            this.trace(r, "terminal");
            r.timing.finish();
            result = { ...result, timing: r.timing.snapshot(), outputContract: r.contract.specification.output };
            r.view = { ...r.view, completionSequence: ++this.completionSequence, state: { status: "terminal", result } };
            for (const changed of [...r.waiting])
                changed();
            r.finish();
        });
        return r.finalization;
    }
    private async stop(r: BackgroundTaskRecord, reason: TaskStopReason) {
        if (r.view.state.status === "terminal")
            return;
        const previous = r.view.state.status;
        if (previous !== "stopping") {
            r.timing.requestStop(reason);
            r.view = { ...r.view, state: { status: "stopping", reason } };
            this.trace(r, "cancel-requested");
            r.controller.abort();
        }
        // 尚未开始准备或已准备完但未运行：管理器可以直接回收。
        // 其余路径由准备/执行协程确认退出后终结，不能用提前返回冒充已停止。
        if ((previous === "queued" && !r.scheduled) || (previous === "preparing" && !r.preparationStarted)) {
            await this.finalize(r, this.failure(r, "cancelled"));
            this.pumpPreparation();
        }
        await r.done;
    }
}
function turnKey(scope: TaskScope, turnId: string): string {
    return JSON.stringify([scope.conversationId, scope.lifecycleEpoch, turnId]);
}
function taskIdentity(task: AgentStart): string {
    return JSON.stringify([task.kind, task.role ?? null, task.prompt, task.background, task.output ?? null]);
}
function admissionSummary(specification: ChildTaskSpecification) {
    const { version, requestBudget, provider, workspace, mode, permissions, tools, requiredExternalTools, role, context, limits, delivery, output } = specification;
    return { version, requestBudget, provider, workspace, mode, permissions, tools, requiredExternalTools, role, context, limits, delivery, ...(output ? { output } : {}) };
}
