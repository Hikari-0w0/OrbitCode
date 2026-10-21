import type { ParentExecutionContract } from "@/core/sub-agents/parent-execution";
import type { ToolAccess } from "./mode-policy";
import type { PreparedToolCall, ToolPreparationResult } from "./registry";
import { toolFailure, type ToolExecutionContext } from "./types";

// 这是父级编排职责，不能作为子任务的能力上限，否则只委派模式会同时禁掉子工具。
export class ParentExecutionPolicy implements ToolAccess {
  constructor(private readonly base: ToolAccess, private readonly contract: ParentExecutionContract) {}
  private allowed(name: string) { return this.contract.mode === "collaborate" || name === "agent"; }
  private denied() { return toolFailure("permission-denied", "本轮父级仅可委派、控制任务与读取子结果；需要接管时由用户切换协作模式。", { retryable: false }); }
  definitions() { return this.base.definitions().filter(tool => this.allowed(tool.function.name)); }
  classify(name: string) { return this.allowed(name) ? this.base.classify(name) : { kind: "denied" as const }; }
  prepare(name: string, args: unknown): ToolPreparationResult { return this.allowed(name) ? this.base.prepare(name, args) : { kind: "failure", result: this.denied() }; }
  executePrepared(call: PreparedToolCall, context: ToolExecutionContext) { return this.allowed(call.name) ? this.base.executePrepared(call, context) : Promise.resolve(this.denied()); }
  execute(name: string, args: unknown, context: ToolExecutionContext) { const prepared = this.prepare(name, args); return prepared.kind === "failure" ? Promise.resolve(prepared.result) : this.executePrepared(prepared.call, context); }
}
