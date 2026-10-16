import {ConversationRepositoryError} from "@/core/conversations/types";
import type {
  ConversationActivity,
  ConversationWriteLease,
  LocalConversationStore,
} from "@/lib/local-conversation-store";
import {
  ConversationRuntimeManager,
  type ConversationOperationKind,
} from "@/runtime/conversation-runtime-manager";

export type GuardedConversationOperation = {
  readonly id: string;
  readonly kind: ConversationOperationKind;
  readonly signal: AbortSignal;
  readonly lease: ConversationWriteLease;
  finish(): Promise<void>;
};

export class ConversationOperationGuard {
  constructor(
    private readonly runtime: ConversationRuntimeManager,
    private readonly store: LocalConversationStore,
  ) {}

  async inspect(conversationId: string): Promise<ConversationActivity> {
    if (this.runtime.isActive(conversationId)) return { status: "active" };
    return this.store.inspectActivity(conversationId);
  }

  async begin(
    conversationId: string,
    kind: ConversationOperationKind,
    signal?: AbortSignal,
  ): Promise<GuardedConversationOperation> {
    if (kind === "agent") {
      const deadline = Date.now() + 2000;
      while (this.runtime.activeKind(conversationId) === "memory-commit" || await this.store.hasMemoryCommitLease(conversationId)) {
        signal?.throwIfAborted();
        if (Date.now() >= deadline) throw new ConversationRepositoryError("busy", "记忆提交正在占用会话，请稍后重试。");
        await new Promise<void>(resolve => setTimeout(resolve, 10));
      }
    }
    signal?.throwIfAborted();
    const runtimeOperation = this.runtime.begin(conversationId, kind);
    let lease: ConversationWriteLease;
    try {
      lease = await this.store.acquireWriteLease(conversationId, kind);
    } catch (error) {
      this.runtime.finish(conversationId, runtimeOperation.id);
      throw error;
    }
    let finished = false;
    return {
      id: runtimeOperation.id,
      kind,
      signal: runtimeOperation.signal,
      lease,
      finish: async () => {
        if (finished) return;
        finished = true;
        try {
          await lease.release();
        } finally {
          this.runtime.finish(conversationId, runtimeOperation.id);
        }
      },
    };
  }
}
