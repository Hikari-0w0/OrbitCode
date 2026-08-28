import type { AgentMode } from "@/core/agent-events";

export type FixedPromptModuleId =
  | "identity"
  | "system-constraints"
  | "task-mode"
  | "action-execution"
  | "tool-use"
  | "tone-style"
  | "text-output";

export type FixedPromptModule = {
  readonly id: FixedPromptModuleId;
  readonly priority: number;
  readonly content: string;
};

export type PromptEnvironment = {
  readonly workspace: {
    readonly id: string;
    readonly name: string;
  };
  readonly platform: string;
  readonly currentDate: string;
  readonly timeZone: string;
  readonly pathSemantics: "workspace-relative-posix";
};

export type OptionalPromptContext = {
  readonly customInstructions?: string;
  readonly activatedSkills?: string;
  readonly longTermMemory?: string;
};

export type SessionInstructionContext = {
  readonly mode: AgentMode;
  readonly modeTurn: number;
};

export type PromptSystemMessage = {
  readonly role: "system";
  readonly content: string;
};
