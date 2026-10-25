import type { KnowledgeConfig } from "@/runtime/knowledge/config";
import type { SubAgentLimits } from "@/core/sub-agents/types";
import type { AgentIterationLimit } from "@/core/agent-events";
import type { ContextPolicyConfig } from "@/core/context/types";
import type { ModelThinkingConfig, ProviderTransportPolicy } from "@/models/provider";
import type { McpServerConfig } from "@/runtime/mcp-config";
import type { PermissionMode } from "@/core/permissions/types";

export type StoredCredential =
  | { readonly kind: "environment"; readonly variable: string }
  | { readonly kind: "local"; readonly value: string }
  | { readonly kind: "none" };

export type ManagedProvider = {
  readonly id: string;
  readonly displayName: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly credential: StoredCredential;
  readonly context: ContextPolicyConfig;
  readonly thinking?: ModelThinkingConfig;
  readonly transport?: ProviderTransportPolicy;
  readonly maxOutputTokens?: number;
  readonly enabled: boolean;
};

export type ManagedWorkspace = {
  readonly knowledge?: KnowledgeConfig;
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly enabled: boolean;
};

export type ManagedMcpServer = {
  readonly name: string;
  readonly scope: "user" | "workspace";
  readonly workspaceId?: string;
  readonly enabled: boolean;
  readonly config: McpServerConfig;
};

export type ManagedSettings = {
  readonly subAgents?: SubAgentLimits;
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly providers: readonly ManagedProvider[];
  readonly workspaces: readonly ManagedWorkspace[];
  readonly mcpServers: readonly ManagedMcpServer[];
  readonly defaultProviderId?: string;
  readonly defaultWorkspaceId?: string;
  readonly maxIterations?: AgentIterationLimit;
  readonly maxRuntimeMinutes?: number;
  readonly defaultPermissionMode?: PermissionMode;
};

export type PublicSettings = Omit<ManagedSettings, "providers" | "mcpServers" | "workspaces"> & {
  readonly workspaces: readonly (Omit<ManagedWorkspace, "knowledge"> & { readonly knowledge?: ReturnType<typeof import("@/runtime/knowledge/config").publicKnowledgeConfig> })[];
  readonly source: "managed" | "legacy" | "empty" | "invalid";
  readonly providers: readonly (Omit<ManagedProvider, "credential"> & {
    readonly credential: { readonly kind: StoredCredential["kind"]; readonly configured: boolean; readonly variable?: string };
  })[];
  readonly mcpServers: readonly {
    readonly name: string;
    readonly scope: ManagedMcpServer["scope"];
    readonly workspaceId?: string;
    readonly enabled: boolean;
    readonly type: McpServerConfig["type"];
    readonly endpoint: string;
  }[];
};

export class SettingsError extends Error {
  constructor(readonly code: "invalid" | "conflict" | "storage" | "unavailable", message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "SettingsError";
  }
}

export const EMPTY_SETTINGS: ManagedSettings = {
  schemaVersion: 1,
  revision: 0,
  providers: [],
  workspaces: [],
  mcpServers: [],
};
