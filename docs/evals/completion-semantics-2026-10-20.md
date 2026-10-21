# 完成报告语义与父 Agent 汇总改进验收（2026-10-20）

> 历史版本记录：report_completion现已撤下，当前行为见[移除决策与验收](report-completion-removal-2026-10-20.md)。以下数字与结论保留原执行时状态。
本轮按用户授权，优先改善完成报告纠错及父汇总准确性，沿用已批准的子 Agent 规格。没有新增依赖、放宽证据校验或增加纠错次数。

新增 **15个有效真实模型样本：复核14通过、1部分通过、0失败**。其中CLI五状态各2例、Web HTTP/SSE两例、原始代码修复两例、tmux单行输入一例。另有**1个无效tmux夹具**，已发生的模型请求与日志保留，未冒充有效样本或从成本中抹去。

原始自动断言15例均通过，但原始修复第1例只满足制品与交接断言，未提交子完成报告；按本轮完整性复核改为部分通过。原始results不修改，复核理由在[聚合摘要](../../tmp/agent-evals/completion-semantics-report-20261020/summary.json)。这不是一般成功率，也不能声称模型已经不会漏报。

## 实现

- `CompletionTracker.reportCorrection()` 提供最多16条本轮成功只读/命令验证候选、是否在最后写入之后及省略数；不复制命令参数、文件路径或输出。候选不自动证明检查项语义匹配或需求覆盖。开始新轮次后不会返回旧证据。
- `report_completion` 字段描述和AgentLoop纠错消息明确：checks描述当前最终验收；已修复的历史失败在过程说明保留，不为留历史而记成not-run/blocker；仍失败/未验证需求不能删除。接受器拒绝时在output.reportCorrection附纠错指引和候选，原error.issues仍保留。字段格式/长度等在执行前被Schema拒绝时仍返回原参数错误，不承诺所有解析失败都带候选。
- 现有首次提交加一次纠正预算保持。失败引用、只写入证据、过期验证、错误质量门禁和其他证据规则均未放宽；不自动生成passed检查或修改模型报告。
- `handoff.completionReports` 从实际工具结果记录attempts/accepted/rejected/lastAttempt，投递截断仍保留。调用被接受与最终verification分离：之后写入或报告再次被拒绝，当前验证仍可失效。旧结果没有该字段时保持缺失，不能据累计failures猜测提交过程。
- 父系统指令区分历史失败、报告调用状态、最终验收，不能把“曾被拒绝”说成“最终未提交”，也不能把“曾被接受”说成“当前已验证”。子工具ID不变成父本轮证据。
- 新 `scripts/run-completion-real-evals.ts` 对同一组状态案例提供CLI/Web两种入口，使用已有运行时、Provider和工具；父JSON汇总逐字段对照真实子状态。该入口只覆盖本轮完成报告场景，尚未把原三模块Web协作等全部合并。

## 新增样本

| 样本 | 复核结果 | 证据子目录 |
| --- | --- | --- |
| `cli-recovered-1` | 通过 | `cli-recovered-1-ZaSUsX` |
| `cli-rejected-1` | 通过 | `cli-rejected-1-xvuKiH` |
| `cli-late-write-1` | 通过 | `cli-late-write-1-KJnrTU` |
| `cli-no-report-1` | 通过 | `cli-no-report-1-mxV7Iz` |
| `cli-blocked-1` | 通过 | `cli-blocked-1-e5hNrN` |
| `cli-recovered-2` | 通过 | `cli-recovered-2-ieJFG1` |
| `cli-rejected-2` | 通过 | `cli-rejected-2-XLkpnU` |
| `cli-late-write-2` | 通过 | `cli-late-write-2-ZZLNRc` |
| `cli-no-report-2` | 通过 | `cli-no-report-2-xFLGX3` |
| `cli-blocked-2` | 通过 | `cli-blocked-2-0yB6Ar` |
| `repair-1` | 部分通过 | `repair-1-9RslRj` |
| `repair-2` | 通过 | `repair-2-zu3nkG` |
| `web-recovered-1` | 通过 | `web-recovered-1-ZFZ7QC` |
| `web-rejected-1` | 通过 | `web-rejected-1-fgFhWW` |
| tmux 单行 recovered | 通过 | `completion-semantics-terminal-final-20261020/` |

CLI根：`tmp/agent-evals/completion-semantics-cli-20261020/`；原任务根：`completion-semantics-repair-20261020/`；两份Web根分别为`completion-semantics-web-recovered-20261020/`、`completion-semantics-web-rejected-20261020/`，均在tmp/agent-evals下。

## 实际观察

### 报告调用状态与父汇总

| 场景 | 报告事实 | 最终verification | CLI次数 |
| --- | --- | --- | ---: |
| 拒绝后纠正 | 2次：1接受/1拒绝，最后accepted | verified | 2 |
| 两次拒绝 | 2次：0接受/2拒绝，最后rejected | unverified | 2 |
| 接受后再写入 | 1次接受，最后accepted | unverified | 2 |
| 没有报告 | 0次，lastAttempt=none | unverified | 2 |
| 接受但未完成全部范围 | 1次接受，最后accepted | blocked | 2 |

五状态CLI 10/10、Web接受与拒绝2/2、tmux recovered 1/1均通过运行时事实及父JSON汇总断言，合计13/13。父不能把子最终文本替代这些字段。负向用例中的unverified/blocked是预期状态，不是将任务失败粉饰成成功。

本地替身的完整原生循环另覆盖实际读取、拒绝报告、纠正、后续写入失效、队列投递；评测器反例测试证明错误父汇总和只改子最终文本不会被放行。真实CLI纠错证据见每例report-correction-audit.json，保留实际反馈及后续报告参数；不是用伪造模型回答代替真实服务。

### 原始修复任务：一例完整、一例部分

`repair-2-zu3nkG`：首次node check.mjs退出1，修复calc.mjs后同命令退出0；原check.mjs逐字保持，独立扩展输入通过。报告先拒绝一次，纠正后接受，最终verified。父准确说明历史复现失败及报告纠错，不再误称最终报告未提交。

`repair-1-9RslRj`：相同原任务和预算，制品、原命令复验及独立扩展输入通过；但子没有调用report_completion，completionReports全部为0、lastAttempt=none，最终unverified。父如实指出未提交，并未因命令退出0宣称完整验收。此例按制品通过、报告完整性部分通过保留，不自动补造报告、不重新抽样替代。

两次均未把修复前预期失败误记为最终not-run；但两例不足以证明这类语义错误不会再发生，尤其漏报仍然存在。

### tmux无效夹具与有效重跑

首次在`completion-semantics-terminal-20261020/`粘贴多行prompt，终端按换行提交，首行只有“子prompt如下”，后续正文被正在生成保护拒绝。该次确实产生了不完整任务及真实模型请求，标为无效夹具，保存tmux-invalid-paste.txt、原配置/检查点/原生日志及invalid-fixture.json。它不进入15个有效样本，但纳入运行用量。

随后在新隔离Workspace/数据目录，以相同任务内容的单行输入完成有效复测。实际创建子任务、wait至终态、消费交接，父最终JSON为2次报告、1接受/1拒绝、lastAttempt=accepted、verification=verified。退出码0，两份本次tmux会话和缓冲均已清理；没有覆盖首个夹具。

## 工程验证与用量

- 全量 `npm test`：**702通过，0失败/跳过**。包括本轮候选边界/跨轮隔离、失败和过期证据拒绝、报告计数、截断、四个原生循环场景和评测器反例。
- 按顺序执行lint、typecheck、build均退出0，git diff --check通过。无依赖文件改动、无提交/推送/PR。
- 当前已有配置deepseek-flash、实际OpenAI兼容服务；每例独立Workspace/配置/数据，记忆提取关闭，命令继续用现有沙箱。本轮没有放宽权限、增加运行上限或报告纠错预算。
- 原生日志32条runId不重复，包含无效tmux夹具2条；scope=self汇总112次Provider stream调用，112次有usage：输入675,532、输出14,458、总计689,990 tokens。不重复计父子聚合，不将调用数当作底层HTTP重试数或费用估算。
- 精确凭据扫描及最终源码哈希见本地credential-scan.json/source-hashes.json。只扫描本轮目录、精确匹配当前配置凭据，不代表任意秘密检测；凭据未写入源码或报告。
- 运行时均关闭，Web端口63805/63843与PID释放，两个tmux退出0，MCP测试进程无遗留。见cleanup-final.json。日志/运行记录/配置/生成文件均在忽略目录，无凭据评测脚本和脱敏报告是入库候选。
- 本轮未修改页面；Web证据为实际HTTP/SSE，不声称重新做了浏览器界面验收。

## 复现与剩余边界

```bash
npx tsx --tsconfig tsconfig.json scripts/run-completion-real-evals.ts \
  --root=tmp/agent-evals/completion-retest-<新的唯一目录> \
  --case=all --repeat=2 --transport=cli \
  --allow-real-model --provider=<现有Provider配置名>
```

case可选recovered/rejected/late-write/no-report/blocked/all；transport可选cli/web。Web运行需确保本仓库没有其他Next开发服务占用开发锁；评测不关闭用户已有服务。目录已存在则拒绝覆盖，失败保留且退出1。

本轮改善了事实来源和纠错反馈，保留证据校验；尚未强制所有模型在每次写入后都提交有效报告。语义匹配和需求完整性仍需要独立验收，verified只覆盖所列检查；13个状态汇总样本不证明任意自然语言总结都可靠。没有新增上下文搜索、容量预诊断、文件所有权或缓存收益对照实验。
