import { LocalSettingsStore } from "@/lib/local-settings-store";
import { createKnowledgeService } from "@/runtime/knowledge/factory";
import { readOutputArtifact } from "@/runtime/child-execution/output-verifier";
import { ModelRequestBudget } from "@/runtime/child-execution/request-budget";
import { childWorkspaceAccess } from "@/runtime/child-execution/workspace-policy";
import {ParentExecutionPolicy} from "@/tools/parent-execution-policy";
import {isParentExecutionContract} from "@/core/sub-agents/parent-execution";
import { aggregateTaskUsage, combineModelUsage } from "@/runtime/sub-agent-usage";
import { BackgroundTaskManager } from "@/runtime/background-task-manager";
import { WorkspaceExecutionCoordinator } from "@/runtime/workspace-execution-coordinator";
import { ChildResultDelivery } from "@/runtime/child-result-delivery";
import { loadAgentCatalog } from "@/runtime/agents/catalog";
import { createDelegationTool } from "@/runtime/agents/delegation";
import { resolveSubAgentLimits } from "@/runtime/config";
import type { TaskScope } from "@/core/sub-agents/types";
import { createIsolatedSkillSession } from "@/runtime/skills/session-factory";
import { ModelUsageTracker } from "@/models/usage-tracker";
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
import { toolFailure } from "@/tools/types";
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
import { loadPermissionRules, type PermissionConfigLocations } from "@/tools/permission-config";
import { resolveRuntimeProvider, type ProviderContext } from "@/runtime/config";
import { resolveWorkspaceBoundary, WorkspaceCatalogError, type WorkspaceCatalog } from "@/runtime/workspace-config";
import { createPromptEnvironment } from "@/runtime/prompt-environment";
import type { PermissionSessionManager } from "@/runtime/permission-session-manager";
import type { ConversationRuntimeManager } from "@/runtime/conversation-runtime-manager";
import type { ConversationOperationGuard, GuardedConversationOperation } from "@/runtime/conversation-operation-guard";
import { runAgentTurn, type PreparedAgentTurn } from "@/runtime/run-agent-turn";

export type RunTurnInput = {
  readonly parentExecution?: import("@/core/sub-agents/parent-execution").ParentExecutionContract;
  readonly interactive?: boolean;
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
  readonly createSandbox?: (context: ProviderContext) => CommandSandbox;
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
  private readonly activeModes=new Map<string,AgentMode>();
  private readonly shutdown=new AbortController();
  private readonly parentUsage=new Map<string, import("@/models/usage-tracker").ModelUsageSummary>();
  private readonly requestBudgets=new Map<string,{scope:TaskScope;budget:ModelRequestBudget;active:boolean}>();
  private pruneRequestBudgets() {
    for(const [id,entry] of this.requestBudgets) {
      if(this.requestBudgets.size<=128)break;
      if(!entry.active&&entry.budget.snapshot().inFlight===0&&!this.tasks.list(entry.scope).some(task=>task.state.status!=="terminal"&&task.admission?.requestBudget.id===id))this.requestBudgets.delete(id);
    }
  }
  usageFor(scope:TaskScope) { return {...aggregateTaskUsage(this.parentUsage.get(scope.conversationId)??{scope:"self",categories:[]},this.tasks.list(scope).flatMap(task=>task.state.status==="terminal"?[{id:task.id,usage:task.state.result.usage}]:[])),requestBudgets:[...this.requestBudgets.values()].filter(entry=>entry.scope.conversationId===scope.conversationId&&entry.scope.lifecycleEpoch===scope.lifecycleEpoch).map(entry=>entry.budget.snapshot())}; }
  readonly tasks = new BackgroundTaskManager();
  async readTaskReply(conversationId:string,taskId:string,offset=0,limit=4000,signal=new AbortController().signal) { return this.options.store.childResults.read(await this.taskScope(conversationId),taskId,offset,limit,signal); }
  private readonly writes = new WorkspaceExecutionCoordinator();
  private readonly taskScopes = new Map<string, TaskScope>();
  async taskScope(conversationId:string):Promise<TaskScope> { const cp=await this.options.store.load(conversationId); return {conversationId,lifecycleEpoch:cp.lifecycleEpoch??this.taskScopes.get(conversationId)?.lifecycleEpoch??"unstarted"}; }
  async inspectAgents(conversationId:string) { const cp=await this.options.store.load(conversationId);const config=await this.options.loadConfig();const workspace=await resolveWorkspaceBoundary(await this.options.loadWorkspaces(config),cp.summary.workspaceId);const catalog=await loadAgentCatalog({workspaceRoot:workspace.root,userRoot:this.options.userConfigRoot??userConfigurationRoot()});return {entries:[...catalog.entries.values()],complete:catalog.complete,diagnostics:catalog.diagnostics}; }
  async invalidateTasks(cp:ConversationCheckpoint) { this.parentUsage.delete(cp.summary.id); for(const [id,entry] of this.requestBudgets)if(entry.scope.conversationId===cp.summary.id)this.requestBudgets.delete(id); await this.tasks.invalidate({conversationId:cp.summary.id,lifecycleEpoch:cp.lifecycleEpoch??this.taskScopes.get(cp.summary.id)?.lifecycleEpoch??"unstarted"});this.taskScopes.delete(cp.summary.id); }

  private readonly pendingMemory = new Map<string, {turnId: string; workspaceRoot: string; config: ResolvedProviderConfig}>();
  readonly memory: MemoryService;
  private readonly mcp: McpConnectionManager;
  async knowledge(workspaceId: string) {
    const config=await this.options.loadConfig();
    const workspace=await resolveWorkspaceBoundary(await this.options.loadWorkspaces(config),workspaceId);
    return createKnowledgeService({workspaceId,store:new LocalSettingsStore(this.options.userConfigRoot ?? userConfigurationRoot()),workspace,environment:config.environment,...(this.options.permissionLocations?{locations:this.options.permissionLocations(workspace.root)}:{})});
  }
  get knowledgeSettingsStore() { return new LocalSettingsStore(this.options.userConfigRoot ?? userConfigurationRoot()); }

  constructor(private readonly options: AgentRuntimeOptions) { this.mcp = options.mcpConnections ?? new McpConnectionManager(); this.memory = new MemoryService(options.userConfigRoot ?? userConfigurationRoot(), options.store, options.guard); }
  async close(): Promise<void> { this.shutdown.abort(); await this.tasks.close(); this.requestBudgets.clear(); this.pendingMemory.clear(); await Promise.all([this.memory.close(), this.mcp.close()]); }
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
  async scheduleSaved(checkpoint: ConversationCheckpoint): Promise<void> { const scope=await this.taskScope(checkpoint.summary.id);for(const id of checkpoint.childResultReceipts??[]) {try{this.tasks.commit(scope,id,checkpoint.summary.revision);}catch{}} this.scheduleOriginalSaved(checkpoint); }
  async *streamTurn(input: RunTurnInput) {
    const turn = await this.prepare(input);
    yield* runAgentTurn({ ...turn, signal: input.signal });
  }
  async prepare(input: RunTurnInput): Promise<PreparedAgentTurn> {
    input={...input,signal:AbortSignal.any([input.signal,this.shutdown.signal])};
    input.signal.throwIfAborted();
    if(input.parentExecution!==undefined&&!isParentExecutionContract(input.parentExecution))throw new Error("父级执行契约无效。");
    const parentExecution=input.parentExecution??{version:1,mode:"collaborate"} as const;
    let activeTurn: { readonly sessionId: string; readonly turnId: string } | undefined;
    let activeConversation: GuardedConversationOperation | undefined;
    let managedProcesses: ManagedProcessController | undefined;
    const turnWrites = this.writes.createExecutionScope();
    let savedTurn = false;
    let savedCheckpoint: ConversationCheckpoint | undefined;
    const mcpLeases: McpConnectionLease[] = [];
    let requestBudgetId: string | undefined;
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
      if(activeConversation)this.activeModes.delete(input.conversationId);
      if(savedTurn)this.taskScopes.delete(input.conversationId);
      if(requestBudgetId){const entry=this.requestBudgets.get(requestBudgetId);if(entry)entry.active=false;this.pruneRequestBudgets();}
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
      const sandbox = this.options.createSandbox?.(context) ?? this.options.sandbox;
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
      this.activeModes.set(input.conversationId,input.mode);
      const locked = await this.options.store.load(input.conversationId);
      if (locked.summary.revision !== input.expectedRevision) throw new ConversationRepositoryError("conflict", "会话已更新，请重新加载。");
      const runtimeTurnId = randomUUID();
      const lifecycleEpoch = checkpoint.lifecycleEpoch ?? randomUUID();
      const taskScope = {conversationId:input.conversationId,lifecycleEpoch};
      this.taskScopes.set(input.conversationId,taskScope);
      const childDelivery = new ChildResultDelivery(this.tasks,taskScope,runtimeTurnId,locked.childResultReceipts);
      const subLimits=resolveSubAgentLimits(context);this.tasks.configure(subLimits);
      const agentCatalog=await loadAgentCatalog({workspaceRoot:workspace.root,userRoot:this.options.userConfigRoot??userConfigurationRoot(),signal:input.signal});
      const background = await prepareBackground({ workspaceRoot: workspace.root, userConfigRoot: this.options.userConfigRoot ?? userConfigurationRoot(), checkpoint: locked, signal: input.signal });
      const readMemory = background.snapshot.optional.memoryIndex ? background.readMemory : undefined;
      const modelUsage = new ModelUsageTracker();
      const requestBudget=new ModelRequestBudget(runtimeTurnId,subLimits.groupRequests,subLimits.groupTokens);
      requestBudgetId=runtimeTurnId;this.requestBudgets.set(runtimeTurnId,{scope:taskScope,budget:requestBudget,active:true});this.pruneRequestBudgets();
      const baseProvider = requestBudget.wrap(this.options.createProvider?.(providerConfig) ?? createChatProvider(providerConfig),providerConfig.maxOutputTokens);
      const provider = modelUsage.wrap(baseProvider, "agent");
      const contextManager = new ContextManager({
        sessionId: input.conversationId,
        config: providerConfig.context,
        store: this.options.store,
        provider,
        summaryProvider: modelUsage.wrap(baseProvider, "summary"),
        initialState: checkpoint.context,
      });
      const readContext = { read: (request: {
        readonly reference: string;
        readonly offset: number;
        readonly limit: number;
        readonly signal: AbortSignal;
      }) => this.options.store.read({
        sessionId: input.conversationId,
        ...request,
      }), search: (request: import("@/core/context/context-search").ContextSearchInput) => this.options.store.search({ sessionId: input.conversationId, ...request }) };
      managedProcesses = new ManagedProcessController(sandbox, workspace);
      const completionTracker = new CompletionTracker();
      const registry = createDefaultToolRegistry(
        sandbox,
        readContext,
        managedProcesses,
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
      const toolTargets = new Map(registry.permissionTargets()).set("read_skill_resource", "path").set("search_knowledge", "path");
      const gatewayForMode = (agentMode: AgentMode) => new PermissionGateway({
            agentMode,
            permissionMode: () =>
              this.options.permissions.getSession(input.permissionSessionId).mode,
            workspace,
            loadRules: async () =>
              (await loadPermissionRules({
                workspaceRoot: workspace.root,
                toolTargets,
                ...(this.options.permissionLocations ? { locations: this.options.permissionLocations(workspace.root) } : {}),
              })).rules,

          });
      const knowledgeSettings = new LocalSettingsStore(this.options.userConfigRoot ?? userConfigurationRoot());
      const knowledgeService = createKnowledgeService({store:knowledgeSettings,workspaceId:binding.workspace.id,workspace,gateway:gatewayForMode(input.mode),environment:context.environment});
      const knowledgeEnabled = (await knowledgeSettings.load())?.workspaces.some(entry=>entry.id===binding.workspace.id && entry.enabled && entry.rootPath===workspace.root && entry.knowledge?.enabled) ?? false;
      const knowledgeReader = knowledgeEnabled ? knowledgeService.reader() : undefined;
      const parentRules=(await loadPermissionRules({workspaceRoot:workspace.root,toolTargets,...(this.options.permissionLocations?{locations:this.options.permissionLocations(workspace.root)}:{})})).rules;
      const catalog = await loadSkillCatalog({ workspaceRoot: workspace.root, userRoot: this.memory.userConfigRoot, signal: input.signal });
      if (input.skillCatalogRevision && input.skillCatalogRevision !== catalog.revision) throw new ConversationRepositoryError("conflict", "Skill 目录已更新，请刷新列表后重新选择。");
      let skillSession: SkillSession | undefined;
      const toolIdentities = new Map<string, NonNullable<RegisteredTool["externalIdentity"]>>();
      let isolatedCount = 0;
      const buildAgent = (externalTools: readonly RegisteredTool[], deadlineMs: number) => {
        for (const tool of externalTools) if (tool.externalIdentity) toolIdentities.set(tool.name, tool.externalIdentity);
        const modelIds = new Set(context.providers.map(provider => provider.name));
        const common = { commandTimeoutMs: Math.max(sandbox.security?.maxTimeoutMs ?? 120000, sandbox.security?.maxReadyTimeoutMs ?? 30000), toolFailurePolicy: context.managedSettings?.toolFailurePolicy, writes:turnWrites, consumeChildResults:()=>childDelivery.consume(), maxIterations: context.maxIterations, maxRuntimeMs: Math.max(1, Math.min(context.maxRuntimeMs, deadlineMs - Date.now())), promptEnvironment: createPromptEnvironment({ workspace: binding.workspace }), optionalPromptContext: {...background.snapshot.optional,availableAgents:agentCatalog.summary || undefined,parentExecution:parentExecution.mode,delegationKind:parentExecution.delegationKind} };
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
            const releaseRead = await turnWrites.acquireRead(workspace.root, execution.signal);
            const { activation } = await skills.resolve(request.name, request.arguments, execution.signal).finally(releaseRead);
            if (activation.definition.mode === "shared") { skills.activate(activation); return successfulToolResult({ name: request.name, instructions: activation.instructions, generation: skills.snapshot().generation }); }
            if (++isolatedCount > 4) throw new SkillError("capacity", "本回合独立 Skill 调用最多 4 次。");
            const parentTools = new Set(combinedRegistry.descriptors().map(tool => tool.name).filter(name => skills.active().every(item => item.definition.allowedTools.includes(name))));
            // 共享并发池的等待也计入独立 Skill 原有五分钟预算，不能排队后重新计时。
            const isolatedDeadline=Math.min(execution.deadlineMs,Date.now()+300000);
            const isolatedSignal=AbortSignal.any([execution.signal,AbortSignal.timeout(Math.max(1,isolatedDeadline-Date.now()))]);
            let cleanupFailed=false;
            let workspaceLease:import("@/runtime/workspace-execution-coordinator").TaskWorkspaceLease|undefined;
            const skillTools=new Set([...parentTools].filter(name=>activation.definition.allowedTools.includes(name)));
            const access=childWorkspaceAccess(skillTools,combinedRegistry.descriptors());
            return this.tasks.withForeground(isolatedSignal, ownedSignal => {
              if(!workspaceLease)throw new Error("独立 Skill 工作区资源未接纳。");
              return workspaceLease.run(()=>runIsolatedSkill({ onCleanupFailure:()=>{cleanupFailed=true;}, activation, parentId: input.conversationId, parentHistory: locked.context.messages, parentStore: this.options.store, mode: input.mode, context: {...execution,signal:ownedSignal,deadlineMs:isolatedDeadline}, iterations: context.maxIterations === "unlimited" ? 16 : context.maxIterations,
              runLog: { sink: this.options.log, source: input.source, conversationId: input.conversationId, providerId: activation.definition.model ?? binding.providerId, workspaceId: binding.workspace.id, revisionBefore: input.expectedRevision, parentRunId: runtimeTurnId, parentCallId: execution.callId ?? `preload:${activation.definition.name}` },
              create: async child => {
                const childConfig = resolveRuntimeProvider(context, activation.definition.model ?? binding.providerId);
                return createIsolatedSkillSession({ child, config: childConfig,
                  provider: requestBudget.wrap(this.options.createProvider?.(childConfig) ?? createChatProvider(childConfig),childConfig.maxOutputTokens),
                  sandbox, workspace, catalog, activation, modelIds, parentTools, externalTools, readMemory,
                  options: { ...common, writes: this.writes, permissionGatewayForMode: gatewayForMode } });
              } }));
            },{acquire:async ownedSignal=>{workspaceLease=await this.writes.acquireTask(workspace.root,access,ownedSignal);},close:async()=>{workspaceLease?.release(cleanupFailed?"failed":"complete");}}).catch(error=>isolatedSignal.aborted ? toolFailure(execution.signal.aborted?"cancelled":"timeout","独立 Skill 等待或执行预算已结束。") : skillFailure(error,execution.signal));
          } catch (error) { return skillFailure(error, execution.signal); }
        };
        const delegation=createDelegationTool({toolFailurePolicy: context.managedSettings?.toolFailurePolicy,requestBudget,parentExecution,verifyRead:(path,execution)=>readOutputArtifact({path,context:execution,gateway:gatewayForMode(input.mode),writes:turnWrites,tools:async()=>{const current=(await this.options.store.load(input.conversationId)).skills?.active??[];return new Set(combinedRegistry.descriptors().map(t=>t.name).filter(name=>skills.active().every(active=>active.definition.allowedTools.includes(name))&&current.every(active=>active.definition.allowedTools.includes(name))));}}),childResults:this.options.store.childResults,readMemory,tasks:this.tasks,limits:subLimits,scope:taskScope,turnId:runtimeTurnId,workspace,contextManager,parentStore:this.options.store,toolDescriptors:()=>combinedRegistry.descriptors(),currentTools:async()=>{const current=(await this.options.store.load(input.conversationId)).skills?.active??[];return new Set(combinedRegistry.descriptors().map(t=>t.name).filter(name=>skills.active().every(active=>active.definition.allowedTools.includes(name))&&current.every(active=>active.definition.allowedTools.includes(name))));},catalog:signal=>loadAgentCatalog({workspaceRoot:workspace.root,userRoot:this.options.userConfigRoot??userConfigurationRoot(),signal}),skills:catalog,active:()=>skills.active(),parentTools:()=>new Set(combinedRegistry.descriptors().map(t=>t.name).filter(name=>skills.active().every(active=>active.definition.allowedTools.includes(name)))),modelIds,parentConfig:providerConfig,resolveConfig:id=>resolveRuntimeProvider(context,id),provider:config=>this.options.createProvider?.(config)??createChatProvider(config),parentIterations:context.maxIterations==="unlimited"?32:context.maxIterations,parentRuntimeMs:context.maxRuntimeMs,mode:input.mode,parentMode:this.options.permissions.getSession(input.permissionSessionId).mode,rules:parentRules,currentPermissions:async()=>({agentMode:this.activeModes.get(input.conversationId)??(await this.options.store.load(input.conversationId)).mode,mode:this.options.permissions.getSession(input.permissionSessionId).mode,rules:(await loadPermissionRules({workspaceRoot:workspace.root,toolTargets,...(this.options.permissionLocations?{locations:this.options.permissionLocations(workspace.root)}:{})})).rules}),sandbox,optional:background.snapshot.optional,environment:common.promptEnvironment,writes:this.writes,runLog:{sink:this.options.log,source:input.source,conversationId:input.conversationId,providerId:binding.providerId,workspaceId:binding.workspace.id,revisionBefore:input.expectedRevision},initialize:async(gateway,signal,deadlineAt,leases)=>{const ownLeases:McpConnectionLease[]=[];try{const generator=initializeMcpWorkspace({writes:this.writes,workspaceRoot:workspace.root,mode:input.mode,signal,deadlineMs:deadlineAt,load:loadMcp,manager:mcpManager,gateway,leases:ownLeases});for(;;){const next=await generator.next();if(next.done)return next.value;}}finally{leases.push(...ownLeases);}}});
        const combinedRegistry: ToolRegistry = createDefaultToolRegistry(sandbox, readContext, managedProcesses, [...externalTools, delegation, createLoadSkillTool(load), createReadSkillResourceTool(resources)], readMemory, knowledgeReader);
        const agent = createAgentSession({ provider, registry: combinedRegistry, workspace, skills, resources, restrict:access=>new ParentExecutionPolicy(access,parentExecution), options: { ...common, contextManager, completionTracker, permissionGatewayForMode: gatewayForMode } });
        const command = parseSkillCommand(input.input);
        if (command && parentExecution.mode==="delegate-only") throw new SkillError("invalid-arguments", "仅委派模式不能直接执行父级 Skill，请由子任务加载或切换协作模式。");
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
      const writes=this.writes;
      const loadMcp = () => this.options.loadMcp?.(workspace.root, context) ?? loadMcpConfig({ workspaceRoot: workspace.root,
        environment: context.environment, managedSettings: context.managedSettings ?? null });
      return {
        initialize: async function* (signal, deadlineMs) {
          const externalTools = yield* initializeMcpWorkspace({ writes, workspaceRoot: workspace.root, mode: input.mode, signal, deadlineMs,
            load: loadMcp, manager: mcpManager, gateway: gatewayForMode(input.mode), leases: mcpLeases });
          return buildAgent(externalTools, deadlineMs);
        },
        maxRuntimeMs: context.maxRuntimeMs, input: input.input, mode: input.mode, modeTurn: input.modeTurn,
        operationSignal: AbortSignal.any([conversationOperation.signal,this.shutdown.signal]),
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
              childResultReceipts:childDelivery.snapshot(),
              skills: skillSession?.snapshot() ?? locked.skills,
              lastTurn: { parentExecution, turnId: runtimeTurnId, endedAt: new Date().toISOString(), stopReason: terminal.reason, memoryEligibility: terminal.reason === "final-response" && Boolean(terminal.finalMessage?.content.trim()) && pendingToolCalls(contextManager.persistentSnapshot().messages).length === 0 },
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
          this.parentUsage.set(input.conversationId,combineModelUsage(this.parentUsage.get(input.conversationId)??{scope:"self",categories:[]},modelUsage.snapshot()));
          if(this.parentUsage.size>64){const key=this.parentUsage.keys().next().value;if(key)this.parentUsage.delete(key);}
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
          childDelivery.commit(result.checkpoint.summary.revision);
          savedTurn = true;
          savedCheckpoint = result.checkpoint;
          return { status: "saved", revision: result.checkpoint.summary.revision };
        },
        runLog: { sink: this.options.log, source: input.source, toolIdentities, createRunId: () => runtimeTurnId,
          conversationId: input.conversationId, revisionBefore: input.expectedRevision,
          providerId: checkpoint.summary.providerId, workspaceId: checkpoint.summary.workspaceId, modelUsage: () => modelUsage.snapshot() },
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
