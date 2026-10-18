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
import type { SkillCatalog } from "./catalog";
import type { runIsolatedSkill } from "./isolated-runner";
import { SkillResources } from "./resources";
import { SkillSession } from "./service";

type ChildOptions = Parameters<Parameters<typeof runIsolatedSkill>[0]["create"]>[0];

export async function createIsolatedSkillSession(input: {
  readonly child: ChildOptions;
  readonly config: ResolvedProviderConfig;
  readonly provider: ChatProvider;
  readonly sandbox: CommandSandbox;
  readonly workspace: WorkspaceBoundary;
  readonly catalog: SkillCatalog;
  readonly activation: ActivatedSkill;
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
    skills.activate(activation);
    const resources = new SkillResources(skills, workspace);
    const load: SkillLoader = async (request, execution) => {
      try {
        const { activation: next } = await skills.resolve(request.name, request.arguments, execution.signal);
        if (next.definition.mode === "isolated") throw new SkillError("invalid-arguments", "独立 Skill 不允许递归启动独立执行。");
        skills.activate(next);
        return successfulToolResult({ name: request.name, instructions: next.instructions });
      } catch (error) { return skillFailure(error, execution.signal); }
    };
    const registry: ToolRegistry = createDefaultToolRegistry(input.sandbox,
      request => child.store.read({ sessionId: child.id, ...request }), processes, completionTracker,
      [...input.externalTools, createLoadSkillTool(load), createReadSkillResourceTool(resources)], input.readMemory);
    const agent = createAgentSession({ provider, registry, workspace, skills, resources, parentTools: input.parentTools,
      options: { ...input.options, maxIterations: child.maxIterations, maxRuntimeMs: child.maxRuntimeMs, contextManager, completionTracker } });
    return { agent, close: () => processes.close(), modelUsage: () => modelUsage.snapshot() };
  } catch (error) {
    await processes.close();
    throw error;
  }
}
