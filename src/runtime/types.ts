import type { AgentEvent } from "@/core/agent-events";

export type ProviderSummary = {
  readonly name: string;
  readonly model: string;
  readonly available: boolean;
};

export type WorkspaceSummary = {
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly isDefault: boolean;
};

export type PersistenceState =
  | { readonly status: "saved"; readonly revision: number }
  | { readonly status: "failed"; readonly detail: string };
export type RuntimeTurnEvent =
  | { readonly type: "agent"; readonly event: Exclude<AgentEvent, { type: "stopped" }> }
  | { readonly type: "warning"; readonly kind: "run-log" | "cleanup"; readonly detail: string }
  | { readonly type: "finished"; readonly stopped: Extract<AgentEvent, { type: "stopped" }>; readonly persistence: PersistenceState };
export const MAX_WORKSPACES = 32;
export const MAX_WORKSPACE_ID_LENGTH = 64;
export const MAX_WORKSPACE_NAME_LENGTH = 80;
