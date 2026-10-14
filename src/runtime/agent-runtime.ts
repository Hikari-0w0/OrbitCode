import { loadMcpConfig, type McpConfigSnapshot } from "@/runtime/mcp-config";
import { McpConnectionManager, type McpConnectionLease } from "@/runtime/mcp-connections";
import { initializeMcpWorkspace } from "@/runtime/mcp-initialization";
import type { RegisteredTool } from "@/tools/registry";
import { AgentLoop } from "@/core/agent-loop";
import { ContextManager } from "@/core/context/context-manager";
import { CompletionTracker } from "@/core/completion-tracker";
import { appendPersistedTurn, deriveConversationTitle } from "@/core/conversations/display-timeline";
import { ConversationRepositoryError, type ConversationSummary } from "@/core/conversations/types";
import type { AgentMode } from "@/core/agent-events";
import type { LocalConversationStore } from "@/lib/local-conversation-store";
import type { AgentRunLogSink } from "@/lib/local-agent-run-log";
import { createChatProvider } from "@/models/provider-factory";
import type { ChatProvider } from "@/models/provider";
import type { ResolvedProviderConfig } from "@/models/config";
import { createDefaultToolRegistry } from "@/tools/default-registry";
import type { CommandSandbox } from "@/tools/command-sandbox";
import { ManagedProcessController } from "@/tools/managed-process";
import { createModeToolPolicy } from "@/tools/mode-policy";
import { PermissionGateway } from "@/tools/permission-gateway";
import { addLocalPermissionAllow, loadPermissionRules, type PermissionConfigLocations } from "@/tools/permission-config";
import { resolveRuntimeProvider, type ProviderContext } from "@/runtime/config";
import { resolveWorkspaceBoundary, WorkspaceCatalogError, type WorkspaceCatalog } from "@/runtime/workspace-config";
import { createPromptEnvironment } from "@/runtime/prompt-environment";
import type { PermissionSessionManager } from "@/runtime/permission-session-manager";
import type { ConversationRuntimeManager } from "@/runtime/conversation-runtime-manager";
import type { ConversationOperationGuard, GuardedConversationOperation } from "@/runtime/conversation-operation-guard";
import { runAgentTurn, type PreparedAgentTurn } from "@/runtime/run-agent-turn";

export type RunTurnInput = {
  readonly conversationId: string;
  readonly expectedRevision: number;
  readonly permissionSessionId: string;
  readonly input: string;
  readonly mode: AgentMode;
  readonly modeTurn: number;
  readonly source: "web" | "cli";
  readonly signal: AbortSignal;
};
export type AgentRuntimeOptions = {
  readonly store: LocalConversationStore;
  readonly manager: ConversationRuntimeManager;
  readonly guard: ConversationOperationGuard;
  readonly permissions: PermissionSessionManager;
  readonly sandbox: CommandSandbox;
  readonly log: AgentRunLogSink;
  readonly loadConfig: () => Promise<ProviderContext>;
  readonly loadWorkspaces: (context: ProviderContext) => Promise<WorkspaceCatalog>;
  readonly mcpConnections?: McpConnectionManager;
  readonly loadMcp?: (workspaceRoot: string, context: ProviderContext) => Promise<McpConfigSnapshot>;
  readonly createProvider?: (config: ResolvedProviderConfig) => ChatProvider;
  readonly permissionLocations?: (workspaceRoot: string) => PermissionConfigLocations;
};
export class AgentRuntime {
  private readonly mcp: McpConnectionManager;
  constructor(private readonly options: AgentRuntimeOptions) { this.mcp = options.mcpConnections ?? new McpConnectionManager(); }
  close(): Promise<void> { return this.mcp.close(); }
  async *streamTurn(input: RunTurnInput) {
    const turn = await this.prepare(input);
    yield* runAgentTurn({ ...turn, signal: input.signal });
  }
  async prepare(input: RunTurnInput): Promise<PreparedAgentTurn> {
    let activeTurn: { readonly sessionId: string; readonly turnId: string } | undefined;
    let activeConversation: GuardedConversationOperation | undefined;
    let managedProcesses: ManagedProcessController | undefined;
    let savedTurn = false;
    const mcpLeases: McpConnectionLease[] = [];
    const cleanup = async () => {
      const outcomes = await Promise.allSettled([
        ...mcpLeases.map((lease) => lease.release()),
        Promise.resolve().then(async () => {
          if (savedTurn && activeConversation) {
            await this.options.store.clearTurnMarker(input.conversationId, activeConversation.lease.ownerToken);
          }
        }),
        Promise.resolve().then(() => managedProcesses?.close()),
        Promise.resolve().then(() => {
          if (activeTurn) this.options.permissions.finishTurn(activeTurn.sessionId, activeTurn.turnId);
        }),
      ]);
      await activeConversation?.finish();
      if (outcomes.some((result) => result.status === "rejected")) throw new Error("运行资源清理失败。");
    };
    try {
      if (this.options.manager.pendingSave(input.conversationId)) {
        throw new ConversationRepositoryError("busy", "当前会话有未保存结果，请先重试保存。");
      }
      const activity = await this.options.guard.inspect(input.conversationId);
      if (activity.status === "interrupted") {
        throw new ConversationRepositoryError("busy", "会话含中断标记，请先恢复检查点。");
      }
      const checkpoint = await this.options.store.load(input.conversationId);
      if (checkpoint.summary.revision !== input.expectedRevision) {
        throw new ConversationRepositoryError(
          "conflict",
          "会话已在其他页面更新，请刷新后重试。",
        );
      }
      const context = await this.options.loadConfig();
      const providerConfig = resolveRuntimeProvider(context, checkpoint.summary.providerId);
      const workspaceCatalog = await this.options.loadWorkspaces(context);
      const workspace = await resolveWorkspaceBoundary(
        workspaceCatalog,
        checkpoint.summary.workspaceId,
      );
      const workspaceEntry = workspaceCatalog.entries.find(
        (entry) => entry.id === checkpoint.summary.workspaceId,
      );
      if (!workspaceEntry) {
        throw new WorkspaceCatalogError(
          "unknown-workspace",
          "选择的 Workspace 未经服务端授权。",
        );
      }
      const binding = {
        workspace: { id: workspaceEntry.id, name: workspaceEntry.name },
        providerId: checkpoint.summary.providerId,
      } as const;
      const conversationOperation = await this.options.guard.begin(
        input.conversationId,
        "agent",
      );
      activeConversation = conversationOperation;
      const locked = await this.options.store.load(input.conversationId);
      if (locked.summary.revision !== input.expectedRevision) throw new ConversationRepositoryError("conflict", "会话已更新，请重新加载。");
      const provider = this.options.createProvider?.(providerConfig) ?? createChatProvider(providerConfig);
      const contextManager = new ContextManager({
        sessionId: input.conversationId,
        config: providerConfig.context,
        store: this.options.store,
        provider,
        initialState: checkpoint.context,
      });
      const readContext = (request: {
        readonly reference: string;
        readonly offset: number;
        readonly limit: number;
        readonly signal: AbortSignal;
      }) => this.options.store.read({
        sessionId: input.conversationId,
        ...request,
      });
      managedProcesses = new ManagedProcessController(this.options.sandbox, workspace);
      const completionTracker = new CompletionTracker();
      const registry = createDefaultToolRegistry(
        this.options.sandbox,
        readContext,
        managedProcesses,
        completionTracker,
      );
      const turn = this.options.permissions.beginTurn(
        input.permissionSessionId,
        binding,
      );
      activeTurn = {
        sessionId: input.permissionSessionId,
        turnId: turn.id,
      };
      const toolTargets = registry.permissionTargets();
      const gatewayForMode = (agentMode: AgentMode) => new PermissionGateway({
            agentMode,
            permissionMode: () =>
              this.options.permissions.getSession(input.permissionSessionId).mode,
            workspace,
            broker: turn.broker,
            loadRules: async () =>
              (await loadPermissionRules({
                workspaceRoot: workspace.root,
                toolTargets,
                ...(this.options.permissionLocations ? { locations: this.options.permissionLocations(workspace.root) } : {}),
              })).rules,
            persistAllow: async (expression) => {
              await addLocalPermissionAllow({
                workspaceRoot: workspace.root,
                toolTargets,
                expression,
                ...(this.options.permissionLocations ? { locations: this.options.permissionLocations(workspace.root) } : {}),
              });
            },
          });
      const toolIdentities = new Map<string, NonNullable<RegisteredTool["externalIdentity"]>>();
      const buildAgent = (externalTools: readonly RegisteredTool[], deadlineMs: number) => {
        for (const tool of externalTools) if (tool.externalIdentity) toolIdentities.set(tool.name, tool.externalIdentity);
        const combinedRegistry = createDefaultToolRegistry(this.options.sandbox, readContext, managedProcesses, completionTracker, externalTools);
        return new AgentLoop(provider, (mode) => createModeToolPolicy(combinedRegistry, mode), workspace, {
          maxIterations: context.maxIterations, maxRuntimeMs: Math.max(1, Math.min(context.maxRuntimeMs, deadlineMs - Date.now())),
          promptEnvironment: createPromptEnvironment({ workspace: binding.workspace }),
          permissionGatewayForMode: gatewayForMode, contextManager, completionTracker,
        });
      };
      await this.options.store.markTurnStarted({
        conversationId: input.conversationId,
        expectedRevision: input.expectedRevision,
        userInput: input.input,
        mode: input.mode,
        modeTurn: input.modeTurn,
        ownerToken: conversationOperation.lease.ownerToken,
      });
      const mcpManager = this.mcp;
      const loadMcp = () => this.options.loadMcp?.(workspace.root, context) ?? loadMcpConfig({ workspaceRoot: workspace.root,
        environment: context.environment, managedSettings: context.managedSettings ?? null });
      return {
        initialize: async function* (signal, deadlineMs) {
          const externalTools = yield* initializeMcpWorkspace({ workspaceRoot: workspace.root, mode: input.mode, signal, deadlineMs,
            load: loadMcp, manager: mcpManager, gateway: gatewayForMode(input.mode), leases: mcpLeases });
          return buildAgent(externalTools, deadlineMs);
        },
        maxRuntimeMs: context.maxRuntimeMs, input: input.input, mode: input.mode, modeTurn: input.modeTurn,
        operationSignal: conversationOperation.signal,
        persistTurn: async (events, initialization) => {
          const terminal = events.findLast(
            (event) => event.type === "stopped",
          );
          if (!terminal || terminal.type !== "stopped") {
            throw new Error("Agent 未返回可持久化的停止事件。");
          }
          const summary = checkpointSummaryForSave(checkpoint.summary);
          const saveInput = {
            conversationId: input.conversationId,
            expectedRevision: input.expectedRevision,
            checkpoint: {
              schemaVersion: checkpoint.schemaVersion,
              summary: {
                ...summary,
                title: checkpoint.displayMessages.length === 0 && checkpoint.summary.title === "新对话"
                  ? deriveConversationTitle(input.input)
                  : checkpoint.summary.title,
                lastStopReason: terminal.reason,
              },
              mode: input.mode,
              modeTurn: input.modeTurn,
              displayMessages: appendPersistedTurn({
                previous: checkpoint.displayMessages,
                userInput: input.input,
                events,
                initialization,
              }),
              context: contextManager.persistentSnapshot(),
            },
          } as const;
          this.options.manager.setPendingSave(saveInput);
          const result = await this.options.store.save(saveInput);
          if (result.status === "conflict") {
            throw new Error("会话已在其他页面更新，本轮结果未覆盖磁盘记录。请刷新后重试。");
          }
          this.options.manager.clearPendingSave(input.conversationId);
          savedTurn = true;
          return { status: "saved", revision: result.checkpoint.summary.revision };
        },
        runLog: { sink: this.options.log, source: input.source, toolIdentities,
          conversationId: input.conversationId, revisionBefore: input.expectedRevision,
          providerId: checkpoint.summary.providerId, workspaceId: checkpoint.summary.workspaceId },
        onFinished: cleanup,
      };
    } catch (error) { await cleanup().catch(() => undefined); throw error; }
  }
}

function checkpointSummaryForSave(
  summary: ConversationSummary,
) {
  return {
    schemaVersion: summary.schemaVersion,
    id: summary.id,
    title: summary.title,
    createdAt: summary.createdAt,
    workspaceId: summary.workspaceId,
    providerId: summary.providerId,
    ...(summary.lastStopReason === undefined ? {} : { lastStopReason: summary.lastStopReason }),
  };
}
