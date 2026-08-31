import { randomUUID } from "node:crypto";

import type { ConversationSaveInput } from "@/core/conversations/types";

export class ConversationRuntimeError extends Error {
  constructor(
    readonly kind: "operation-active" | "operation-mismatch",
    message: string,
  ) {
    super(message);
    this.name = "ConversationRuntimeError";
  }
}

export type ConversationOperation = {
  readonly id: string;
  readonly kind: ConversationOperationKind;
  readonly signal: AbortSignal;
};

export type ConversationOperationKind =
  | "agent"
  | "compress"
  | "rename"
  | "clear"
  | "delete"
  | "retry-save"
  | "recover";

export class ConversationRuntimeManager {
  readonly #active = new Map<
    string,
    {
      readonly id: string;
      readonly kind: ConversationOperationKind;
      readonly controller: AbortController;
    }
  >();
  readonly #pendingSaves = new Map<string, ConversationSaveInput>();

  begin(
    conversationId: string,
    kind: ConversationOperationKind = "agent",
  ): ConversationOperation {
    if (this.#active.has(conversationId)) {
      throw new ConversationRuntimeError(
        "operation-active",
        "当前会话已有进行中的操作，请等待完成。",
      );
    }
    const operation = { id: randomUUID(), kind, controller: new AbortController() };
    this.#active.set(conversationId, operation);
    return { id: operation.id, kind, signal: operation.controller.signal };
  }

  finish(conversationId: string, operationId: string): void {
    const active = this.#active.get(conversationId);
    if (!active || active.id !== operationId) {
      throw new ConversationRuntimeError(
        "operation-mismatch",
        "会话操作已结束或不匹配。",
      );
    }
    this.#active.delete(conversationId);
  }

  abort(conversationId: string): void {
    this.#active.get(conversationId)?.controller.abort();
  }

  isActive(conversationId: string): boolean {
    return this.#active.has(conversationId);
  }

  activeKind(conversationId: string): ConversationOperationKind | undefined {
    return this.#active.get(conversationId)?.kind;
  }

  setPendingSave(input: ConversationSaveInput): void {
    if (!this.#pendingSaves.has(input.conversationId) && this.#pendingSaves.size >= 64) {
      const oldest = this.#pendingSaves.keys().next().value;
      if (oldest !== undefined) this.#pendingSaves.delete(oldest);
    }
    this.#pendingSaves.delete(input.conversationId);
    this.#pendingSaves.set(input.conversationId, input);
  }

  pendingSave(conversationId: string): ConversationSaveInput | undefined {
    return this.#pendingSaves.get(conversationId);
  }

  clearPendingSave(conversationId: string): void {
    this.#pendingSaves.delete(conversationId);
  }
}
