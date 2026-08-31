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

export type ManagedCommandRequest = Pick<
  CommandRequest,
  "command" | "cwd"
>;

export type ManagedCommandExit = {
  readonly exitCode: number | null;
  readonly terminationSignal: NodeJS.Signals | null;
};

export type SandboxManagedProcess = {
  readonly pid: number;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly completion: Promise<ManagedCommandExit>;
  stop(): Promise<void>;
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
  start?(
    request: ManagedCommandRequest,
    options: { readonly workspace: WorkspaceBoundary },
  ): Promise<SandboxManagedProcess>;
}
