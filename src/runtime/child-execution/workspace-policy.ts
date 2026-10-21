import type { AgentRole } from "@/core/sub-agents/types";
import type { ToolDescriptor } from "@/tools/registry";
import type { TaskWorkspaceAccess } from "@/runtime/workspace-execution-coordinator";

export function childWorkspaceAccess(
  parentTools: ReadonlySet<string>,
  descriptors: readonly ToolDescriptor[],
  role?: AgentRole,
): TaskWorkspaceAccess {
  const mutability = new Map<string, ToolDescriptor["mutability"]>(descriptors.map(tool => [tool.name, tool.mutability]));
  for (const name of parentTools) {
    if (name === "agent" || role && (!role.allowedTools.includes(name) || role.disallowedTools.includes(name))) continue;
    // 缺失元数据、命令及外部工具都不能被推断为只读。
    if (mutability.get(name) !== "read-only") return "exclusive";
  }
  return "read-only";
}
