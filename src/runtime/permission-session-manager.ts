import { randomUUID } from "node:crypto";

import type {
  PermissionApprovalBroker,
  PermissionApprovalHandle,
  PermissionApprovalOutcome,
  PermissionApprovalRequest,
  PermissionUserDecision,
} from "@/core/permissions/approval";
import type {
  PermissionMode,
  PermissionSubject,
} from "@/core/permissions/types";
import {
  permissionRisk,
  permissionTargetValue,
} from "@/core/permissions/types";

export const PERMISSION_APPROVAL_TTL_MS = 5 * 60 * 1_000;
export const PERMISSION_SESSION_IDLE_TTL_MS = 30 * 60 * 1_000;

const MAX_RESOLVED_REQUESTS = 16;

export type PermissionSessionWorkspace = {
  readonly id: string;
  readonly name: string;
};

export type PermissionSessionBinding = {
  readonly workspace: PermissionSessionWorkspace;
  readonly providerId: string;
};

export type PermissionSessionSnapshot = {
  readonly id: string;
  readonly mode: PermissionMode;
  readonly binding?: PermissionSessionBinding;
  readonly activeTurn: boolean;
  readonly pendingRequestId?: string;
};

export type PermissionTurnHandle = {
  readonly id: string;
  readonly broker: PermissionApprovalBroker;
};

export class PermissionSessionError extends Error {
  constructor(
    readonly kind:
      | "unknown-session"
      | "session-closed"
      | "binding-mismatch"
      | "turn-active"
      | "turn-mismatch"
      | "approval-pending"
      | "unknown-request",
    message: string,
  ) {
    super(message);
    this.name = "PermissionSessionError";
  }
}

export type PermissionSessionManagerOptions = {
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly schedule?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelScheduled?: (handle: unknown) => void;
  readonly approvalTtlMs?: number;
  readonly sessionIdleTtlMs?: number;
};

type PendingApproval = {
  readonly requestId: string;
  readonly turnId: string;
  readonly subjectKey: string;
  readonly fingerprint: string;
  readonly abortSignal: AbortSignal;
  readonly abortListener: () => void;
  readonly timer: unknown;
  readonly resolve: (outcome: PermissionApprovalOutcome) => void;
};

type PermissionSession = {
  readonly id: string;
  mode: PermissionMode;
  binding?: PermissionSessionBinding;
  activeTurnId?: string;
  pending?: PendingApproval;
  readonly sessionGrants: Set<string>;
  readonly resolvedRequestIds: string[];
  lastActivityAt: number;
  idleTimer?: unknown;
  closed: boolean;
};

export class PermissionSessionManager {
  readonly #sessions = new Map<string, PermissionSession>();
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #schedule: (callback: () => void, delayMs: number) => unknown;
  readonly #cancelScheduled: (handle: unknown) => void;
  readonly #approvalTtlMs: number;
  readonly #sessionIdleTtlMs: number;

  constructor({
    now = Date.now,
    createId = randomUUID,
    schedule = defaultSchedule,
    cancelScheduled = defaultCancelScheduled,
    approvalTtlMs = PERMISSION_APPROVAL_TTL_MS,
    sessionIdleTtlMs = PERMISSION_SESSION_IDLE_TTL_MS,
  }: PermissionSessionManagerOptions = {}) {
    if (approvalTtlMs <= 0 || sessionIdleTtlMs <= 0) {
      throw new RangeError("权限等待与会话 TTL 必须大于零。");
    }
    this.#now = now;
    this.#createId = createId;
    this.#schedule = schedule;
    this.#cancelScheduled = cancelScheduled;
    this.#approvalTtlMs = approvalTtlMs;
    this.#sessionIdleTtlMs = sessionIdleTtlMs;
  }

  createSession(): PermissionSessionSnapshot {
    let id = this.#createId();
    while (this.#sessions.has(id)) id = this.#createId();
    const session: PermissionSession = {
      id,
      mode: "default",
      sessionGrants: new Set(),
      resolvedRequestIds: [],
      lastActivityAt: this.#now(),
      closed: false,
    };
    this.#sessions.set(id, session);
    this.#scheduleIdleExpiry(session);
    return snapshot(session);
  }

  getSession(sessionId: string): PermissionSessionSnapshot {
    return snapshot(this.#requireSession(sessionId));
  }

  setMode(sessionId: string, mode: PermissionMode): PermissionSessionSnapshot {
    const session = this.#requireSession(sessionId);
    session.mode = mode;
    this.#touch(session);
    return snapshot(session);
  }

  bindSession(
    sessionId: string,
    binding: PermissionSessionBinding,
  ): PermissionSessionSnapshot {
    const session = this.#requireSession(sessionId);
    if (session.binding && !sameBinding(session.binding, binding)) {
      throw new PermissionSessionError(
        "binding-mismatch",
        "权限会话已绑定到其他 Workspace 或 Provider。",
      );
    }
    session.binding ??= copyBinding(binding);
    this.#touch(session);
    return snapshot(session);
  }

  beginTurn(
    sessionId: string,
    binding: PermissionSessionBinding,
  ): PermissionTurnHandle {
    const session = this.#requireSession(sessionId);
    this.bindSession(sessionId, binding);
    if (session.activeTurnId) {
      throw new PermissionSessionError(
        "turn-active",
        "当前权限会话已有正在运行的 Agent 轮次。",
      );
    }
    const turnId = this.#createId();
    session.activeTurnId = turnId;
    this.#touch(session);
    return {
      id: turnId,
      broker: this.#createBroker(sessionId, turnId),
    };
  }

  finishTurn(sessionId: string, turnId: string): void {
    const session = this.#requireSession(sessionId);
    this.#assertTurn(session, turnId);
    if (session.pending) this.#settlePending(session, "cancelled");
    session.activeTurnId = undefined;
    this.#touch(session);
  }

  resolveDecision(
    sessionId: string,
    requestId: string,
    decision: PermissionUserDecision,
  ): PermissionApprovalOutcome {
    const session = this.#requireSession(sessionId);
    const pending = session.pending;
    if (!pending || pending.requestId !== requestId) {
      throw new PermissionSessionError(
        "unknown-request",
        "授权请求不存在、已结束或不属于当前会话。",
      );
    }

    const outcome = decisionOutcome(decision);
    if (decision === "allow-session") {
      session.sessionGrants.add(pending.subjectKey);
    }
    this.#settlePending(session, outcome);
    this.#touch(session);
    return outcome;
  }

  closeSession(sessionId: string): boolean {
    const session = this.#sessions.get(sessionId);
    if (!session || session.closed) return false;
    session.closed = true;
    if (session.pending) this.#settlePending(session, "cancelled");
    if (session.idleTimer !== undefined) {
      this.#cancelScheduled(session.idleTimer);
      session.idleTimer = undefined;
    }
    session.sessionGrants.clear();
    session.activeTurnId = undefined;
    this.#sessions.delete(sessionId);
    return true;
  }

  #createBroker(sessionId: string, turnId: string): PermissionApprovalBroker {
    return {
      hasSessionGrant: (subject) => {
        const session = this.#requireSession(sessionId);
        this.#assertTurn(session, turnId);
        return session.sessionGrants.has(subjectKey(session, subject));
      },
      request: (input, signal) =>
        this.#requestApproval(sessionId, turnId, input, signal),
    };
  }

  #requestApproval(
    sessionId: string,
    turnId: string,
    input: PermissionApprovalRequest,
    signal: AbortSignal,
  ): PermissionApprovalHandle {
    const session = this.#requireSession(sessionId);
    this.#assertTurn(session, turnId);
    if (session.pending) {
      throw new PermissionSessionError(
        "approval-pending",
        "当前 Agent 轮次已有等待中的授权请求。",
      );
    }
    const binding = session.binding;
    if (!binding) {
      throw new PermissionSessionError(
        "binding-mismatch",
        "权限会话尚未绑定 Workspace 与 Provider。",
      );
    }

    const requestId = this.#createId();
    const expiresAtMs = this.#now() + this.#approvalTtlMs;
    const prompt = {
      requestId,
      toolCallId: input.toolCallId,
      toolName: input.subject.toolName,
      workspace: binding.workspace,
      summary: input.summary,
      risk: {
        level: permissionRisk(input.subject),
        message: input.reason.message,
      },
      source: input.reason.source,
      persistentLayer: "local" as const,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };

    if (signal.aborted) {
      return { prompt, outcome: Promise.resolve({ kind: "cancelled" }) };
    }

    let resolveOutcome: (outcome: PermissionApprovalOutcome) => void = () => {};
    const outcome = new Promise<PermissionApprovalOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    const abortListener = () => this.#settleIfCurrent(session, requestId, "cancelled");
    signal.addEventListener("abort", abortListener, { once: true });
    const timer = this.#schedule(
      () => this.#settleIfCurrent(session, requestId, "expired"),
      this.#approvalTtlMs,
    );
    session.pending = {
      requestId,
      turnId,
      subjectKey: subjectKey(session, input.subject),
      fingerprint: input.fingerprint,
      abortSignal: signal,
      abortListener,
      timer,
      resolve: resolveOutcome,
    };
    this.#touch(session);
    return { prompt, outcome };
  }

  #settleIfCurrent(
    session: PermissionSession,
    requestId: string,
    kind: "expired" | "cancelled",
  ): void {
    if (session.pending?.requestId !== requestId) return;
    this.#settlePending(session, kind);
    this.#touch(session);
  }

  #settlePending(
    session: PermissionSession,
    outcome: PermissionApprovalOutcome | "expired" | "cancelled",
  ): void {
    const pending = session.pending;
    if (!pending) return;
    session.pending = undefined;
    this.#cancelScheduled(pending.timer);
    pending.abortSignal.removeEventListener("abort", pending.abortListener);
    rememberResolvedRequest(session, pending.requestId);
    pending.resolve(
      typeof outcome === "string" ? { kind: outcome } : outcome,
    );
  }

  #requireSession(sessionId: string): PermissionSession {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw new PermissionSessionError(
        "unknown-session",
        "权限会话不存在或已经结束。",
      );
    }
    if (session.closed) {
      throw new PermissionSessionError("session-closed", "权限会话已经结束。");
    }
    return session;
  }

  #assertTurn(session: PermissionSession, turnId: string): void {
    if (session.activeTurnId !== turnId) {
      throw new PermissionSessionError(
        "turn-mismatch",
        "Agent 轮次不存在、已结束或不属于当前权限会话。",
      );
    }
  }

  #touch(session: PermissionSession): void {
    session.lastActivityAt = this.#now();
    this.#scheduleIdleExpiry(session);
  }

  #scheduleIdleExpiry(session: PermissionSession): void {
    if (session.idleTimer !== undefined) {
      this.#cancelScheduled(session.idleTimer);
    }
    session.idleTimer = this.#schedule(() => {
      const idleFor = this.#now() - session.lastActivityAt;
      if (idleFor >= this.#sessionIdleTtlMs) {
        this.closeSession(session.id);
        return;
      }
      this.#scheduleIdleExpiry(session);
    }, this.#sessionIdleTtlMs);
  }
}

function subjectKey(
  session: PermissionSession,
  subject: PermissionSubject,
): string {
  const workspaceId = session.binding?.workspace.id;
  if (!workspaceId) {
    throw new PermissionSessionError(
      "binding-mismatch",
      "权限会话尚未绑定 Workspace。",
    );
  }
  return JSON.stringify([
    workspaceId,
    subject.toolName,
    subject.kind,
    permissionTargetValue(subject),
  ]);
}

function decisionOutcome(
  decision: PermissionUserDecision,
): PermissionApprovalOutcome {
  switch (decision) {
    case "allow-once":
      return { kind: "allowed", scope: "once" };
    case "allow-session":
      return { kind: "allowed", scope: "session" };
    case "allow-permanent":
      return { kind: "allowed", scope: "permanent" };
    case "deny":
      return { kind: "denied" };
  }
}

function rememberResolvedRequest(
  session: PermissionSession,
  requestId: string,
): void {
  session.resolvedRequestIds.push(requestId);
  if (session.resolvedRequestIds.length > MAX_RESOLVED_REQUESTS) {
    session.resolvedRequestIds.shift();
  }
}

function snapshot(session: PermissionSession): PermissionSessionSnapshot {
  return {
    id: session.id,
    mode: session.mode,
    binding: session.binding ? copyBinding(session.binding) : undefined,
    activeTurn: session.activeTurnId !== undefined,
    pendingRequestId: session.pending?.requestId,
  };
}

function copyBinding(binding: PermissionSessionBinding): PermissionSessionBinding {
  return {
    workspace: { ...binding.workspace },
    providerId: binding.providerId,
  };
}

function sameBinding(
  left: PermissionSessionBinding,
  right: PermissionSessionBinding,
): boolean {
  return (
    left.workspace.id === right.workspace.id &&
    left.workspace.name === right.workspace.name &&
    left.providerId === right.providerId
  );
}

function defaultSchedule(callback: () => void, delayMs: number): unknown {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return timer;
}

function defaultCancelScheduled(handle: unknown): void {
  if (typeof handle === "number" || isNodeTimeout(handle)) {
    clearTimeout(handle);
  }
}

function isNodeTimeout(value: unknown): value is NodeJS.Timeout {
  return (
    typeof value === "object" &&
    value !== null &&
    "refresh" in value &&
    typeof value.refresh === "function"
  );
}
