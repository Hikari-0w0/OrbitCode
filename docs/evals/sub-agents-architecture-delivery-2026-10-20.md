# 子 Agent 架构改进交付与复测（2026-10-20）

用户在[整体评估](sub-agents-architecture-audit-2026-10-20.md)后授权“进行改进”。本轮实施统一任务状态、可追溯结果和显式父级执行契约，保留共享 AgentLoop、原有权限/沙箱、Skill/MCP、写协调及保存回执。没有新增依赖、提交、推送或创建 PR。

**当前700项自动测试通过，lint、typecheck、build依次退出0。本轮真实模型共30个场景，26通过、4失败；其中2个为开发期Web路由缺陷，修复后同类Web复测通过，另2个为仍保留的模型行为失败。未宣称任意任务质量已经稳定。**

## 实施内容

1. **统一任务终态。** `task-transitions.ts`统一排队/运行的停止归因，超时不再标为用户取消；清理失败保留停止原因和副作用。manager在资源回收后发布单调完成序号，pending按实际终态发布顺序投递，即使墙钟相同也不按创建顺序排序。
2. **摘要与正文分开。** `ChildResultStore`在父会话目录保存模型全文、有界工具事实、任务/父会话世代、有效期及哈希；应用内不覆盖同一任务正文。`replyTruncated`与`replyStorage`分别表示正文省略和保存状态，日志成功不再被误当作全文已保留。父模型通过`agent result`分页读取；Web任务面板、CLI `/task result`及子运行导出使用同一存储。重建实例可读正文，但不恢复执行任务。
3. **显式父级执行契约。** `{version:1,mode:collaborate|delegate-only}`来自Web结构化请求或CLI控制，保存至`lastTurn.parentExecution`。`ParentExecutionPolicy`在原策略外层覆盖definitions/classify/prepare/executePrepared；仅委派模式只能调用agent，包括正文读取。子任务的角色和权限另行求交，不被父级编排工具限制误禁。用户可在后续轮次切回协作并授权接管，模型没有自我切换入口。
4. **统一事实投影。** ChildHandoff为实际read_file结果记录内容SHA-256与字节数，关联原callId；有界事实同样保存到正文制品，并在子执行最后三轮的预算suffix中提供当前子任务读取/命令事实。它们区别于Fork父历史，也不意味着模型消费了全部内容或解释正确。不增加强制收尾模型调用，不隐藏子工具、不延长预算。
5. **交付与分页共同受预算约束。** 结果序列化分为完整、有界、最小事实三层，JSON转义后的字节超限仍保留省略计数、停止原因、命令退出事实与正文存储描述。正文页与read_context共用实际字符游标和预算裁剪，当前页不再被二次卸载成父级无法使用的引用；agent状态/控制结果仍走普通结果预算。
6. **路由集中分发。** 任务操作改用`tasks/[taskId]/[action]`单入口，来源、归属、操作白名单及参数校验继续由agentTaskHttp处理。解决新增result处理器和面板已经接入、生产路由却遗漏的问题。

正文单项256 KiB、工具事实64 KiB；每父会话最多256项、16 MiB序列化总量，同一进程按父目录串行写入。30天TTL到期后读取拒绝，后续写入清扫过期文件；清空/删除父会话移除正文。保存失败明确为unavailable，不改写已执行工具的副作用。配额不宣称是跨进程事务或全局硬配额；正文保存也不构成跨重启后台任务恢复。

## 使用入口

- Web：输入框“父级分工”选择“仅委派汇总”；任务面板展开结果后可点击“读取回复正文”。
- 交互CLI：`/delegation delegate-only`；接管时由用户执行`/delegation collaborate`；`/task result <id> [offset]`读取正文。
- 单次CLI：`npm run cli -- run --stdin --delegation delegate-only`，其余模型、Workspace、数据目录参数沿用现有选项。
- 模型工具：`{"operation":"result","taskId":"返回的ID","offset":0,"limit":4000}`；继续使用返回的nextOffset，按实际展示长度推进。
- 子运行导出：`childReply`为可用正文，`childToolFacts`为有界工具观察；`--without-context`省略这些正文。文件缺失、过期或父会话被清理时明确unavailable。

契约约束的是父模型工具行为；必要的运行时初始化和后台服务仍遵循原生命周期。更细的路径级接管协议不在本轮实现，协作模式中的操作继续由用户任务范围、Workspace和现有权限控制。

## 测试结果

| 批次 | 样本数 | 通过 / 失败 | 说明 |
| --- | ---: | ---: | --- |
| `subagent-improved-matrix-20261020` | 8 | 7 / 1 | Fork标记、迁移引用、多子任务协作、失败修复各2次；协作和修复有独立行为验收 |
| `subagent-improved-explorer-20261020` | 8 | 7 / 1 | defined/Fork/搜索恢复/4轮预算各2次；显式delegate-only，父未代做 |
| `subagent-improved-web-20261020` | 2 | 0 / 2 | 正文result路由404；保留为产品开发期失败，不改称无效夹具 |
| `subagent-improved-web-final-20261020` | 2 | 2 / 0 | 集中路由修复后的同类Web HTTP/SSE源码任务 |
| `subagent-improved-reply-20261020` | 1 | 1 / 0 | CLI长正文：子摘要截断，父实际分页读到尾部标记 |
| `subagent-improved-web-reply-20261020` | 1 | 1 / 0 | 同类长正文通过真实Web路由读取 |
| `subagent-improved-small-reply-20261020` | 1 | 1 / 0 | 1200-token单结果预算；父沿实际游标继续，无二次引用死路 |
| `subagent-improved-web-small-reply-20261020` | 1 | 1 / 0 | 同预算真实Web，正文哈希与尾部核对通过 |
| `subagent-improved-boundaries-20261020` | 4 | 4 / 0 | 无效参数/命令超时、路径穿越/外部符号链接、后台审批拒绝、显式取消 |
| `subagent-improved-interactive-20261020` | 2 | 2 / 0 | 浏览器实际选择分工并读取正文，tmux真实委派失败→修复→成功复验 |
| 合计 | 30 | 26 / 4 | 含开发过程失败与修复复测，不是产品一般成功率 |

现有`deepseek-flash`、OpenAI兼容Provider，隔离Workspace/数据/会话；源码样本使用固定副本。总计66条不重复原生日志、34个子运行。按父/子`modelUsage.scope=self`相加：354次Provider调用，354次报告usage、0次失败请求；输入3,988,529、输出104,214、合计4,092,743 tokens。包含失败和摘要用途，不是底层HTTP尝试数、未缓存计费量或严格性能A/B。

源码评测现在对截断摘要实际分页恢复正文，并核验长度与SHA-256，再检查原有入口、runtime来源、工具读取、角色和停止条件；没有把缺失引用放宽为通过。过去无法取回的尾部不能据此追溯判为通过。自动路径/符号断言仍不等于完整架构语义验收。

本轮前后有路由接入修复、事实正文保存和分页预算收敛，汇总保留混合版本全部样本。不能用本轮7/8与上一轮6/8推导通用提升比例；后续局部错误脱敏/高转义预算由确定性回归覆盖，未为了重新收集相同正常路径而重跑全部模型矩阵。

## 尚未解决的模型行为

1. **委派类型选错。** `cli-fork-1-SrU5Ih`：用户要求Fork，父模型实际创建defined；父runId `c5572489-e02e-4bc1-8477-406d4502ce9f`，子`0169c08d-8cd8-446d-84e3-f2322710594f`。子探索正常，但任务类型不符合要求，保留失败。没有用自然语言关键词推断并偷偷改写模型参数。
2. **上下文跳读。** `offload-2-Ws9t2K`：子仅用read_context，却未按实际nextOffset覆盖所有区间，漏掉目标标记；子`04c4f3a4-9bfa-4c42-ac56-084e57ab3cb9`，父`ea0771f7-f78d-4354-bd08-8778c130f896`。最终承认读取有缺口，不能据“读到末尾”判定目标不存在。正文分页基础设施能保证返回游标和内容匹配，不能保证模型会遵守游标。

两例均为真实失败，未删样本、加预算或堆叠重复提示强求通过。后续若要求严格保证用户选择的委派类型，可再设计结构化任务创建入口；通用检索质量需要固定任务与独立语义验收，不宜以字符串规则修补自然语言行为。

## 工程回归与清理

700项自动测试通过，无失败、取消、跳过；随后lint、typecheck、build顺序退出0，diff --check退出0。新增/增强覆盖完成顺序与停止归因、已有PreparedToolCall越权、加载Skill不能绕过父限制、显式接管、正文跨实例/归属/过期/清空/符号链接、完整导出、JSON转义预算、当前子事实suffix及低预算Unicode连续分页。原有MCP/Skill/写协调/保存重试回归继续通过。

开发阶段两条旧断言因新增读取哈希/字节数失败，已保留原事实约束并补充准确哈希断言；新增策略测试曾把准备成功判别值写为prepared，修正为实际ready。重构路由后先用`next typegen`刷新过期生成类型，再依次执行工程门禁；没有排除src/tests/scripts或弱化类型检查。

浏览器页面/控制台错误为空，已关闭浏览器。tmux实际CLI退出0，本轮会话与提示缓冲已删除；独立4组加法行为断言通过，原check.mjs未改。7个独立Web服务PID与端口均核对释放，保留用户已有服务。指定证据根精确匹配当前Provider凭据为0；这不是任意秘密检测。

本地证据入口：[汇总与源码哈希](../../tmp/agent-evals/subagent-architecture-improvement-20261020/summary.json)。同目录保留tests/lint/typecheck/build输出、浏览器截图、终端记录、独立断言及汇总脚本；原始配置、完整对话、源码副本和日志均忽略不入库。

复现脚本：`scripts/run-sub-agent-real-evals.ts`、`scripts/run-explorer-real-evals.ts --parent-mode=delegate-only`、`scripts/run-sub-agent-contract-real-evals.ts --small-results`；均须显式`--allow-real-model`与新的`--root`目录。Web使用`--transport=web`及已构建生产服务，避免与用户dev锁竞争。
