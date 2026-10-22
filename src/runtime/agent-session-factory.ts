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
    restrict?: (access: import("@/tools/mode-policy").ToolAccess) => import("@/tools/mode-policy").ToolAccess;
    options: ConstructorParameters<typeof AgentLoop>[3];
}) {
    return new AgentLoop(input.provider, mode => { const access = new SkillToolPolicy(createModeToolPolicy(input.registry, mode), () => input.skills.active(), input.parentTools, signal => input.resources.validate(signal)); return input.restrict?.(access) ?? access; }, input.workspace, {
        ...input.options,
        promptContext: async (signal) => { await input.resources.validate(signal); return input.skills.prompt(input.options.optionalPromptContext ?? {}); },
    });
}
