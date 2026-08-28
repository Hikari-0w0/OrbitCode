import type { AssistantMessage, ModelToolCall } from "@/models/provider";
import type { SideEffectState, ToolExecutionResult } from "@/tools/types";

export type AgentMode = "plan" | "do";

export type AgentStopReason =
  | "final-response"
  | "max-iterations"
  | "cancelled"
  | "repeated-unknown-tool"
  | "model-error"
  | "agent-error";

export type AgentProgressPhase = "model" | "tools";

export type TokenUsage =
  | {
      readonly availability: "reported";
      readonly promptTokens: number;
      readonly completionTokens: number;
      readonly totalTokens: number;
    }
  | { readonly availability: "unavailable" };

export type AgentEvent =
  | {
      readonly type: "progress";
      readonly iteration: number;
      readonly maxIterations: number;
      readonly phase: AgentProgressPhase;
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
      readonly sideEffect: SideEffectState;
      readonly finalMessage?: AssistantMessage;
      readonly detail?: string;
    };
