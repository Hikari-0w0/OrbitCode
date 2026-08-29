import type { AgentMode } from "@/core/agent-events";
import {
  ToolRegistry,
  type PreparedToolCall,
  type ToolPreparationResult,
} from "@/tools/registry";
import {
  toolFailure,
  type ModelToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolMutability,
  type ToolName,
} from "@/tools/types";

const PLAN_TOOL_NAMES: ReadonlySet<ToolName> = new Set([
  "read_file",
  "find_files",
  "search_code",
]);

export type ToolAccessDecision =
  | { readonly kind: "allowed"; readonly mutability: ToolMutability }
  | { readonly kind: "denied" }
  | { readonly kind: "unknown" };

export interface ToolAccess {
  definitions(): readonly ModelToolDefinition[];
  classify(name: string): ToolAccessDecision;
  prepare(name: string, rawArguments: unknown): ToolPreparationResult;
  executePrepared(
    call: PreparedToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
  execute(
    name: string,
    rawArguments: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}

export class ModeToolPolicy implements ToolAccess {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly mode: AgentMode,
  ) {}

  definitions(): readonly ModelToolDefinition[] {
    return this.registry
      .descriptors()
      .filter((descriptor) => this.isAllowed(descriptor.name))
      .map((descriptor) => descriptor.definition);
  }

  classify(name: string): ToolAccessDecision {
    const descriptor = this.registry.descriptor(name);
    if (!descriptor) return { kind: "unknown" };
    if (!this.isAllowed(descriptor.name)) return { kind: "denied" };
    return { kind: "allowed", mutability: descriptor.mutability };
  }

  execute(
    name: string,
    rawArguments: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const prepared = this.prepare(name, rawArguments);
    return prepared.kind === "failure"
      ? Promise.resolve(prepared.result)
      : this.executePrepared(prepared.call, context);
  }

  prepare(name: string, rawArguments: unknown): ToolPreparationResult {
    const decision = this.classify(name);
    if (decision.kind === "denied") {
      return {
        kind: "failure",
        result: toolFailure(
          "permission-denied",
          `当前 ${this.mode === "plan" ? "Plan" : "Do"} 模式不允许执行工具：${name}`,
          { retryable: true },
        ),
      };
    }
    return this.registry.prepare(name, rawArguments);
  }

  executePrepared(
    call: PreparedToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (!this.isAllowed(call.name)) {
      return Promise.resolve(
        toolFailure("permission-denied", "当前 Agent 模式不允许执行该工具。", {
          retryable: true,
        }),
      );
    }
    return call.execute(context);
  }

  private isAllowed(name: ToolName): boolean {
    return this.mode === "do" || PLAN_TOOL_NAMES.has(name);
  }
}

export function createModeToolPolicy(
  registry: ToolRegistry,
  mode: AgentMode,
): ModeToolPolicy {
  return new ModeToolPolicy(registry, mode);
}
