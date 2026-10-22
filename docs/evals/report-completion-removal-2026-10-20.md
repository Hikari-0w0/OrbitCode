# 移除 report_completion 的决策与验收（2026-10-20）

用户明确授权“如果影响Agent潜力和性能就去除”。本轮检查确认存在额外模型请求和报告专属强制收尾，因此已撤下模型可调用的report_completion及其提交、校验、纠错和收尾门禁；不是继续补报告Schema。按本轮授权更新四份规格，旧报告方案作为历史记录。

**21个真实模型场景全部通过，40条原生运行日志中的报告工具调用为0；204次有录制的出站请求中不包含该工具定义。现行678项自动测试、lint、typecheck、build通过。** 原始工具失败与复验记录保留，制品继续独立验证，不用“没有报告调用”替代任务正确性。

## 为什么撤下

前三批非报告专项评测的原生工具记录：

| 历史证据根（tmp/agent-evals下） | 原生运行数 | 报告调用 | 被拒绝 |
| --- | ---: | ---: | ---: |
| sub-agents-real-20261019 | 100 | 28 | 9 |
| sub-agents-improvement-20261020 | 22 | 14 | 6 |
| sub-agents-improvement-final-20261020 | 22 | 15 | 5 |
| 合计 | 144 | 57 | 20 |

它们是有限评测分布，包含不同任务和开发阶段，不能推导一般拒绝率或把20次拒绝当成20个任务失败。拒绝往往是旧规则正常起作用；问题在于把模型填写结构化自报当成执行门禁。

原AgentLoop在两次报告invalid-arguments后隐藏全部工具，只允许最终回复；即使还有合法工具工作可做，也进入报告专属收尾。报告首次不可见、执行本地工具后再加入，还增加了工具Schema及提示负担。模型自报本身又不能证明需求覆盖完整。这些成本和执行限制足以支持用户授权的移除条件；没有声称模型基础能力变弱或测得通用性能下降百分比。

## 当前行为

- 删除工具实现、工具Schema、默认注册及LocalToolName项，模型不再看到或调用它；删除报告失败计数、finalOnly提示/工具隐藏和专属兜底回复。
- 删除CompletionTracker的accept/reportCorrection/markReportFailure及报告质量声明判定。它现在只分配本轮证据ID、保持既有纯外部调用observed事实和严格历史Assessment读取。工具事实继续由现有循环、会话和运行日志记录。
- 去除系统提示、内置角色/Skill的提交要求，完成必要操作和验证后直接总结结果、实际检查、历史失败及未验证范围。不会为了改变“报告状态”再消耗模型轮次。
- 新本地运行保守保持unverified，即“运行时未自动判定整任务验收”；这不否认命令/测试实际执行，也不因没有已撤下的报告而判为任务失败。命令退出0、文件写入成功或最终文本仍不自动证明全部需求完成。独立制品验收继续是评测依据。
- 子结果继续包含停止原因、失败、副作用、命令原始退出码、文件工具确认写入及用量；不再新生成completionReports。旧字段、旧verified/partial/blocked数据继续可读，历史完整工具交换保持配对。
- 旧角色/Skill元数据中的report_completion被明确过滤，不扩大白名单；只含该名称的白名单仍为空。未知名称、重复项和权限限制继续校验。用户已有正文不被自动重写，旧历史若再次请求不可用名称会走普通未知工具处理，不恢复该工具。
- 权限、工作区边界、命令沙箱、通用未知工具/失败预算、取消、最大轮次和时限保持。移除的是自报门禁，不是这些执行约束。

旧工具及专属测试/评测入口源码存于忽略目录retired-code/，历史报告描述当时版本；不再保留可执行的旧报告评测入口。普通上下文压缩对旧报告交换的读取保护仍作为历史兼容保留，不会注册新工具。

## 全部真实样本

| 样本 | 结果 | 证据子目录 |
| --- | --- | --- |
| `fork-1` | 通过 | `fork-1-mRMwyP` |
| `offload-1` | 通过 | `offload-1-HyBRKr` |
| `collaboration-1` | 通过 | `collaboration-1-RfHVR2` |
| `repair-1` | 通过 | `repair-1-TWqD5y` |
| `fork-2` | 通过 | `fork-2-Q1UnwG` |
| `offload-2` | 通过 | `offload-2-NgQmAl` |
| `collaboration-2` | 通过 | `collaboration-2-h9jief` |
| `repair-2` | 通过 | `repair-2-WqX9IB` |
| `cli-direct-1` | 通过 | `cli-direct-1-tkkt0W` |
| `cli-delegated-1` | 通过 | `cli-delegated-1-NGJPcz` |
| `cli-legacy-skill-1` | 通过 | `cli-legacy-skill-1-GriGCj` |
| `cli-legacy-role-1` | 通过 | `cli-legacy-role-1-wZODLg` |
| `cli-legacy-history-1` | 通过 | `cli-legacy-history-1-OGChw2` |
| `cli-direct-2` | 通过 | `cli-direct-2-FJzGIb` |
| `cli-delegated-2` | 通过 | `cli-delegated-2-O454iV` |
| `cli-legacy-skill-2` | 通过 | `cli-legacy-skill-2-JFCFjN` |
| `cli-legacy-role-2` | 通过 | `cli-legacy-role-2-K3TTPC` |
| `cli-legacy-history-2` | 通过 | `cli-legacy-history-2-A7oyyk` |
| `web-direct-1` | 通过 | `web-direct-1-xj93y2` |
| `web-delegated-1` | 通过 | `web-delegated-1-ZIQoYv` |
| `tmux-direct` | 通过 | `report-tool-removal-terminal-20261020` |

原矩阵根：`tmp/agent-evals/report-tool-removal-real-20261020/`（Fork标记、引用迁移、三模块协作、原修复，各2次）。兼容根：`report-tool-removal-compat-20261020/`（direct/delegated/legacy-skill/legacy-role/legacy-history，各2次）。Web两例分别在report-tool-removal-web-direct-20261020和report-tool-removal-web-delegated-20261020；tmux在report-tool-removal-terminal-20261020。完整目录和结果见[本地汇总](../../tmp/agent-evals/report-tool-removal-20261020/summary.json)。

### 正确性与执行闭环

- 两次三模块协作仍有三个独立子任务，制品通过工作区外定义、在原沙箱执行的23项契约断言；父分工遵守仍单独检查，不降低原业务要求。
- 原修复及直接/委派/旧配置测试均先实际执行node check.mjs并观察退出1，再修改calc.mjs、原命令退出0，原check.mjs逐字保持，扩展输入独立通过。不是删除断言、修改原测试或仅相信最终回复。
- 两次旧Skill、两次旧角色实际加载含已撤下名称的配置后完成工作，没有工具复活。两次legacy-history显式构造旧报告工具交换，当前真实模型请求保持历史配对，仍直接修复并复验，实际报告调用0。构造历史是评测初态，不称为真实先前业务对话。
- Web两例经过实际HTTP/SSE、共享AgentRuntime和本地工具，完成直接及委派修复，独立断言通过；页面未改动，不声称浏览器交互重新验收。
- tmux实际启动CLI并输入单行自然语言任务，5个模型轮次完成失败复现、读取、修改、原命令复验和最终总结，报告调用0。外部独立验证4组除法输入与除零通过，原check.mjs未改，退出0。
- 对18个可录制CLI样本的204个Provider层请求逐一检查toolNames，均无该工具；Web/tmux未包装同一录制器，不将204当作全部请求数。所有21例的原生日志实际报告调用均为0；主/子/独立Skill默认注册器与同一循环回归覆盖工具不可见性。

### 同一修复任务的有限开销观测

| 阶段 | 样本 | 子模型请求 | 报告调用 | 子已报告输入tokens |
| --- | --- | ---: | ---: | ---: |
| before | `repair-1-9RslRj` | 5 | 0 | 32,805 |
| before | `repair-2-zu3nkG` | 7 | 2 | 47,451 |
| after | `repair-1-TWqD5y` | 5 | 0 | 27,412 |
| after | `repair-2-WqX9IB` | 5 | 0 | 27,657 |

父任务契约及预算相同，但子prompt由模型生成、请求时间/缓存条件不同，这不是严格性能A/B。可以确认报告专属调用和门禁已经消失，不能据这四例计算普遍加速比。前一版未提交报告的样本以前因此只能部分通过；现在不再有提交义务，仍按真实制品和独立断言验收，不自动把运行时unverified改成verified。

## 工程验证

现行 `npm test` **678通过，0失败/跳过**。旧702项中的工具自报、纠错和强制收尾专属测试随功能退役，改为被动证据、历史读取、元数据过滤、defined/Fork直接完成及普通参数失败恢复检查；不是为通过测试放宽权限/安全限制。

开发中两项旧夹具需要按新行为更新：30文件用例少一次报告模型请求，期望4轮改为实际3轮；移除Schema和长提示后原超窗夹具已能容纳，增大隔离Skill参数使其仍真正超过同一窗口预算（未改窗口或限制）。新defined正向写入夹具显式使用隔离项目的permissive测试角色，未修改内置default角色或产品权限。

lint、typecheck、build依次退出0；git diff --check通过。未新增依赖、未提交/推送/创建PR。证据为regression-tests/lint/typecheck/build.txt。

本轮仍使用项目现有deepseek-flash配置和实际OpenAI兼容服务，输出8192，主24轮/6分钟，子20轮/5分钟且受角色16轮上限；各Workspace、权限与数据隔离，记忆提取关闭。40条日志runId无重复，scope=self共224次Provider stream调用，224次有usage：输入1,738,824、输出51,024、合计1,789,848 tokens。调用数不等于底层HTTP重试，不做费用或缓存加速推算。

精确凭据扫描与最终源码哈希见本地credential-scan.json/source-hashes.json；范围为本轮指定证据根，只精确匹配当前配置凭据，不是任意秘密检测。原始对话、日志、配置和生成制品忽略不入库。Web端口63616/63860和PID释放，tmux退出0、缓冲已删除，MCP测试进程无遗留；见cleanup-final.json。

## 可复现入口与边界

```bash
npx tsx --tsconfig tsconfig.json scripts/run-sub-agent-real-evals.ts \
  --root=tmp/agent-evals/report-free-matrix-<新目录> --suite=all --repeat=2 \
  --allow-real-model --provider=<现有Provider配置名>

npx tsx --tsconfig tsconfig.json scripts/run-report-free-real-evals.ts \
  --root=tmp/agent-evals/report-free-compat-<新目录> --case=all --repeat=2 \
  --transport=cli --allow-real-model --provider=<现有Provider配置名>
```

第二入口case支持direct/delegated/legacy-skill/legacy-role/legacy-history，Web本轮支持direct/delegated。已有目录拒绝覆盖，失败保留且退出1；不会自动挑选最好结果。独立验收、权限与执行预算仍需保留；移除工具不保证模型永远不漏测、不夸大或所有任务成功。后续若需要自动验收，应针对任务建立可执行断言，而不是恢复模型自报门禁。
