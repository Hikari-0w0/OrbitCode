import type {
  PermissionReason,
  PermissionSubject,
} from "@/core/permissions/types";

export type PermissionUserDecision =
  | "allow-once"
  | "allow-session"
  | "allow-permanent"
  | "deny";

export type PermissionApprovalOutcome =
  | { readonly kind: "allowed"; readonly scope: "once" | "session" | "permanent" }
  | { readonly kind: "denied" }
  | { readonly kind: "expired" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "invalid" };

export type PermissionPromptSummary = Readonly<
  Record<string, string | number | boolean | null>
>;

export type PermissionPrompt = {
  readonly requestId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly workspace: { readonly id: string; readonly name: string };
  readonly summary: PermissionPromptSummary;
  readonly risk: {
    readonly level: "low" | "medium" | "high";
    readonly message: string;
  };
  readonly source: PermissionReason["source"];
  readonly persistentLayer: "local";
  readonly expiresAt: string;
};

export type PermissionApprovalRequest = {
  readonly toolCallId: string;
  readonly subject: PermissionSubject;
  readonly fingerprint: string;
  readonly reason: PermissionReason;
  readonly summary: PermissionPromptSummary;
};

export type PermissionApprovalHandle = {
  readonly prompt: PermissionPrompt;
  readonly outcome: Promise<PermissionApprovalOutcome>;
};

export interface PermissionApprovalBroker {
  hasSessionGrant(subject: PermissionSubject): boolean;
  request(
    input: PermissionApprovalRequest,
    signal: AbortSignal,
  ): PermissionApprovalHandle;
}
