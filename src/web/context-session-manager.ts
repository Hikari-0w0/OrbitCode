import { randomUUID } from "node:crypto";

import type { ContextManager } from "@/core/context/context-manager";
import type { ContextCompressionState, ContextStore } from "@/core/context/types";
import type { ChatProvider } from "@/models/provider";
import type { ContextContentReader } from "@/tools/read-context";

export const CONTEXT_SESSION_IDLE_TTL_MS = 30 * 60 * 1_000;

export type ContextSessionBinding = {
  readonly workspace: { readonly id: string; readonly name: string };
  readonly providerId: string;
};

export type ContextSessionSnapshot = {
  readonly id: string;
  readonly binding: ContextSessionBinding;
  readonly activeOperation?: "agent" | "manual-compression";
  readonly compression: ContextCompressionState;
};

export type ContextSessionRuntime = {
  readonly provider: ChatProvider;
  readonly context: ContextManager;
  readonly store: ContextStore;
};

export type ContextOperationHandle = ContextSessionRuntime & {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly readContext: ContextContentReader;
};

export class ContextSessionError extends Error {
  constructor(
    readonly kind:
      | "unknown-session"
      | "session-closed"
      | "binding-mismatch"
      | "operation-active"
      | "operation-mismatch",
    message: string,
  ) {
    super(message);
    this.name = "ContextSessionError";
  }
}

type ContextSession = {
  readonly id: string;
  readonly binding: ContextSessionBinding;
  readonly runtime: ContextSessionRuntime;
  active?: {
    readonly id: string;
    readonly kind: "agent" | "manual-compression";
    readonly controller: AbortController;
  };
  lastActivityAt: number;
  idleTimer?: unknown;
  closed: boolean;
};

export class ContextSessionManager {
  readonly #sessions = new Map<string, ContextSession>();
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #schedule: (callback: () => void, delayMs: number) => unknown;
  readonly #cancelScheduled: (handle: unknown) => void;
  readonly #idleTtlMs: number;

  constructor(options: {
    readonly now?: () => number;
    readonly createId?: () => string;
    readonly schedule?: (callback: () => void, delayMs: number) => unknown;
    readonly cancelScheduled?: (handle: unknown) => void;
    readonly idleTtlMs?: number;
  } = {}) {
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? randomUUID;
    this.#schedule = options.schedule ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return timer;
    });
    this.#cancelScheduled = options.cancelScheduled ?? ((handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
    this.#idleTtlMs = options.idleTtlMs ?? CONTEXT_SESSION_IDLE_TTL_MS;
    if (this.#idleTtlMs <= 0) throw new RangeError("上下文会话 TTL 必须大于零。");
  }

  createSession(input: {
    readonly binding: ContextSessionBinding;
    readonly createRuntime: (sessionId: string) => ContextSessionRuntime;
  }): ContextSessionSnapshot {
    let id = this.#createId();
    while (this.#sessions.has(id)) id = this.#createId();
    const session: ContextSession = {
      id,
      binding: copyBinding(input.binding),
      runtime: input.createRuntime(id),
      lastActivityAt: this.#now(),
      closed: false,
    };
    this.#sessions.set(id, session);
    this.#scheduleIdleExpiry(session);
    return snapshot(session);
  }

  getSession(sessionId: string): ContextSessionSnapshot {
    return snapshot(this.#requireSession(sessionId));
  }

  sessionIds(): ReadonlySet<string> {
    return new Set(this.#sessions.keys());
  }

  beginAgentTurn(
    sessionId: string,
    binding: ContextSessionBinding,
  ): ContextOperationHandle {
    return this.#beginOperation(sessionId, binding, "agent");
  }

  beginManualCompression(sessionId: string): ContextOperationHandle {
    const session = this.#requireSession(sessionId);
    return this.#beginOperation(
      sessionId,
      session.binding,
      "manual-compression",
    );
  }

  finishOperation(sessionId: string, operationId: string): void {
    const session = this.#requireSession(sessionId);
    if (!session.active || session.active.id !== operationId) {
      throw new ContextSessionError(
        "operation-mismatch",
        "上下文会话操作已结束或不匹配。",
      );
    }
    session.active = undefined;
    this.#touch(session);
  }

  async closeSession(sessionId: string): Promise<boolean> {
    const session = this.#sessions.get(sessionId);
    if (!session || session.closed) return false;
    session.closed = true;
    session.active?.controller.abort();
    session.active = undefined;
    if (session.idleTimer !== undefined) {
      this.#cancelScheduled(session.idleTimer);
      session.idleTimer = undefined;
    }
    this.#sessions.delete(sessionId);
    await session.runtime.store.deleteSession(sessionId).catch(() => undefined);
    return true;
  }

  #beginOperation(
    sessionId: string,
    binding: ContextSessionBinding,
    kind: "agent" | "manual-compression",
  ): ContextOperationHandle {
    const session = this.#requireSession(sessionId);
    if (!sameBinding(session.binding, binding)) {
      throw new ContextSessionError(
        "binding-mismatch",
        "上下文会话已绑定到其他 Workspace 或 Provider。",
      );
    }
    if (session.active) {
      throw new ContextSessionError(
        "operation-active",
        "当前上下文会话已有进行中的操作。",
      );
    }
    if (session.idleTimer !== undefined) {
      this.#cancelScheduled(session.idleTimer);
      session.idleTimer = undefined;
    }
    const controller = new AbortController();
    const operationId = this.#createId();
    session.active = { id: operationId, kind, controller };
    session.lastActivityAt = this.#now();
    return {
      id: operationId,
      signal: controller.signal,
      ...session.runtime,
      readContext: (input) => session.runtime.store.read({
        sessionId,
        ...input,
      }),
    };
  }

  #requireSession(sessionId: string): ContextSession {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw new ContextSessionError("unknown-session", "上下文会话不存在或已过期。");
    }
    if (session.closed) {
      throw new ContextSessionError("session-closed", "上下文会话已关闭。");
    }
    return session;
  }

  #touch(session: ContextSession): void {
    session.lastActivityAt = this.#now();
    this.#scheduleIdleExpiry(session);
  }

  #scheduleIdleExpiry(session: ContextSession): void {
    if (session.closed || session.active) return;
    if (session.idleTimer !== undefined) this.#cancelScheduled(session.idleTimer);
    session.idleTimer = this.#schedule(() => {
      if (session.closed || session.active) return;
      const remaining = session.lastActivityAt + this.#idleTtlMs - this.#now();
      if (remaining > 0) {
        session.idleTimer = this.#schedule(() => {
          void this.closeSession(session.id);
        }, remaining);
        return;
      }
      void this.closeSession(session.id);
    }, this.#idleTtlMs);
  }
}

function snapshot(session: ContextSession): ContextSessionSnapshot {
  return {
    id: session.id,
    binding: copyBinding(session.binding),
    activeOperation: session.active?.kind,
    compression: session.runtime.context.snapshot().compression,
  };
}

function copyBinding(binding: ContextSessionBinding): ContextSessionBinding {
  return {
    workspace: { ...binding.workspace },
    providerId: binding.providerId,
  };
}

function sameBinding(
  left: ContextSessionBinding,
  right: ContextSessionBinding,
): boolean {
  return (
    left.providerId === right.providerId &&
    left.workspace.id === right.workspace.id &&
    left.workspace.name === right.workspace.name
  );
}
