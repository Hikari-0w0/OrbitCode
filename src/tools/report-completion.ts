import {
  type CompletionReportInput,
  type CompletionTracker,
} from "@/core/completion-tracker";
import { defineTool, successfulToolResult } from "@/tools/registry";
import {
  arraySchema,
  enumSchema,
  objectSchema,
  optionalSchema,
  stringSchema,
} from "@/tools/schema";
import { toolFailure } from "@/tools/types";

const reportSchema = objectSchema({
  status: optionalSchema(enumSchema(["complete", "partial", "blocked"] as const)),
  checks: arraySchema(objectSchema({
    scope: optionalSchema(enumSchema(["external-call"] as const)),
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
      "执行本地工具后提交结构化完成检查。提交 checks 和 blockers 即可，汇总状态由运行时计算；旧 status 字段仅兼容读取，不能覆盖失败或未验证项。根据用户目标列出检查，包括 failed 和 not-run，不要只列通过的命令。verified 仅表示所列检查通过证据规则，不保证需求覆盖完整。evidence_call_ids 须逐字复制本轮工具结果的 evidence_call_id；passed 的所有引用须成功，且至少包含匹配的只读或命令验证，写入成功不能替代验证。发生写入后，完整验证须引用最后写入后的验证。失败的质量门禁须修复重跑，或保留 failed/not-run。证据必须匹配 criterion：文件列表只证明存在；HTTP 可通过 curl、脚本或 Node 测试验证，但不证明浏览器交互；build、lint 须引用对应命令。预期错误须用断言脚本产生成功证据。只执行外部工具时无需本报告；混合任务的外部返回检查设置 scope=external-call，只引用一次成功外部调用，不证明外部副作用。报告失败后按 error.issues 修正一次；仍失败则直接总结已有结果和未验证项，不重复调用工具、重做已成功的操作或打印固定文本补证据。已修复的历史失败在最终回复说明。",
    inputSchema: reportSchema,
    // 报告本身无副作用，但必须在此前工具全部收敛后串行评估。
    mutability: "workspace-write",
    permission: {
      targetKind: "context",
      resolve: () => ({ kind: "context", reference: "completion-report" }),
    },
    async execute(input) {
      const report: CompletionReportInput = {
        ...(input.status === undefined ? {} : { status: input.status }),
        checks: input.checks.map((check) => ({
          ...(check.scope === undefined ? {} : { scope: check.scope }),
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
