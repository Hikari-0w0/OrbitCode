import type { AgentMode } from "@/core/agent-events";
import { ContextManager } from "@/core/context/context-manager";
import {
  ConversationRepositoryError, type ConversationCheckpoint,
  type ConversationCreateInput, type ConversationSaveResult,
} from "@/core/conversations/types";
import type { LocalConversationStore } from "@/lib/local-conversation-store";
import { createChatProvider } from "@/models/provider-factory";
import { resolveRuntimeProvider, type ProviderContext } from "@/runtime/config";
import type { ConversationOperationGuard, GuardedConversationOperation } from "@/runtime/conversation-operation-guard";
import type { ConversationRuntimeManager, ConversationOperationKind } from "@/runtime/conversation-runtime-manager";

export type ConversationMutation = { readonly conversationId: string; readonly expectedRevision: number };
export class ConversationService {
  constructor(
    readonly store: LocalConversationStore,
    readonly manager: ConversationRuntimeManager,
    readonly guard: ConversationOperationGuard,
    private readonly loadConfig: () => Promise<ProviderContext>,
  ) {}
  list() { return this.store.list(); }
  load(id: string) { return this.store.load(id); }
  create(input: ConversationCreateInput) { return this.store.create(input); }
  rename(input: ConversationMutation & { readonly title: string }) {
    return this.mutate(input, "rename", async () => saved(await this.store.rename(input)));
  }
  clear(input: ConversationMutation) {
    return this.mutate(input, "clear", async () => saved(await this.store.clear(input)));
  }
  delete(input: ConversationMutation) {
    return this.mutate(input, "delete", () => this.store.delete(input));
  }
  setMode(input: ConversationMutation & { readonly mode: AgentMode }) {
    return this.mutate(input, "mode", async (checkpoint) => saved(await this.store.save({
      ...input, checkpoint: { ...checkpoint, mode: input.mode,
        modeTurn: checkpoint.mode === input.mode ? checkpoint.modeTurn : 0 },
    })));
  }
  compress(input: ConversationMutation & { readonly signal: AbortSignal }) {
    return this.mutate(input, "compress", async (checkpoint, operation) => {
      const config = resolveRuntimeProvider(await this.loadConfig(), checkpoint.summary.providerId);
      const manager = new ContextManager({ sessionId: input.conversationId,
        config: config.context, provider: createChatProvider(config), store: this.store,
        initialState: checkpoint.context });
      const report = await manager.compressManually(AbortSignal.any([input.signal, operation.signal]));
      const current = report.status === "succeeded" ? saved(await this.store.save({
        conversationId: input.conversationId, expectedRevision: input.expectedRevision,
        checkpoint: { ...checkpoint, context: manager.persistentSnapshot() },
      })) : checkpoint;
      return { report, checkpoint: current };
    });
  }
  retrySave(input: ConversationMutation) {
    return this.mutate(input, "retry-save", async () => {
      const pending = this.manager.pendingSave(input.conversationId);
      if (!pending || pending.expectedRevision !== input.expectedRevision)
        throw new ConversationRepositoryError("not-found", "没有可重试的未保存轮次。");
      const checkpoint = saved(await this.store.save(pending));
      this.manager.clearPendingSave(input.conversationId);
      await this.store.clearTurnMarker(input.conversationId);
      return checkpoint;
    });
  }
  recover(input: ConversationMutation) {
    return this.mutate(input, "recover", (_checkpoint, operation) =>
      this.store.recoverInterruptedTurn(input.conversationId, operation.lease));
  }
  private async mutate<T>(input: ConversationMutation, kind: ConversationOperationKind,
    action: (checkpoint: ConversationCheckpoint, operation: GuardedConversationOperation) => Promise<T>): Promise<T> {
    const operation = await this.guard.begin(input.conversationId, kind);
    try {
      const checkpoint = await this.store.load(input.conversationId);
      if (checkpoint.summary.revision !== input.expectedRevision)
        throw new ConversationRepositoryError("conflict", "会话已更新，请重新加载。");
      return await action(checkpoint, operation);
    } finally { await operation.finish(); }
  }
}
function saved(result: ConversationSaveResult): ConversationCheckpoint {
  if (result.status === "conflict") throw new ConversationRepositoryError("conflict", "会话已更新，本次操作未覆盖记录。");
  return result.checkpoint;
}
