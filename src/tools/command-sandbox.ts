import type { ResolvedWorkspacePath, WorkspaceBoundary } from "@/tools/types";

export type SandboxAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly message: string };

export type CommandRequest = {
  readonly command: string;
  readonly cwd: ResolvedWorkspacePath;
  readonly timeoutMs: number;
  readonly outputLimitBytes: number;
};

export type CommandExecution = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly terminationSignal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
};

export interface CommandSandbox {
  probe(workspace: WorkspaceBoundary): Promise<SandboxAvailability>;
  run(
    request: CommandRequest,
    options: {
      readonly workspace: WorkspaceBoundary;
      readonly signal: AbortSignal;
    },
  ): Promise<CommandExecution>;
}
