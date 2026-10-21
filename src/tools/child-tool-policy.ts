import type { AgentRole } from "@/core/sub-agents/types";
import type { ToolAccess } from "./mode-policy";
import type { PreparedToolCall, ToolPreparationResult } from "./registry";
import { toolFailure, type ToolExecutionContext, type ToolExecutionResult } from "./types";
export function childToolNames(parent: ReadonlySet<string>, role?: AgentRole): ReadonlySet<string> {
  return new Set([...parent].filter(name => name !== "agent" && (!role || role.allowedTools.includes(name) && !role.disallowedTools.includes(name))));
}
export class ChildToolPolicy implements ToolAccess {
  private readonly tools: ReadonlySet<string>;
  constructor(private readonly base: ToolAccess, parent: ReadonlySet<string>, role?: AgentRole, private readonly current?: () => Promise<ReadonlySet<string>>) { this.tools = childToolNames(parent, role); }
  private allowed(name: string) { return this.tools.has(name); }
  definitions() { return this.base.definitions().filter(item => this.allowed(item.function.name)); }
  classify(name: string) { return this.allowed(name) ? this.base.classify(name) : { kind: "denied" as const }; }
  prepare(name: string, input: unknown): ToolPreparationResult { return this.allowed(name) ? this.base.prepare(name, input) : { kind: "failure", result: toolFailure("permission-denied", "子 Agent 工具限制不允许此调用。") }; }
  async executePrepared(call: PreparedToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult> { const current = await this.current?.(); return this.allowed(call.name) && (!current || current.has(call.name)) ? this.base.executePrepared(call, context) : Promise.resolve(toolFailure("permission-denied", "子 Agent 工具限制不允许此调用。")); }
  execute(name: string, input: unknown, context: ToolExecutionContext) { const prepared = this.prepare(name, input); return prepared.kind === "failure" ? Promise.resolve(prepared.result) : this.executePrepared(prepared.call, context); }
}
