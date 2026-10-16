import type { OptionalPromptContext } from "@/core/system-prompt/types";
export type InstructionSource = "user" | "project-agents" | "project-instructions";
export type BackgroundDiagnostic = {
    readonly source: string;
    readonly detail: string;
};
export type LoadedInstruction = {
    readonly source: InstructionSource;
    readonly content: string;
    readonly files: readonly string[];
};
export type InstructionLoadResult = {
    readonly status: "ready";
    readonly instructions: readonly LoadedInstruction[];
    readonly diagnostics: readonly BackgroundDiagnostic[];
} | {
    readonly status: "blocked";
    readonly source: InstructionSource;
    readonly detail: string;
};
export type BackgroundSnapshot = {
    readonly optional: OptionalPromptContext;
    readonly sources: readonly {
        readonly source: string;
        readonly files: readonly string[];
    }[];
    readonly diagnostics: readonly BackgroundDiagnostic[];
};
