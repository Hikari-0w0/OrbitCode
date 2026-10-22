# 子 Agent 全面测试与架构评估（2026-10-20）

## 结论与范围

用户要求继续全面测试和评估。本轮只新增隔离测试产物和评估文档，没有修改 Agent、工具、权限或模型行为。`src/`、`scripts/`、`agents/`、`skills/` 的文件哈希在本轮前后相同；保留原有未提交开发状态，没有提交或推送。

当前正常委派、源码探索、代码修复、三子任务协作、全文检索和长回复交付具备较完整的有限场景证据；仍有接纳中取消的一致性缺陷、取消时执行事实丢失，以及模型历史召回不稳定。建议先收敛接纳与执行结果契约，暂不扩大到团队编排或跨进程恢复。

工程检查为 712/712 测试通过，lint、typecheck、build 均退出0。新增真实模型样本36个：31通过、5未通过。5个未通过不是5种缺陷：1个是模型历史召回失败，另4个是两轮取消/运行时关闭测试重复确认同一类命令元数据丢失。压力测试另外发现准备阶段两个接口一致性问题，其中取消问题已经实际 Runtime + HTTP handler 复现。

真实模型使用当前项目配置的 deepseek-flash。所有任务在独立 Workspace/数据目录内运行；原始产物保存在已忽略的 `tmp/agent-evals/subagent-comprehensive-20261020/`，不覆盖前轮证据。

## 覆盖矩阵

| 维度 | 本轮验证 | 结果与证据边界 |
| --- | --- | --- |
| 工程与既有安全边界 | 712项完整自动回归，包含权限、世代、审批、MCP边界、会话恢复、取消、超时、硬轮数、Web协议与CLI | 全部通过；MCP使用替身，不自动连接用户外部服务器 |
| 原始委派与复杂任务 | Fork历史、卸载引用、三子任务协作、失败后修复，各2例 | 8例7通过/1失败；两次协作均通过独立23项制品断言 |
| 源码探索 | defined/fork、错误参数恢复、4轮预算，各2例 | 8/8通过；核对实际读取、源码副本和父级只委派，解释文字不等于被形式证明 |
| 检索与类型契约 | 存在标记、字面量缺失、defined历史隔离，CLI/Web各重复2次 | 12/12通过；核对完整搜索事实、精确计数、callId、文件原文和kind |
| 长回复与低预算 | CLI/Web分别在普通和小结果预算下验证正文保存及分页 | 4/4通过；独立核对120条固定文本、尾部标记和持久化哈希 |
| 运行中取消与关闭 | 真实命令先写入启动文件，20秒后计划写入另一个文件；分别取消/关闭，共两轮 | 4例均未满足完整命令字段保留标准；复核轮确认进程已终止、终态与来源正确、未发生迟到文件写入 |
| 调度压力 | 20组固定种子，每组40任务、3个scope、并发上限4，混合取消与正常完成 | 800任务通过；每任务清理一次、无重复执行、scope隔离、单调完成序号、运行数不超过4 |
| 存储压力 | 两个ChildResultStore实例同根并发280次写入、Unicode分页、世代和损坏检查 | 256次保存、24次明确capacity拒绝；无临时文件残留，错误世代和损坏正文拒绝 |
| 检索算法独立oracle | 约56万Unicode字符，6类查询，含重叠匹配、emoji、尾部、无匹配和正则样式字面量 | 与独立逐位置匹配计数一致；计数、完整范围和省略数一致；不是16 MiB上限或并发内存基准 |
| 接纳期竞态 | 准备期间取消、同key并发重复接纳，另用真实Runtime和HTTP handler复现取消 | 确认两个manager接口问题；其中只有取消路径证明在当前HTTP入口可见 |

此前浏览器/tmux的交互证据见[上一轮报告](sub-agents-reliability-2026-10-20.md)。本轮没有重新声称完成浏览器或tmux人工交互；新的Web证据是实际生产服务的HTTP/SSE流程，CLI使用实际SessionController、工具、沙箱和模型。

## 真实模型完整分布

| 批次目录 | 样本 | 通过 | 未通过 |
| --- | ---: | ---: | ---: |
| core | 8 | 7 | 1 |
| explorer | 8 | 8 | 0 |
| reliability-cli | 6 | 6 | 0 |
| reliability-web | 6 | 6 | 0 |
| reply-cli | 1 | 1 | 0 |
| reply-cli-small | 1 | 1 | 0 |
| reply-web | 1 | 1 | 0 |
| reply-web-small | 1 | 1 | 0 |
| lifecycle | 2 | 0 | 2 |
| lifecycle-evidence | 2 | 0 | 2 |
| 合计 | 36 | 31 | 5 |

`lifecycle-evidence` 在保留原验收失败标准的同时，把进程状态、终态和交接事实保存到断言之前，避免第一轮断言失败后缺少过程证据；不是放宽标准后转为通过。所有原始失败仍保留。

去重后的原生父/子运行记录90条。自身用途统计合计332次模型请求，332次有usage，failedRequests=0，promptTokens=2,855,251、completionTokens=87,522、totalTokens=2,942,773；missingUsageRuns=0。failedRequests=0不表示任务全部通过，运行取消也可以发生在模型请求已成功、正在执行工具时。这些是原生记录中自身用途的已报告token累计，不是未缓存计费量或性能A/B。

两次三子任务协作的子运行起止区间均有3路重叠；这证明生命周期区间重叠，不证明模型请求、文件写入或CPU始终同时执行。Workspace写入仍经共用协调器串行。父级命令、写入目标和独立验收脚本另行复核：父只写index.mjs，执行检查及额外边界断言；未发现父命令改写禁止接管的两个子模块。

两次预算探索样本均主动以final-response收尾，没有真实触发max-iterations。硬轮数强制终止仍由确定性回归验证，不能把主动收尾样本写成真实触发上限。

## 三个主要发现

### 1. P2：已可见的准备中任务取消后消失，接纳结果不是一个一致的操作

**明确运行时缺陷。** `BackgroundTaskManager.start` 在prepare完成之前就把queued记录放入tasks；取消将它改为stopping，prepare返回后start的catch删除记录。与此同时cancel等待done后再get，最终得到“任务不存在”。

实际Runtime复现通过注入可释放的本地历史读取延迟，模拟Fork快照复制尚未完成。相同taskId的HTTP handler：取消前GET=200、state=queued；POST cancel=400；取消后GET=400；子模型请求数为0。不是外域访问或权限失败。首版测试遗漏Host并未等待父轮完成而产生的夹具错误单独保留，修正请求头和清理顺序后才得到有效复现。

证据：`runtime-race.json`、`runtime-race-final.txt`；taskId=`908f2c70-3b39-4278-a636-da8ac4a0ccf6`。代码集中在[接纳与失败清理](../../src/runtime/background-task-manager.ts#L40)以及[准备阶段迁移信号](../../src/runtime/agents/delegation.ts#L75)。当前迁移信号组合的是父执行信号和deadline，未接入manager自己的任务取消信号。

同一根因还表现为并发幂等问题：第一个start等待prepare时，同scope/turn/call的第二个start会立即返回queued成功；第一个prepare随后失败，记录被删除，第二个调用拿到失效ID。证据为`stress-results.json`的duplicate-preparing。该情况仅证明manager接口不一致；当前父agent工具采用barrier调度，未证明普通同会话Web模型调用能并发触发相同key，优先级低于已暴露的取消问题。

**建议整体改进：** 让接纳具有明确的preparing状态和共享接纳Promise，按scope/turn/call返回同一个接纳结论；管理器提供统一的任务取消信号给准备与执行。已对外可见的ID应在取消后保留一个可读取的终态或明确的接纳中止结果，清理和终态只发布一次。用这一个状态模型同时处理取消、超时、关闭与重复调用，不在HTTP层捕获“找不到”后伪造成功。

验收应覆盖慢复制期间的GET/取消、重复start后prepare成功与失败、关闭/超时、零重复执行、一次清理以及稳定的终态归因。

### 2. P2：取消规范化覆盖了执行器已经返回的命令事实

**明确工具执行层缺陷，影响子结果证据完整性。** 真实取消和运行时关闭后，日志仍正确记录run_command取消，子结果仍保留stopReason=cancelled、terminationSource=user/runtime-close、sideEffect=possible、cleanup=complete。但命令交接只剩errorKind=cancelled，底层stdout、stderr、exitCode、terminationSignal和cancelled字段不再进入结果。

确定性最小复现对同一个run_command执行器分别直接执行和通过ToolRegistry执行：沙箱在收到abort后返回固定stdout/stderr、exitCode=null、SIGTERM、cancelled=true；直接调用保留output，经过注册中心后output变为undefined。原因是[注册中心取消分支](../../src/tools/registry.ts#L198)在已经拿到result时重新构造了一个无output的toolFailure，丢弃执行事实。并非模型漏写，也不是子结果压缩造成。

证据：`cancel-output.json`和`cancel-output-run.txt`。真实模型首轮子run为`239249a6-ee6f-48ea-b7f0-d64b9ac8775f`、`8ce59626-ada3-4320-81d6-608661a02297`；保存过程证据的复核轮为`8d858c2e-adec-47eb-a819-1e9518aac986`、`71b50a6d-edff-46b8-b130-f719709b5c1f`。

复核轮两条已知子进程在取消/关闭返回后均不存活；启动文件保留，计划迟到写入的late.txt不存在；操作耗时约3 ms（仅该样本的本机观察，不是延迟保证）。没有观察到取消失效或孤儿进程。验收失败针对执行字段丢失，不能表述为“命令没有被停止”。

**建议整体改进：** 共用执行结果规范化应区分“执行器已经返回结果”与“执行器尚未返回”。取消可以改变终止归因，但应保留已返回且通过工具约束的output/meta/sideEffect；未返回的字段保持未知。超时、异常和取消使用同一合并规则，由命令与其他工具共用，不在ChildHandoff中根据errorKind补造不存在的退出码或取消字段。

验收需先保存输出再取消，验证stdout/stderr、退出/终止信号、截断标志和副作用在父/子两端一致保留，并覆盖取消与正常完成相邻时的归因。

### 3. 模型行为限制：完整继承的标记仍可能被回答为UNKNOWN

**已观察到的语义失败，不是上下文迁移丢失。** core/fork-1的子请求明确包含父用户消息中的完整虚构标记，以及要求在继承历史查找该前缀的当前子任务；子最终回答UNKNOWN。task.kind确为fork，没有文件工具或参数错误。

父run=`0a08cc11-0e56-41c5-8dbf-2e3bb36e93e5`，子run=`038c4461-e140-4d39-ac48-565de8a21da1`。证据目录为`core/fork-1-80DlcR`，尤其是`request-3.json`、`tasks.json`与`checkpoint.json`。同任务第二例通过，不能据此认定已修复，也不能把两例转为普遍错误率。

显式全文检索和类型契约的12例本轮全部通过，说明这些确定性能力有实测收益；它们不能保证模型正确使用或复述所有继承历史。前轮“已返回完整标记但只引用前缀”的失败也继续有效，不能被本轮通过样本覆盖。

**建议：** 保留稳定的语义回归集和独立答案核对；需要精确检索的业务任务采用明确的引用/搜索与返回契约，分别判断运行事实和最终文字。不要添加标记专用字符串提取、反复追加Prompt或无限增大轮数来掩盖失败。

## 复现与产物

可维护的真实模型入口继续使用现有脚本，每次root必须是新目录：

```bash
npx tsx scripts/run-sub-agent-real-evals.ts --allow-real-model --root=tmp/agent-evals/comprehensive-core-new --suite=all --repeat=2
npx tsx scripts/run-explorer-real-evals.ts --allow-real-model --root=tmp/agent-evals/comprehensive-explorer-new --transport=cli --cases=defined,fork,recovery,budget --repeat=2 --parent-mode=delegate-only
npx tsx scripts/run-sub-agent-reliability-evals.ts --allow-real-model --root=tmp/agent-evals/comprehensive-reliability-new --transport=web --repeat=2
npx tsx scripts/run-sub-agent-contract-real-evals.ts --allow-real-model --root=tmp/agent-evals/comprehensive-reply-new --transport=cli --small-results
```

本轮临时压力/竞态/生命周期复现脚本在证据目录中保留，不进入默认自动测试发现范围：`stress.ts`、`runtime-race.ts`、`cancel-output.ts`、`lifecycle-real.ts`。它们包含注入的合成故障，不能冒充真实模型失败；生命周期脚本是实际模型和命令，按两轮原样保留。后续实施修复时应把这些断言提升为仓库回归，不应直接覆盖本轮失败证据。

`summary.json`汇总样本、父/子run、原生用量与凭据扫描；`code-snapshot.json`保存代码哈希；各批次保留原始结果、请求、工具事实和工作区文件。初版复现夹具错误保留在runtime-race的run/retry文件中，只有final文件用于产品缺陷判断。

所有8个生产Web评测服务均记录serverExited=true，退出码130来自评测器主动SIGINT关闭；没有据此误判业务失败。真实运行取消/关闭的已知子进程已验证退出；未停止用户已有服务。凭据精确扫描覆盖本轮产物目录及src/scripts/docs，匹配为0；没有输出配置密钥，也没有修改用户凭据。当前统计不包含对用户整个数据目录或全部构建缓存的安全审计。

## 下一步顺序

先统一接纳状态与可取消准备流程，再完善共用执行结果合并，最后持续评测语义交付。保留当前共享运行时、角色权限、工作区限制、正文存储与投递机制。Worktree、跨进程事务、任务崩溃恢复和团队编排仍需分别立项，当前没有证据支持为了这三类问题推倒重写。
