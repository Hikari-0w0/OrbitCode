export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export type ToolName =
  | "read_file"
  | "write_file"
  | "edit_file"
  | "run_command"
  | "find_files"
  | "search_code"
  | "read_context";

export type SchemaIssue = {
  readonly path: string;
  readonly message: string;
};

export type SchemaParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly SchemaIssue[] };

export interface ToolInputSchema<T> {
  readonly jsonSchema: JsonObject;
  parse(value: unknown): SchemaParseResult<T>;
}

export type ToolErrorKind =
  | "invalid-arguments"
  | "unknown-tool"
  | "not-found"
  | "permission-denied"
  | "dangerous-operation"
  | "workspace-boundary"
  | "permission-config"
  | "user-denied"
  | "approval-invalid"
  | "context-reference"
  | "protected-path"
  | "conflict"
  | "unsupported-content"
  | "limit-exceeded"
  | "sandbox-unavailable"
  | "command-failed"
  | "timeout"
  | "cancelled"
  | "execution-failed";

export type SideEffectState = "none" | "possible" | "applied";
export type ToolMutability = "read-only" | "workspace-write" | "command";

export type ToolResultMeta = {
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly truncatedFields: readonly string[];
};

export type ToolExecutionError = {
  readonly kind: ToolErrorKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly issues?: readonly SchemaIssue[];
};

export type ToolExecutionResult<TOutput extends JsonValue = JsonValue> =
  | {
      readonly ok: true;
      readonly output: TOutput;
      readonly sideEffect: SideEffectState;
      readonly meta: ToolResultMeta;
    }
  | {
      readonly ok: false;
      readonly error: ToolExecutionError;
      readonly output?: TOutput;
      readonly sideEffect: SideEffectState;
      readonly meta: ToolResultMeta;
    };

export type ResolvedWorkspacePath = {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly existed: boolean;
  readonly identity?: FileIdentity;
};

export type FileIdentity = {
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly modifiedMs: number;
};

export type TextFileSnapshot = {
  readonly path: ResolvedWorkspacePath;
  readonly content: string;
  readonly byteLength: number;
  readonly identity: FileIdentity;
};

export type WorkspaceEntry = {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly byteLength: number;
};

export type WalkOptions = {
  readonly path?: string;
  readonly signal: AbortSignal;
  readonly maxEntries?: number;
};

export type ReadLimits = {
  readonly maxBytes: number;
};

export interface WorkspaceBoundary {
  readonly root: string;
  resolveExistingFile(path: string): Promise<ResolvedWorkspacePath>;
  resolveExistingDirectory(path?: string): Promise<ResolvedWorkspacePath>;
  resolveWriteTarget(path: string): Promise<ResolvedWorkspacePath>;
  walk(options: WalkOptions): AsyncIterable<WorkspaceEntry>;
  readTextFile(path: string, limits: ReadLimits): Promise<TextFileSnapshot>;
  atomicWrite(target: ResolvedWorkspacePath, content: string): Promise<void>;
  replaceSnapshot(snapshot: TextFileSnapshot, content: string): Promise<void>;
}

export type ToolExecutionContext = {
  readonly workspace: WorkspaceBoundary;
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
};

export type ToolPathResolution =
  | "existing-file"
  | "existing-directory"
  | "write-target";

export type ToolPermissionTarget =
  | {
      readonly kind: "path";
      readonly requestedPath: string;
      readonly resolution: ToolPathResolution;
      readonly byteLength?: number;
    }
  | {
      readonly kind: "command";
      readonly command: string;
      readonly cwd?: string;
    }
  | {
      readonly kind: "context";
      readonly reference: string;
    };

export type ToolPermissionDescriptor<TInput> = {
  readonly targetKind: ToolPermissionTarget["kind"];
  resolve(input: TInput): ToolPermissionTarget;
};

export interface Tool<TInput, TOutput extends JsonValue = JsonValue> {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: ToolInputSchema<TInput>;
  readonly mutability: ToolMutability;
  readonly permission: ToolPermissionDescriptor<TInput>;
  execute(
    input: TInput,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult<TOutput>>;
}

export type ModelToolDefinition = {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: JsonObject;
  };
};

export function emptyResultMeta(durationMs = 0): ToolResultMeta {
  return { durationMs, truncated: false, truncatedFields: [] };
}

export function toolFailure(
  kind: ToolErrorKind,
  message: string,
  options: {
    readonly retryable?: boolean;
    readonly durationMs?: number;
    readonly sideEffect?: SideEffectState;
    readonly issues?: readonly SchemaIssue[];
  } = {},
): ToolExecutionResult {
  return {
    ok: false,
    error: {
      kind,
      message,
      retryable: options.retryable ?? false,
      issues: options.issues,
    },
    sideEffect: options.sideEffect ?? "none",
    meta: emptyResultMeta(options.durationMs),
  };
}
