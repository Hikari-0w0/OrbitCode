import type { AgentMode } from "@/core/agent-events";
import { ToolRegistry } from "@/tools/registry";
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
    const decision = this.classify(name);
    if (decision.kind === "unknown") {
      return this.registry.execute(name, rawArguments, context);
    }
    if (decision.kind === "denied") {
      return Promise.resolve(
        toolFailure(
          "permission-denied",
          `当前 ${this.mode === "plan" ? "Plan" : "Do"} 模式不允许执行工具：${name}`,
          { retryable: true },
        ),
      );
    }
    return this.registry.execute(name, rawArguments, context);
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
