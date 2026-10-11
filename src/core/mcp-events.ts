import type { PermissionPrompt } from "@/core/permissions/approval";
import type { PermissionResolutionStatus } from "@/core/tool-scheduler";

export type McpInitializationRecord = {
  readonly serverName: string;
  readonly phase: "connecting" | "ready" | "unavailable";
  readonly detail: string;
  readonly durationMs: number;
  readonly authorization?: PermissionResolutionStatus;
};
export type RuntimeInitializationEvent =
  | { readonly type: "runtime-permission-requested"; readonly serverName: string; readonly prompt: PermissionPrompt }
  | { readonly type: "runtime-permission-resolved"; readonly serverName: string; readonly requestId: string; readonly status: PermissionResolutionStatus; readonly scope?: "once" | "session" | "permanent" }
  | ({ readonly type: "mcp-status" } & McpInitializationRecord);

export function isMcpInitializationRecord(value: unknown): value is McpInitializationRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).every((k) => ["serverName", "phase", "detail", "durationMs", "authorization"].includes(k)) &&
    typeof v.serverName === "string" && v.serverName.length <= 128 &&
    ["connecting", "ready", "unavailable"].includes(String(v.phase)) &&
    typeof v.detail === "string" && v.detail.length <= 4096 &&
    typeof v.durationMs === "number" && Number.isFinite(v.durationMs) && v.durationMs >= 0 &&
    (v.authorization === undefined || ["allowed", "denied", "expired", "cancelled", "invalid"].includes(String(v.authorization)));
}
