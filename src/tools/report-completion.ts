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
      "在最终回复前提交结构化完成检查。根据用户目标列出验收项，包括未验证的需求（not-run），不要只列已经通过的命令。运行时 verified 仅表示所列检查通过证据规则，不保证需求覆盖完整。evidence_call_ids 必须逐字复制工具结果中的 evidence_call_id，passed 的所有引用必须成功，且须包含成功的只读或命令验证，写入成功本身不算验证。证据必须直接证明 criterion：文件列表只证明存在，HTTP 响应不证明客户端交互，build、lint 等检查必须引用对应命令。已失败的质量门禁须修复并重跑成功，否则只能报告 partial/blocked；存在写入时，complete 还必须引用最后写入后的验证结果。checks 描述最终验收状态，不是操作流水账；已修复的历史失败在最终回复中说明，仍失败或未验证的需求必须保留。若复现失败本身是验收要求，用断言预期错误的验证脚本产生成功证据。收到 error.issues 后按路径逐项修正，必要时补充验证，不要仅改措辞或重复原报告。",
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
        : toolFailure("invalid-arguments", accepted.message, { retryable: true, issues: accepted.issues });
    },
  });
}
