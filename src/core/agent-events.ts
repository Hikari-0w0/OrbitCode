import type { PermissionPrompt } from "@/core/permissions/approval";
import type { CompletionAssessment } from "@/core/completion-tracker";
import type { PermissionResolutionStatus } from "@/core/tool-scheduler";
import type {
  AssistantMessage,
  ModelRequestStage,
  ModelToolCall,
  PromptCacheUsage,
} from "@/models/provider";
import type { SideEffectState, ToolExecutionResult } from "@/tools/types";

export type AgentMode = "plan" | "do";
export type AgentIterationLimit = number | "unlimited";

export type AgentStopReason =
  | "final-response"
  | "max-iterations"
  | "max-runtime"
  | "cancelled"
  | "repeated-unknown-tool"
  | "repeated-tool-failure"
  | "context-error"
  | "context-capacity"
  | "context-circuit-open"
  | "model-error"
  | "agent-error";

export type AgentProgressPhase = "model" | "tools";

export type TokenUsage =
  | {
      readonly availability: "reported";
      readonly promptTokens: number;
      readonly completionTokens: number;
      readonly totalTokens: number;
      readonly promptCache: PromptCacheUsage;
    }
  | { readonly availability: "unavailable" };

export type AgentEvent =
  | {
      readonly type: "progress";
      readonly iteration: number;
      readonly maxIterations: AgentIterationLimit;
      readonly phase: AgentProgressPhase;
      readonly model?: {
        readonly stage: ModelRequestStage;
        readonly elapsedMs: number;
        readonly attempt: number;
        readonly traceId?: string;
        readonly toolName?: string;
        readonly toolArgumentsChars?: number;
      };
      readonly completedTools?: number;
      readonly totalTools?: number;
    }
  | {
      readonly type: "text-delta";
      readonly iteration: number;
      readonly text: string;
    }
  | {
      readonly type: "tool-call";
      readonly iteration: number;
      readonly call: ModelToolCall;
      readonly sequence: number;
    }
  | {
      readonly type: "tool-started";
      readonly iteration: number;
      readonly callId: string;
      readonly name: string;
      readonly sequence: number;
    }
  | {
      readonly type: "permission-requested";
      readonly iteration: number;
      readonly callId: string;
      readonly name: string;
      readonly sequence: number;
      readonly prompt: PermissionPrompt;
    }
  | {
      readonly type: "permission-resolved";
      readonly iteration: number;
      readonly callId: string;
      readonly name: string;
      readonly sequence: number;
      readonly requestId: string;
      readonly status: PermissionResolutionStatus;
      readonly scope?: "once" | "session" | "permanent";
    }
  | {
      readonly type: "tool-result";
      readonly iteration: number;
      readonly callId: string;
      readonly name: string;
      readonly sequence: number;
      readonly result: ToolExecutionResult;
    }
  | {
      readonly type: "token-usage";
      readonly iteration: number;
      readonly usage: TokenUsage;
      readonly cumulative: TokenUsage;
    }
  | {
      readonly type: "stopped";
      readonly reason: AgentStopReason;
      readonly iterations: number;
      readonly durationMs: number;
      readonly sideEffect: SideEffectState;
      readonly finalMessage?: AssistantMessage;
      readonly detail?: string;
      readonly verification?: CompletionAssessment;
    };
