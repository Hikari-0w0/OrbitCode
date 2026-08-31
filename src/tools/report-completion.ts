import {
  type CompletionReportInput,
  type CompletionTracker,
} from "@/core/completion-tracker";
import { defineTool, successfulToolResult } from "@/tools/registry";
import {
  arraySchema,
  enumSchema,
  objectSchema,
  stringSchema,
} from "@/tools/schema";
import { toolFailure } from "@/tools/types";

const reportSchema = objectSchema({
  status: enumSchema(["complete", "partial", "blocked"] as const),
  checks: arraySchema(objectSchema({
    criterion: stringSchema({ minLength: 1, maxLength: 200 }),
    status: enumSchema(["passed", "failed", "not-run"] as const),
    evidence_call_ids: arraySchema(
      stringSchema({ minLength: 1, maxLength: 128 }),
      { maxItems: 16 },
    ),
  }), { minItems: 1, maxItems: 20 }),
  blockers: arraySchema(
    stringSchema({ minLength: 1, maxLength: 300 }),
    { maxItems: 10 },
  ),
});

export function createReportCompletionTool(tracker: CompletionTracker) {
  return defineTool({
    name: "report_completion",
    description:
      "在最终回复前提交结构化完成检查。evidence_call_ids 必须逐字复制工具结果中的 evidence_call_id，passed 须引用成功的只读或命令验证，写入成功本身不算验证。证据必须直接证明 criterion：文件列表只证明存在，HTTP 响应不证明客户端交互，build、lint 等检查必须引用对应命令。已失败的质量门禁须修复并重跑成功，否则只能报告 partial/blocked；存在写入时，complete 还必须引用最后写入后的验证结果。",
    inputSchema: reportSchema,
    // 报告本身无副作用，但必须在此前工具全部收敛后串行评估。
    mutability: "workspace-write",
    permission: {
      targetKind: "context",
      resolve: () => ({ kind: "context", reference: "completion-report" }),
    },
    async execute(input) {
      const report: CompletionReportInput = {
        status: input.status,
        checks: input.checks.map((check) => ({
          criterion: check.criterion,
          status: check.status,
          evidenceCallIds: check.evidence_call_ids,
        })),
        blockers: input.blockers,
      };
      const accepted = tracker.accept(report);
      return accepted.ok
        ? successfulToolResult(accepted.assessment)
        : toolFailure("invalid-arguments", accepted.message, { retryable: true });
    },
  });
}
