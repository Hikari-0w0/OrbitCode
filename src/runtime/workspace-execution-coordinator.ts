import { AsyncLocalStorage } from "node:async_hooks";
import type { WorkspaceWriteCoordinator } from "@/tools/types";
import { WorkspaceAccessError } from "@/tools/types";

export type TaskWorkspaceAccess = "read-only" | "exclusive";
type PermitRequest = {
  readonly access: TaskWorkspaceAccess;
  readonly signal: AbortSignal;
  grant(): void;
  reject(): void;
};
type WorkspaceQueue = {
  readers: number;
  writer: boolean;
  poisoned: boolean;
  readonly waiting: PermitRequest[];
};
export type TaskWorkspaceLease = {
  run<T>(action: () => Promise<T>): Promise<T>;
  release(cleanup: "complete" | "failed"): void;
};
type TaskOwnership = { readonly root: string; readonly access: TaskWorkspaceAccess; active: boolean };

export class WorkspaceExecutionCoordinator implements WorkspaceWriteCoordinator {
  private readonly workspaces = new Map<string, WorkspaceQueue>();
  private readonly ownership = new AsyncLocalStorage<TaskOwnership>();

  acquire(root: string, signal: AbortSignal): Promise<() => void> {
    return this.acquirePermit(root, "exclusive", signal);
  }

  acquireRead(root: string, signal: AbortSignal): Promise<() => void> {
    return this.acquirePermit(root, "read-only", signal);
  }

  createExecutionScope(): WorkspaceWriteCoordinator & { acquireRead(root: string, signal: AbortSignal): Promise<() => void> } {
    const held = new Map<string, { references: number; release: () => void }>();
    const acquire = async (root: string, access: TaskWorkspaceAccess, signal: AbortSignal): Promise<() => void> => {
      signal.throwIfAborted();
      // 独立子任务仍按自己的所有权校验，不能借父轮作用域升级只读许可。
      if (this.ownership.getStore()) return this.acquirePermit(root, access, signal);
      let permit = held.get(root);
      if (!permit && access === "read-only") return this.acquireRead(root, signal);
      if (!permit) {
        const release = await this.acquire(root, signal);
        permit = { references: 0, release };
        held.set(root, permit);
      }
      const owned = permit;
      owned.references++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        // 服务与后续验证命令共享本轮许可，最后一个使用者退出才允许其他任务进入。
        if (--owned.references === 0) {
          held.delete(root);
          owned.release();
        }
      };
    };
    return {
      acquire: (root, signal) => acquire(root, "exclusive", signal),
      acquireRead: (root, signal) => acquire(root, "read-only", signal),
    };
  }

  async acquireTask(root: string, access: TaskWorkspaceAccess, signal: AbortSignal): Promise<TaskWorkspaceLease> {
    if (this.ownership.getStore()) throw new Error("独立任务不能嵌套持有工作区许可。");
    const release = await this.acquirePermit(root, access, signal);
    const owner: TaskOwnership = { root, access, active: true };
    return {
      run: action => {
        if (!owner.active) throw new WorkspaceAccessError("permission-denied", "子任务工作区许可已结束。");
        return this.ownership.run(owner, action);
      },
      release: cleanup => {
        if (!owner.active) return;
        owner.active = false;
        if (cleanup === "failed") {
          const queue = this.workspaces.get(root);
          if (queue) queue.poisoned = true;
        }
        release();
      },
    };
  }

  async runTask<T>(
    root: string,
    access: TaskWorkspaceAccess,
    signal: AbortSignal,
    action: () => Promise<T>,
    cleanup: () => Promise<void>,
  ): Promise<{ readonly value: T; readonly cleanup: "complete" | "failed" }> {
    const lease = await this.acquireTask(root, access, signal);
    let cleanupFailed = false;
    try {
      const value = await lease.run(async () => {
        try { signal.throwIfAborted(); return await action(); }
        finally { try { await cleanup(); } catch { cleanupFailed = true; } }
      });
      return { value, cleanup: cleanupFailed ? "failed" : "complete" };
    } finally { lease.release(cleanupFailed ? "failed" : "complete"); }
  }

  private async acquirePermit(root: string, access: TaskWorkspaceAccess, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    const owner = this.ownership.getStore();
    if (owner) {
      if (!owner.active || owner.root !== root) throw new WorkspaceAccessError("permission-denied", "子任务工作区许可已结束或范围不匹配。");
      if (owner.access === "read-only" && access === "exclusive") throw new WorkspaceAccessError("permission-denied", "只读子任务不能升级工作区写入许可。");
      // 同一任务内的工具与 MCP 初始化复用所有权，避免自己等待自己。
      return () => {};
    }
    let queue = this.workspaces.get(root);
    if (!queue) {
      queue = { readers: 0, writer: false, poisoned: false, waiting: [] };
      this.workspaces.set(root, queue);
    }
    const state = queue;
    if (state.poisoned) throw new WorkspaceAccessError("conflict", "工作区资源清理失败，当前运行时不再接受该工作区操作。");
    return new Promise((resolve, reject) => {
      let released = false;
      const aborted = () => {
        const index = state.waiting.indexOf(request);
        if (index >= 0) state.waiting.splice(index, 1);
        signal.removeEventListener("abort", aborted);
        reject(new Error("工作区许可等待已取消或超时。"));
        this.advance(root, state);
      };
      const request: PermitRequest = {
        access, signal,
        reject: () => {
          signal.removeEventListener("abort", aborted);
          reject(state.poisoned ? new WorkspaceAccessError("conflict", "工作区资源清理失败，当前运行时不再接受该工作区操作。") : new Error("工作区许可等待已取消。"));
        },
        grant: () => {
          signal.removeEventListener("abort", aborted);
          if (access === "exclusive") state.writer = true;
          else state.readers++;
          resolve(() => {
            if (released) return;
            released = true;
            if (access === "exclusive") state.writer = false;
            else state.readers--;
            this.advance(root, state);
          });
        },
      };
      signal.addEventListener("abort", aborted, { once: true });
      state.waiting.push(request);
      this.advance(root, state);
    });
  }

  private advance(root: string, queue: WorkspaceQueue): void {
    if (queue.poisoned) {
      for (const request of queue.waiting.splice(0)) request.reject();
      return;
    }
    if (queue.writer) return;
    while (queue.waiting.length) {
      const next = queue.waiting[0];
      if (next.signal.aborted) { queue.waiting.shift(); next.reject(); continue; }
      if (next.access === "exclusive" && queue.readers > 0) break;
      queue.waiting.shift();
      next.grant();
      // 不允许新读请求越过已排队写者，连续的头部读请求可以并发。
      if (next.access === "exclusive") break;
    }
    if (!queue.writer && !queue.readers && !queue.waiting.length) this.workspaces.delete(root);
  }
}
