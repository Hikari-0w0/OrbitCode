import { ContextManager } from "@/core/context/context-manager";
import { CompletionTracker } from "@/core/completion-tracker";
import { SkillError, type ActivatedSkill } from "@/core/skills/types";
import type { ResolvedProviderConfig } from "@/models/config";
import type { ChatProvider } from "@/models/provider";
import { ModelUsageTracker } from "@/models/usage-tracker";
import { createAgentSession } from "@/runtime/agent-session-factory";
import { createDefaultToolRegistry } from "@/tools/default-registry";
import { createLoadSkillTool, skillFailure, type SkillLoader } from "@/tools/load-skill";
import { ManagedProcessController } from "@/tools/managed-process";
import { createReadSkillResourceTool } from "@/tools/read-skill-resource";
import type { MemoryContentReader } from "@/tools/read-memory";
import type { CommandSandbox } from "@/tools/command-sandbox";
import { successfulToolResult, type RegisteredTool, type ToolRegistry } from "@/tools/registry";
import type { WorkspaceBoundary } from "@/tools/types";
import type { SkillCatalog } from "@/runtime/skills/catalog";
import type { LocalContextStore } from "@/lib/local-context-store";
import type { ManagedContextMessage } from "@/core/context/types";
import { SkillResources } from "@/runtime/skills/resources";
import { SkillSession } from "@/runtime/skills/service";

export type ChildSessionOptions = { readonly id:string; readonly store:LocalContextStore; readonly history:readonly ManagedContextMessage[]; readonly referenceAliases?: ReadonlyMap<string, string>; readonly maxRuntimeMs:number; readonly maxIterations:number };

export async function createChildSession(input: {
  readonly child: ChildSessionOptions;
  readonly config: ResolvedProviderConfig;
  readonly provider: ChatProvider;
  readonly sandbox: CommandSandbox;
  readonly workspace: WorkspaceBoundary;
  readonly catalog: SkillCatalog;
  readonly activation?: ActivatedSkill;
  readonly inheritedSkills?: readonly ActivatedSkill[];
  readonly restrict?: (access: import("@/tools/mode-policy").ToolAccess) => import("@/tools/mode-policy").ToolAccess;
  readonly modelIds: ReadonlySet<string>;
  readonly parentTools: ReadonlySet<string>;
  readonly externalTools: readonly RegisteredTool[];
  readonly readMemory?: MemoryContentReader;
  readonly options: Parameters<typeof createAgentSession>[0]["options"];
}) {
  const { child, workspace, activation } = input;
  const modelUsage = new ModelUsageTracker();
  const provider = modelUsage.wrap(input.provider, "agent");
  const contextManager = new ContextManager({ sessionId: child.id, config: input.config.context,
    store: child.store, provider, summaryProvider: modelUsage.wrap(input.provider, "summary"),
    initialState: { messages: child.history, consecutiveSummaryFailures: 0 } });
  const processes = new ManagedProcessController(input.sandbox, workspace);
  try {
    const completionTracker = new CompletionTracker();
    const skills = new SkillSession(undefined, input.catalog, {
      tools: () => new Set(registry.descriptors().map(tool => tool.name)),
      providerId: input.config.name, modelIds: input.modelIds,
    });
    if (activation) skills.activate(activation);
    for (const inherited of input.inheritedSkills ?? []) skills.activate(inherited);
    const resources = new SkillResources(skills, workspace);
    const load: SkillLoader = async (request, execution) => {
      try {
        const { activation: next } = await skills.resolve(request.name, request.arguments, execution.signal);
        if (next.definition.mode === "isolated") throw new SkillError("invalid-arguments", "独立 Skill 不允许递归启动独立执行。");
        skills.activate(next);
        return successfulToolResult({ name: request.name, instructions: next.instructions });
      } catch (error) { return skillFailure(error, execution.signal); }
    };
    const resolveReference = (reference: string) => child.referenceAliases?.get(reference) ?? reference;
    const registry: ToolRegistry = createDefaultToolRegistry(input.sandbox,
      { read: request => child.store.read({ sessionId: child.id, ...request, reference: resolveReference(request.reference) }), search: request => child.store.search({ sessionId: child.id, ...request, reference: resolveReference(request.reference) }) }, processes,
      [...input.externalTools, createLoadSkillTool(load), createReadSkillResourceTool(resources)], input.readMemory);
    const agent = createAgentSession({ provider, registry, workspace, skills, resources, parentTools: input.parentTools,
      restrict: input.restrict, options: { ...input.options, commandTimeoutMs: Math.max(input.sandbox.security?.maxTimeoutMs ?? 120000, input.sandbox.security?.maxReadyTimeoutMs ?? 30000), consumeChildResults: undefined, childBudgetReminder: true, maxIterations: child.maxIterations, maxRuntimeMs: child.maxRuntimeMs, contextManager, completionTracker } });
    return { agent, close: () => processes.close(), modelUsage: () => modelUsage.snapshot() };
  } catch (error) {
    await processes.close();
    throw error;
  }
}
