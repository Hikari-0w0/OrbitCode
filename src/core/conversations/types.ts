import type {
  AgentMode,
  AgentStopReason,
  TokenUsage,
} from "@/core/agent-events";
import type { ManagedContextMessage } from "@/core/context/types";
import type { CompletionAssessment } from "@/core/completion-tracker";
import type { SideEffectState, ToolExecutionResult } from "@/tools/types";

export const CONVERSATION_SCHEMA_VERSION = 1;
export const MAX_CONVERSATION_TITLE_LENGTH = 120;
export const MAX_CONVERSATION_ID_LENGTH = 128;

export type ConversationBinding = {
  readonly workspaceId: string;
  readonly providerId: string;
};

export type PersistedMessagePart =
  | {
      readonly type: "text";
      readonly iteration: number;
      readonly content: string;
    }
  | {
      readonly type: "tool";
      readonly iteration: number;
      readonly callId: string;
    };

export type PersistedToolExecution = {
  readonly iteration: number;
  readonly sequence: number;
  readonly callId: string;
  readonly name: string;
  readonly argumentsJson: string;
  readonly state:
    | "succeeded"
    | "failed"
    | "timed-out"
    | "cancelled"
    | "skipped";
  readonly result: ToolExecutionResult;
};

export type PersistedDisplayMessage = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly state: "complete" | "cancelled" | "failed";
  readonly detail?: string;
  readonly parts?: readonly PersistedMessagePart[];
  readonly toolExecutions?: readonly PersistedToolExecution[];
  readonly usage?: TokenUsage;
  readonly cumulativeUsage?: TokenUsage;
  readonly stopReason?: AgentStopReason;
  readonly durationMs?: number;
  readonly verification?: CompletionAssessment;
};

export type PersistedContextState = {
  readonly messages: readonly ManagedContextMessage[];
  readonly consecutiveSummaryFailures: number;
};

export type ConversationSummary = ConversationBinding & {
  readonly schemaVersion: typeof CONVERSATION_SCHEMA_VERSION;
  readonly id: string;
  readonly title: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastStopReason?: AgentStopReason;
};

export type ConversationCheckpoint = {
  readonly schemaVersion: typeof CONVERSATION_SCHEMA_VERSION;
  readonly summary: ConversationSummary;
  readonly mode: AgentMode;
  readonly modeTurn: number;
  readonly displayMessages: readonly PersistedDisplayMessage[];
  readonly context: PersistedContextState;
};

export type ConversationSaveInput = {
  readonly conversationId: string;
  readonly expectedRevision: number;
  readonly checkpoint: Omit<ConversationCheckpoint, "summary"> & {
    readonly summary: Omit<ConversationSummary, "revision" | "updatedAt">;
  };
};

export type ConversationSaveResult =
  | { readonly status: "saved"; readonly checkpoint: ConversationCheckpoint }
  | {
      readonly status: "conflict";
      readonly expectedRevision: number;
      readonly actualRevision: number;
    };

export type ConversationCreateInput = ConversationBinding & {
  readonly title?: string;
  readonly mode?: AgentMode;
};

export type ConversationFailureKind =
  | "not-found"
  | "conflict"
  | "busy"
  | "invalid-data"
  | "storage";

export class ConversationRepositoryError extends Error {
  constructor(
    readonly kind: ConversationFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "ConversationRepositoryError";
  }
}

export interface ConversationRepository {
  list(): Promise<readonly ConversationSummary[]>;
  create(input: ConversationCreateInput): Promise<ConversationCheckpoint>;
  load(conversationId: string): Promise<ConversationCheckpoint>;
  save(input: ConversationSaveInput): Promise<ConversationSaveResult>;
  rename(input: {
    readonly conversationId: string;
    readonly expectedRevision: number;
    readonly title: string;
  }): Promise<ConversationSaveResult>;
  clear(input: {
    readonly conversationId: string;
    readonly expectedRevision: number;
  }): Promise<ConversationSaveResult>;
  delete(input: {
    readonly conversationId: string;
    readonly expectedRevision: number;
  }): Promise<void>;
}

export type PersistedTerminal = {
  readonly reason: AgentStopReason;
  readonly iterations: number;
  readonly durationMs: number;
  readonly sideEffect: SideEffectState;
  readonly detail?: string;
  readonly verification?: CompletionAssessment;
};
