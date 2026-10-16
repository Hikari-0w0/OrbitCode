import { AgentLoop } from "@/core/agent-loop";
import { SkillToolPolicy } from "@/tools/skill-policy";
import { createModeToolPolicy } from "@/tools/mode-policy";
import type { SkillSession } from "@/runtime/skills/service";
import type { SkillResources } from "@/runtime/skills/resources";
import type { ToolRegistry } from "@/tools/registry";
import type { ChatProvider } from "@/models/provider";
import type { WorkspaceBoundary } from "@/tools/types";
export function createAgentSession(input: {
    provider: ChatProvider;
    registry: ToolRegistry;
    workspace: WorkspaceBoundary;
    skills: SkillSession;
    resources: SkillResources;
    parentTools?: ReadonlySet<string>;
    options: ConstructorParameters<typeof AgentLoop>[3];
}) {
    return new AgentLoop(input.provider, mode => new SkillToolPolicy(createModeToolPolicy(input.registry, mode), () => input.skills.active(), input.parentTools, signal => input.resources.validate(signal)), input.workspace, {
        ...input.options,
        promptContext: async (signal) => { await input.resources.validate(signal); return input.skills.prompt(input.options.optionalPromptContext ?? {}); },
    });
}
