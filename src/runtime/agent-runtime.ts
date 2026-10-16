import { loadSkillCatalog } from "@/runtime/skills/catalog";
import { SkillSession } from "@/runtime/skills/service";
import { SkillResources } from "@/runtime/skills/resources";
import { LOCAL_SKILL_TOOLS } from "@/runtime/skills/definition";
import { SkillError, type ActivatedSkill } from "@/core/skills/types";
import { createAgentSession } from "@/runtime/agent-session-factory";
import { createLoadSkillTool, skillFailure, type SkillLoader } from "@/tools/load-skill";
import { createReadSkillResourceTool } from "@/tools/read-skill-resource";
import { runIsolatedSkill } from "@/runtime/skills/isolated-runner";
import { preloadSkill } from "@/runtime/skills/preload";
import { parseSkillCommand } from "@/runtime/skill-commands";
import { approximatePromptTokens } from "@/core/context/token-estimator";
import { buildSystemPromptMessages } from "@/core/system-prompt/assemble";
import { successfulToolResult, type ToolRegistry } from "@/tools/registry";
import {sourceKey} from "@/runtime/memory-store";
import {serializeNote} from "@/runtime/memory-validation";
import {memoryStores} from "@/runtime/background-service";
import {MemoryService} from "@/runtime/memory-service";
import {prepareBackground,userConfigurationRoot} from "@/runtime/background-service";
import { randomUUID } from "node:crypto";
import { pendingToolCalls } from "@/runtime/conversation-recovery";
import { loadMcpConfig, type McpConfigSnapshot } from "@/runtime/mcp-config";
import { McpConnectionManager, type McpConnectionLease } from "@/runtime/mcp-connections";
import { initializeMcpWorkspace } from "@/runtime/mcp-initialization";
import type { RegisteredTool } from "@/tools/registry";
import { ContextManager } from "@/core/context/context-manager";
import { CompletionTracker } from "@/core/completion-tracker";
import { appendPersistedTurn, deriveConversationTitle } from "@/core/conversations/display-timeline";
import { ConversationRepositoryError, type ConversationCheckpoint, type ConversationSummary } from "@/core/conversations/types";
import type { AgentMode } from "@/core/agent-events";
import type { LocalConversationStore } from "@/lib/local-conversation-store";
import type { AgentRunLogSink } from "@/lib/local-agent-run-log";
import { createChatProvider } from "@/models/provider-factory";
import type { ChatProvider } from "@/models/provider";
import type { ResolvedProviderConfig } from "@/models/config";
import { createDefaultToolRegistry } from "@/tools/default-registry";
import type { CommandSandbox } from "@/tools/command-sandbox";
import { ManagedProcessController } from "@/tools/managed-process";
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
  readonly skillCatalogRevision?: string;
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
  readonly userConfigRoot?: string;
  readonly createProvider?: (config: ResolvedProviderConfig) => ChatProvider;
  readonly permissionLocations?: (workspaceRoot: string) => PermissionConfigLocations;
};
export class AgentRuntime {
  private readonly pendingMemory = new Map<string, {turnId: string; workspaceRoot: string; config: ResolvedProviderConfig}>();
  readonly memory: MemoryService;
  private readonly mcp: McpConnectionManager;
  constructor(private readonly options: AgentRuntimeOptions) { this.mcp = options.mcpConnections ?? new McpConnectionManager(); this.memory = new MemoryService(options.userConfigRoot ?? userConfigurationRoot(), options.store, options.guard); }
  async close(): Promise<void> { this.pendingMemory.clear(); await Promise.all([this.memory.close(), this.mcp.close()]); }
  async memoryStoresFor(conversationId: string) {
    const checkpoint = await this.options.store.load(conversationId);
    const context = await this.options.loadConfig();
    const workspace = await resolveWorkspaceBoundary(await this.options.loadWorkspaces(context), checkpoint.summary.workspaceId);
    return memoryStores(workspace.root, this.memory.userConfigRoot);
  }
  async inspectBackground(conversationId: string) {
    const checkpoint = await this.options.store.load(conversationId);
    const context = await this.options.loadConfig();
    const workspace = await resolveWorkspaceBoundary(await this.options.loadWorkspaces(context), checkpoint.summary.workspaceId);
    const loaded = await prepareBackground({workspaceRoot: workspace.root, userConfigRoot: this.memory.userConfigRoot, checkpoint});
    const scopes = [];
    const stores = Object.values(memoryStores(workspace.root, this.memory.userConfigRoot));
    for (const store of stores) {
      try { const snapshot = await store.load(); scopes.push({scope: store.scope, revision: snapshot.revision, notes: snapshot.notes.map(note => ({id: note.id, title: note.title, markdown: serializeNote(note)}))}); }
      catch { scopes.push({scope: store.scope, revision: "unavailable", notes: []}); }
    }
    const jobs = [];
    for (const job of await this.memory.inspect(conversationId)) {
      if (["abandoned", "failed"].includes(job.status)) {
        let committed = false;
        const noteIds: string[] = [];
        for (const store of stores) try {
          if (await store.hasProcessed(job.source)) {
            committed = true;
            const snapshot = await store.load();
            noteIds.push(...snapshot.notes.filter(note => note.sources.some(source => sourceKey(source) === sourceKey(job.source))).map(note => note.id));
          }
        } catch { /* 损坏作用域由背景诊断说明，不推断其提交结果。 */ }
        if (committed) { jobs.push({...job, status: "skipped" as const, detail: "发现已提交的作用域记录，但任务未完整结束；请检查两级笔记。", noteIds}); continue; }
      }
      jobs.push(job);
    }
    return {background: loaded.snapshot, enabled: await this.memory.enabled(), jobs, scopes};
  }
  async inspectSkills(conversationId: string) {
    const checkpoint = await this.options.store.load(conversationId);
    const config = await this.options.loadConfig();
    const workspace = await resolveWorkspaceBoundary(await this.options.loadWorkspaces(config), checkpoint.summary.workspaceId);
    const catalog = await loadSkillCatalog({ workspaceRoot: workspace.root, userRoot: this.memory.userConfigRoot });
    return { conversationRevision: checkpoint.summary.revision, revision: catalog.revision, overridden: catalog.overridden ?? [], complete: catalog.complete, blocked: catalog.blocked, diagnostics: catalog.diagnostics,
      entries: [...catalog.entries.values()].map(item => ({ name: item.definition.name, description: item.definition.description, source: item.source, mode: item.definition.mode,
        active: Boolean(checkpoint.skills?.active.some(active => active.definition.name === item.definition.name)),
        updateAvailable: checkpoint.skills?.active.some(active => active.definition.name === item.definition.name && active.definitionHash !== item.hash) ?? false,
        availability: !catalog.complete ? "blocked" : item.definition.allowedTools.some(tool => !LOCAL_SKILL_TOOLS.has(tool)) ? "pending-discovery" : "ready" })),
      active: checkpoint.skills?.active.map(item => ({ name: item.definition.name, description: item.definition.description, source: item.source })) ?? [] };
  }
  async deactivateSkill(input: { conversationId: string; expectedRevision: number; name: string }) {
    if (this.options.manager.pendingSave(input.conversationId)) throw new ConversationRepositoryError("busy", "请先保存待保存结果。");
    const operation = await this.options.guard.begin(input.conversationId, "skill-mutation");
    try {
      const checkpoint = await this.options.store.load(input.conversationId);
      if (checkpoint.summary.revision !== input.expectedRevision) throw new ConversationRepositoryError("conflict", "会话已更新。");
      const active = checkpoint.skills?.active.filter(item => item.definition.name !== input.name) ?? [];
      if (active.length === (checkpoint.skills?.active.length ?? 0)) return checkpoint;
      const result = await this.options.store.save({ conversationId: input.conversationId, expectedRevision: input.expectedRevision, checkpoint: { ...checkpoint, skills: { version: 1, generation: (checkpoint.skills?.generation ?? 0) + 1, active } } });
      if (result.status === "conflict") throw new ConversationRepositoryError("conflict", "会话已更新。");
      return result.checkpoint;
    } finally { await operation.finish(); }
  }
  private scheduleOriginalSaved(checkpoint: ConversationCheckpoint): void {
    const pending = this.pendingMemory.get(checkpoint.summary.id);
    if (!pending || pending.turnId !== checkpoint.lastTurn?.turnId) return;
    this.pendingMemory.delete(checkpoint.summary.id);
    this.memory.scheduleSavedTurn(checkpoint, pending.workspaceRoot, pending.config, this.options.createProvider?.(pending.config));
  }
  async scheduleSaved(checkpoint: ConversationCheckpoint): Promise<void> { this.scheduleOriginalSaved(checkpoint); }
  async *streamTurn(input: RunTurnInput) {
    const turn = await this.prepare(input);
    yield* runAgentTurn({ ...turn, signal: input.signal });
  }
  async prepare(input: RunTurnInput): Promise<PreparedAgentTurn> {
    let activeTurn: { readonly sessionId: string; readonly turnId: string } | undefined;
    let activeConversation: GuardedConversationOperation | undefined;
    let managedProcesses: ManagedProcessController | undefined;
    let savedTurn = false;
    let savedCheckpoint: ConversationCheckpoint | undefined;
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
      if (pendingToolCalls(checkpoint.context.messages).length) throw new ConversationRepositoryError("busy", "会话含未完成工具调用，请先恢复检查点。");
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
        input.signal,
      );
      activeConversation = conversationOperation;
      const locked = await this.options.store.load(input.conversationId);
      if (locked.summary.revision !== input.expectedRevision) throw new ConversationRepositoryError("conflict", "会话已更新，请重新加载。");
      const runtimeTurnId = randomUUID();
      const lifecycleEpoch = checkpoint.lifecycleEpoch ?? randomUUID();
      const background = await prepareBackground({ workspaceRoot: workspace.root, userConfigRoot: this.options.userConfigRoot ?? userConfigurationRoot(), checkpoint: locked, signal: input.signal });
      const readMemory = background.snapshot.optional.memoryIndex ? background.readMemory : undefined;
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
        [],
        readMemory,
      );
      const turn = this.options.permissions.beginTurn(
        input.permissionSessionId,
        binding,
      );
      activeTurn = {
        sessionId: input.permissionSessionId,
        turnId: turn.id,
      };
      const toolTargets = new Map(registry.permissionTargets()).set("read_skill_resource", "path");
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
      const catalog = await loadSkillCatalog({ workspaceRoot: workspace.root, userRoot: this.memory.userConfigRoot, signal: input.signal });
      if (input.skillCatalogRevision && input.skillCatalogRevision !== catalog.revision) throw new ConversationRepositoryError("conflict", "Skill 目录已更新，请刷新列表后重新选择。");
      let skillSession: SkillSession | undefined;
      const toolIdentities = new Map<string, NonNullable<RegisteredTool["externalIdentity"]>>();
      let isolatedCount = 0;
      const buildAgent = (externalTools: readonly RegisteredTool[], deadlineMs: number) => {
        for (const tool of externalTools) if (tool.externalIdentity) toolIdentities.set(tool.name, tool.externalIdentity);
        const modelIds = new Set(context.providers.map(provider => provider.name));
        const common = { maxIterations: context.maxIterations, maxRuntimeMs: Math.max(1, Math.min(context.maxRuntimeMs, deadlineMs - Date.now())), promptEnvironment: createPromptEnvironment({ workspace: binding.workspace }), optionalPromptContext: background.snapshot.optional };
        const skills = new SkillSession(locked.skills, catalog, { tools: () => new Set(combinedRegistry.descriptors().map(tool => tool.name)), providerId: binding.providerId, modelIds,
          validateCapacity: (active: readonly ActivatedSkill[]) => {
            const optional = { ...background.snapshot.optional, activatedSkills: active.map(item => item.instructions).join("\n\n") || undefined };
            const prompt = buildSystemPromptMessages({ environment: common.promptEnvironment, optional, session: { mode: input.mode, modeTurn: input.modeTurn } });
            if (approximatePromptTokens(prompt, registry.definitions()) + providerConfig.context.automaticReserveTokens >= providerConfig.context.windowTokens) throw new SkillError("capacity", "激活指令超过模型上下文预算。");
          } });
        skillSession = skills;
        const resources = new SkillResources(skills, workspace);
        const load: SkillLoader = async (request, execution) => {
          try {
            const { activation } = await skills.resolve(request.name, request.arguments, execution.signal);
            if (activation.definition.mode === "shared") { skills.activate(activation); return successfulToolResult({ name: request.name, instructions: activation.instructions, generation: skills.snapshot().generation }); }
            if (++isolatedCount > 4) throw new SkillError("capacity", "本回合独立 Skill 调用最多 4 次。");
            const parentTools = new Set(combinedRegistry.descriptors().map(tool => tool.name).filter(name => skills.active().every(item => item.definition.allowedTools.includes(name))));
            return runIsolatedSkill({ activation, parentId: input.conversationId, parentHistory: locked.context.messages, parentStore: this.options.store, mode: input.mode, context: execution, iterations: context.maxIterations === "unlimited" ? 16 : context.maxIterations,
              runLog: { sink: this.options.log, source: input.source, conversationId: input.conversationId, providerId: activation.definition.model ?? binding.providerId, workspaceId: binding.workspace.id, revisionBefore: input.expectedRevision, parentRunId: runtimeTurnId, parentCallId: execution.callId ?? `preload:${activation.definition.name}` },
              create: async child => {
                const childConfig = resolveRuntimeProvider(context, activation.definition.model ?? binding.providerId);
                const childProvider = this.options.createProvider?.(childConfig) ?? createChatProvider(childConfig);
                const childContext = new ContextManager({ sessionId: child.id, config: childConfig.context, store: child.store, provider: childProvider, initialState: { messages: child.history, consecutiveSummaryFailures: 0 } });
                const processes = new ManagedProcessController(this.options.sandbox, workspace), tracker = new CompletionTracker();
                const childSkills = new SkillSession(undefined, catalog, { tools: () => new Set(childRegistry.descriptors().map(tool => tool.name)), providerId: activation.definition.model ?? binding.providerId, modelIds });
                childSkills.activate(activation);
                const childResources = new SkillResources(childSkills, workspace);
                const childLoad: SkillLoader = async (request, execution) => { try { const { activation: next } = await childSkills.resolve(request.name, request.arguments, execution.signal); if (next.definition.mode === "isolated") throw new SkillError("invalid-arguments", "独立 Skill 不允许递归启动独立执行。"); childSkills.activate(next); return successfulToolResult({ name: request.name, instructions: next.instructions }); } catch (error) { return skillFailure(error, execution.signal); } };
                const childRegistry: ToolRegistry = createDefaultToolRegistry(this.options.sandbox, request => child.store.read({ sessionId: child.id, ...request }), processes, tracker, [...externalTools, createLoadSkillTool(childLoad), createReadSkillResourceTool(childResources)], readMemory);
                const agent = createAgentSession({ provider: childProvider, registry: childRegistry, workspace, skills: childSkills, resources: childResources, parentTools, options: { ...common, maxIterations: child.maxIterations, maxRuntimeMs: child.maxRuntimeMs, contextManager: childContext, completionTracker: tracker, permissionGatewayForMode: gatewayForMode } });
                return { agent, close: () => processes.close() };
              } });
          } catch (error) { return skillFailure(error, execution.signal); }
        };
        const combinedRegistry: ToolRegistry = createDefaultToolRegistry(this.options.sandbox, readContext, managedProcesses, completionTracker, [...externalTools, createLoadSkillTool(load), createReadSkillResourceTool(resources)], readMemory);
        const agent = createAgentSession({ provider, registry: combinedRegistry, workspace, skills, resources, options: { ...common, contextManager, completionTracker, permissionGatewayForMode: gatewayForMode } });
        const command = parseSkillCommand(input.input);
        if (command && command.kind !== "run") throw new SkillError("invalid-arguments", "管理命令请通过 Skill 列表或 CLI 交互入口执行。");
        return command?.kind === "run" ? preloadSkill(agent, command, load, workspace, deadlineMs) : agent;
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
              lifecycleEpoch,
              skills: skillSession?.snapshot() ?? locked.skills,
              lastTurn: { turnId: runtimeTurnId, endedAt: new Date().toISOString(), stopReason: terminal.reason, memoryEligibility: terminal.reason === "final-response" && Boolean(terminal.finalMessage?.content.trim()) && pendingToolCalls(contextManager.persistentSnapshot().messages).length === 0 },
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
          if (saveInput.checkpoint.lastTurn.memoryEligibility) {
            this.pendingMemory.set(input.conversationId, {turnId: runtimeTurnId, workspaceRoot: workspace.root, config: providerConfig});
            if (this.pendingMemory.size > 64) { const oldest = this.pendingMemory.keys().next().value; if (oldest) this.pendingMemory.delete(oldest); }
          }
          const result = await this.options.store.save(saveInput);
          if (result.status === "conflict") {
            throw new Error("会话已在其他页面更新，本轮结果未覆盖磁盘记录。请刷新后重试。");
          }
          this.options.manager.clearPendingSave(input.conversationId);
          savedTurn = true;
          savedCheckpoint = result.checkpoint;
          return { status: "saved", revision: result.checkpoint.summary.revision };
        },
        runLog: { sink: this.options.log, source: input.source, toolIdentities, createRunId: () => runtimeTurnId,
          conversationId: input.conversationId, revisionBefore: input.expectedRevision,
          providerId: checkpoint.summary.providerId, workspaceId: checkpoint.summary.workspaceId },
        onFinished: cleanup,
        onPersistedTurn: () => { if (savedCheckpoint) this.scheduleOriginalSaved(savedCheckpoint); },
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
