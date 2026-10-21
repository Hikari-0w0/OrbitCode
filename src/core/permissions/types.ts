export type PermissionMode = "strict" | "default" | "permissive";
export type PermissionDecision = "allow" | "ask" | "deny";
export type PermissionRuleLayer = "user" | "project" | "local";
export type PermissionTargetKind = "path" | "command" | "mcp";
export type PermissionRiskLevel = "low" | "medium" | "high";

export type PermissionSubject =
  | {
      readonly kind: "mcp";
      readonly toolName: string;
      readonly toolKind: "external";
      readonly operation: "connect" | "call";
      readonly serverName: string;
      readonly configurationId: string;
      readonly toolIdentity?: { readonly originalName: string; readonly schemaId: string; readonly argumentsId: string };
    }
  | {
      readonly kind: "path";
      readonly toolName: string;
      readonly toolKind: "read" | "write";
      readonly requestedPath: string;
      readonly canonicalRelativePath: string;
    }
  | {
      readonly kind: "command";
      readonly toolName: string;
      readonly toolKind: "command";
      readonly command: string;
      readonly canonicalCwd: string;
    };

export type PermissionRule = {
  readonly source: PermissionRuleLayer;
  readonly expression: string;
  readonly toolName: string;
  readonly targetKind: PermissionTargetKind;
  readonly pattern: string;
  readonly matchKind: "exact" | "glob";
  readonly decision: PermissionDecision;
};

export type MatchedPermissionRule = Pick<
  PermissionRule,
  "source" | "expression" | "decision" | "matchKind"
>;

export type PermissionReason =
  | {
      readonly source: "rules";
      readonly risk: PermissionRiskLevel;
      readonly matches: readonly MatchedPermissionRule[];
      readonly message: string;
    }
  | {
      readonly source: "mode";
      readonly risk: PermissionRiskLevel;
      readonly mode: PermissionMode;
      readonly message: string;
    };

export type PermissionEvaluation =
  | { readonly kind: "allow"; readonly reason: PermissionReason }
  | {
      readonly kind: "deny";
      readonly reason: PermissionReason;
      readonly errorKind: "permission-denied";
    };

export function permissionTargetValue(subject: PermissionSubject): string {
  if (subject.kind === "mcp") {
    const encode = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
    const base = `server/${encode(subject.serverName)}/config/${subject.configurationId}`;
    const tool = subject.toolIdentity;
    return tool ? `${base}/tool/${encode(tool.originalName)}/schema/${tool.schemaId}/args/${tool.argumentsId}` : base;
  }
  return subject.kind === "path"
    ? subject.canonicalRelativePath
    : subject.command;
}

export function permissionRisk(subject: PermissionSubject): PermissionRiskLevel {
  if (subject.toolKind === "external") return "high";
  if (subject.toolKind === "command") return "high";
  if (subject.toolKind === "write") return "medium";
  return "low";
}

export function permissionRuleName(subject: PermissionSubject): string {
  return subject.kind === "mcp" ? `mcp_${subject.operation}` : subject.toolName;
}
