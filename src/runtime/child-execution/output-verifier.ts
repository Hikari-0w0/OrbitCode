import { createHash } from "node:crypto";
import type { ChildOutputAssessment, ChildOutputContract } from "@/core/sub-agents/output-contract";
import type { ToolExecutionContext, ToolExecutionResult } from "@/tools/types";
import { toolFailure } from "@/tools/types";
import { readFileTool } from "@/tools/read-file";
import type { PermissionGateway } from "@/tools/permission-gateway";
import type { WorkspaceExecutionCoordinator } from "@/runtime/workspace-execution-coordinator";

export async function assessChildOutput(contract: ChildOutputContract, read: (path: string) => Promise<ToolExecutionResult>): Promise<ChildOutputAssessment> {
  const artifacts: ChildOutputAssessment["artifacts"][number][] = [];
  for (const file of contract.files) {
    const result = await read(file.path);
    if (!result.ok) {
      artifacts.push({ path: file.path, status: result.error.kind === "not-found" ? "failed" : "not-run", errorKind: result.error.kind }); continue;
    }
    const output = result.output;
    if (!output || typeof output !== "object" || Array.isArray(output) || !("content" in output) || typeof output.content !== "string") {
      artifacts.push({ path: file.path, status: "not-run", errorKind: "invalid-read-result" }); continue;
    }
    const sha256 = createHash("sha256").update(output.content).digest("hex");
    const passed = (file.contains === undefined || output.content.includes(file.contains)) && (file.sha256 === undefined || file.sha256 === sha256);
    artifacts.push({ path: file.path, status: passed ? "passed" : "failed", sha256, byteLength: Buffer.byteLength(output.content) });
  }
  return { version: 1, scope: "declared-file-checks-only", checkedAt: new Date().toISOString(),
    status: artifacts.some(file => file.status === "failed") ? "failed" : artifacts.some(file => file.status === "not-run") ? "not-run" : "passed", artifacts };
}

// 验收不执行模型提供的命令；只经现有工具、动态能力、父权限及工作区协调重读声明文件。
type ArtifactReadInput = {
  readonly path: string; readonly context: ToolExecutionContext; readonly tools: () => Promise<ReadonlySet<string>>;
  readonly gateway: PermissionGateway; readonly writes: Pick<WorkspaceExecutionCoordinator, "acquireRead">;
};

export async function readOutputArtifact(input: ArtifactReadInput): Promise<ToolExecutionResult> {
  try { return await readAuthorizedArtifact(input); }
  catch { return toolFailure(input.context.signal.aborted ? "cancelled" : "execution-failed", "文件验收读取未完成。"); }
}

async function readAuthorizedArtifact(input: ArtifactReadInput): Promise<ToolExecutionResult> {
  if (!(await input.tools()).has("read_file")) return toolFailure("permission-denied", "当前父级能力不允许读取验收文件。");
  const prepared = readFileTool.prepareUnknown({ path: input.path });
  if (prepared.kind === "failure") return prepared.result;
  const permission = await input.gateway.authorize(prepared.call, `${input.context.callId ?? "verify"}:artifact`, input.context.signal);
  if (permission.kind !== "allowed") return permission.kind === "denied" ? permission.result : toolFailure("permission-denied", "文件验收不自动请求新的审批。");
  const release = await input.writes.acquireRead(input.context.workspace.root, input.context.signal);
  try {
    if (!(await input.tools()).has("read_file")) return toolFailure("permission-denied", "验收读取能力已撤销。");
    const denied = await permission.revalidate(input.context.signal);
    return denied ?? await prepared.call.execute({ ...input.context, deadlineMs: Math.min(input.context.deadlineMs, Date.now() + 10000) });
  } finally { release(); }
}
