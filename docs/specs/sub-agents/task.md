# 子 Agent 委派与后台任务 Tasks

状态：已批准

2026-10-20至2026-10-21追加实施决策：任务接纳、准备及投递语义以本文件末尾 F19/P19/T19、F23/P20/T20、F27/P21/T21、F31/P22/T22、F35/P23/T23、F40/P24/T24、F44/P25/T25 及 F47/P26/T26 对应章节为准；其余既有约束继续适用。
依据：已批准的 `spec.md`、`plan.md`；用户于 2026-10-19 授权开始开发。
当前决策：2026-10-20用户授权撤下report_completion；以文末T15/P15及对应决策为准，早期报告方案仅保留历史记录。

## 执行约定与文件清单

以下任务的实现与验收进度见文末记录；文件清单允许机械拆分，实际验证以 checklist 为准。所有新测试使用当前 `npm test -- <文件>` 定向入口。每项完成先运行其验证，再记录结果；只有文档一致性检查可在审批前执行。

| 任务 | 新建文件 | 主要修改文件及职责 |
| --- | --- | --- |
| T1 | `src/core/sub-agents/types.ts` | 领域契约、配置上下限；运行时 settings/config 和设置仓库 |
| T2 | `src/runtime/agents/definition.ts`、`catalog.ts`；`agents/general.md`、`explorer.md`、`reviewer.md` | 角色解析、分层发现及内置定义 |
| T3 | `src/runtime/child-execution/history.ts`、`session-factory.ts`、`runner.ts`、`result.ts` | 独立 Skill 四个适配文件；共享子执行及兼容 |
| T4 | `src/runtime/child-permissions.ts`、`src/tools/child-tool-policy.ts` | 权限代理、Skill 策略、会话工厂；权限交集与禁止递归 |
| T5 | `src/runtime/workspace-execution-coordinator.ts` | 工具调度、registry、进程控制；共享工作区写入协调 |
| T6 | `src/runtime/background-task-manager.ts` | 通用子执行、MCP 连接和初始化；生命周期及租约 |
| T7 | `src/tools/agent.ts` | AgentLoop、上下文、系统提示、默认工具注册、AgentRuntime；委派与 Fork |
| T8 | `src/runtime/child-result-delivery.ts` | 上下文/会话类型与校验、会话仓库及保存重试；结果投递 |
| T9 | `src/runtime/sub-agent-usage.ts` | 用量追踪、运行记录、运行时事件；父子统计 |
| T10 | 无独立生产模块 | AgentRuntime、会话服务/清理、权限会话管理；关闭和世代失效 |
| T11 | `src/web/agent-task-http.ts`；会话下 agents/tasks 路由 | Web 运行时和权限入口；任务控制 API |
| T12 | `src/components/agent-task-panel.tsx` | 聊天入口、子审批卡、运行设置；Web 管理交互 |
| T13 | `src/cli/agent-commands.ts` | CLI 命令、会话控制、终端、run-once；CLI 管理与关闭 |
| T14 | `tests/helpers/sub-agent-fixture.ts`、`tests/sub-agents-runtime.e2e.test.ts`、`tests/sub-agents-web.e2e.test.ts`、`tests/sub-agents-cli.e2e.test.ts`、`scripts/run-sub-agent-fixture.ts`、`docs/evals/sub-agents.md` | README、验收清单；跨层验收与使用文档 |

各任务同时新建或扩展下文列出的测试文件。核心层只接收领域接口/回调，不引用运行时实现类。

## T1：固定领域契约与有限配置

- 对应：F1、F7、F10、F15、F17；Plan P2、P3、P6。
- 依赖：无。
- 文件：新建 `src/core/sub-agents/types.ts`；修改 `src/runtime/settings-types.ts`、`settings-service.ts`、`config.ts`、`src/lib/local-settings-store.ts` 及对应测试。

步骤：

1. 定义 start/status/wait/cancel、定义式/Fork、状态/投递状态、作用域、等待结果及子执行事实结果的判别联合，不用 `any` 承载外部输入。
2. 明确内部来源参数与模型可输入字段隔离；父轮次、会话世代、权限和工作区只能由运行时注入。
3. 加入 `subAgents` 配置、默认值、有限上下限和交叉验证；旧托管配置与 legacy 解析缺失字段时使用默认值，不覆盖用户现有配置。
4. 有效预算计算覆盖父 unlimited、角色更小上限及非法值；只按接纳时配置生成绝对截止时间。

验证：`npm test -- src/runtime/settings-service.test.ts src/runtime/settings-snapshot.test.ts src/lib/local-settings-store.test.ts`；`npm run typecheck`。期望旧配置兼容，非整数、负值、无限值、并发超容量均拒绝，默认值与 Spec 一致。

## T2：角色目录、校验与不可变定义

- 对应：F2、F3、F6；Plan P3、P11。
- 依赖：T1。
- 文件：新建角色 definition/catalog、三个内置 Markdown 及 `src/runtime/agents/definition.test.ts`、`catalog.test.ts`。

步骤：

1. 基于现有 yaml 解析器处理必填 frontmatter 和正文；限制大小、拒绝未知字段、重复键和 YAML 特殊引用。
2. 实现项目/用户/内置优先级、同层重名、坏定义阻断回退、路径逃逸拦截和目录容量诊断；扫描不启动连接或脚本。
3. 创建 general/explorer/reviewer 精确工具集合；模型引用只接受 inherit 或已有配置名称。
4. 返回只读定义快照和有界摘要；文件修改仅影响下一次创建，现有任务继续使用原快照。

验证：`npm test -- src/runtime/agents/definition.test.ts src/runtime/agents/catalog.test.ts`。期望覆盖优先级、缺失字段、链接越界、模型缺失、超限及运行中定义变化，不发生静默回退。

## T3：提取通用子执行并回归独立 Skill

- 对应：F3、F5、F7、F15；Plan P4。
- 依赖：T1。
- 文件：新建 `src/runtime/child-execution/history.ts`、`session-factory.ts`、`runner.ts`、`result.ts` 及对应测试；修改 `src/runtime/skills/history.ts`、`session-factory.ts`、`isolated-runner.ts`、`execution-summary.ts`、`src/runtime/agent-session-factory.ts`。

步骤：

1. 提取完整消息组迁移、独立上下文、进程/完成/用量实例和有界事实汇总，不复制 AgentLoop。
2. 对 none/recent/all 保留现有 Skill 语义；Fork 全量迁移复用 all 的底层能力，但来源由后续 T7 提供。
3. 迁移旧引用至新会话存储，纯文本旧引用标注不可用；1 MiB 超限、读取失败、取消均清理临时资源。
4. 把父预算、父取消等保留在 Skill 适配层；通用 runner 接收明确绝对截止和资源作用域，允许后台管理器持有。
5. 结果事实保留实际退出码、停止原因、副作用、验证状态和清理错误，模型最终文本不成为成功证据。

验证：`npm test -- src/runtime/child-execution/history.test.ts src/runtime/child-execution/session-factory.test.ts src/runtime/child-execution/runner.test.ts src/runtime/child-execution/result.test.ts src/runtime/skills/history.test.ts src/runtime/skills/isolated-runner.test.ts src/runtime/skills/execution-summary.test.ts`。期望状态隔离、引用不可跨会话、旧 Skill 上限和摘要兼容，错误不泄漏资源或抹去副作用。

## T4：子权限交集与禁止递归

- 对应：F8、F9、F11；Plan P5。
- 依赖：T1、T2、T3。
- 文件：新建 `src/runtime/child-permissions.ts`、`src/tools/child-tool-policy.ts` 及测试；修改 `src/tools/skill-policy.ts`、`src/runtime/permission-session-manager.ts`、通用子会话工厂及必要的 `src/core/permissions/approval.ts`、`src/tools/permission-gateway.ts` 接口。

步骤：

1. 对父快照/当前收紧、角色、Plan、Skill、后台分别求值，组合 deny > ask > allow，覆盖展示与实际执行检查。
2. 每个子使用独立 broker；单次审批携带任务身份和审批世代，不写入父或兄弟权限，不复用父单次授权。
3. 提供 detach 撤销待审批接口；后台/非交互 ask 直接拒绝，迟到决定无效。
4. 隐藏并执行时拒绝 agent，拒绝 isolated Skill；允许 shared Skill 但外层策略不得被 load_skill 豁免绕过。
5. 为旧独立 Skill 保留原审批语义，新增 Agent 任务使用新子审批策略。

验证：`npm test -- src/runtime/child-permissions.test.ts src/tools/child-tool-policy.test.ts src/tools/skill-policy.test.ts src/tools/permission-gateway.test.ts`。期望权限矩阵、撤销、晚到批准、伪造调用与 Skill 间接递归全部符合边界。

## T5：工作区写入许可与进程所有权

- 对应：F18、F17；Plan P8。
- 依赖：T1、T3。
- 文件：新建 `src/runtime/workspace-execution-coordinator.ts` 及测试；修改 `src/core/tool-scheduler.ts`、`src/tools/types.ts`、`registry.ts`、`managed-process.ts` 及其测试。

步骤：

1. 提供按 canonical root 共享的 FIFO、可取消写入许可，核心通过接口调用，不反向依赖运行时类。
2. 所有文件写、命令和 MCP 调用走同一保护；锁前校验、拿锁后重验，锁等待占用原工具时限。
3. agent/load_skill 编排不持写锁；父、子和独立 Skill 的实际写入统一接入。
4. start_process 许可随进程存活，退出/停止释放；status/stop 控制不被同一许可阻塞。保留清理失败事实。

验证：`npm test -- src/runtime/workspace-execution-coordinator.test.ts src/core/tool-scheduler.test.ts src/tools/managed-process.test.ts`。期望并发写最大值为 1、读取可并发、取消不执行迟到写入、长期进程不提前释放许可、父等待子无死锁。

## T6：后台管理器、并发与 MCP 租约

- 对应：F10、F11、F12、F17；Plan P6。
- 依赖：T1—T5。
- 文件：新建 `src/runtime/background-task-manager.ts` 及测试；修改通用 runner、`src/runtime/mcp-connections.ts`、`mcp-initialization.ts` 及测试。

步骤：

1. 实现有界接纳、创建幂等、排队、并发许可、终态发布、结果保留/清理及单独的前后台状态。
2. 配置决定一次性绝对截止；排队、初始化、审批、执行均计时，wait/detach 不改变截止或实例。
3. 独立 Skill 共用并发池且保留其父截止；子任务信号只受自身、runtime close 和时限控制。
4. 每个任务持有 MCP 租约及绑定子网关的工具包装器；父租约释放不破坏子连接。
5. close 先停止接纳，再取消/等待任务清理，最后允许底层基础设施关闭；重复取消与完成竞争只发布一个终态。

验证：`npm test -- src/runtime/background-task-manager.test.ts src/runtime/mcp-connections.test.ts src/runtime/mcp-initialization.test.ts`。使用可控时钟/延迟点证明排队超时不发模型请求、只执行一次、父释放后子仍能调用、部分初始化失败回收资源。

## T7：统一工具、实时 Fork 与持续角色提示

- 对应：F1、F3、F4、F6、F7、F9、F11；Plan P2、P3、P4。
- 依赖：T2、T4、T6。
- 文件：新建 `src/tools/agent.ts`、`agent.test.ts`；修改 `src/tools/default-registry.ts`、`types.ts`、`src/core/agent-loop.ts`、`src/core/system-prompt/types.ts`、`assemble.ts`、`src/runtime/agent-session-factory.ts`、`agent-runtime.ts` 及对应测试。

步骤：

1. 注册单一 agent 工具并注入可信来源，严格解析四类操作；start 先返回 ID，wait 返回状态摘要。
2. 在批次开始处快照当前 ContextManager 完整消息组，包含当前用户输入和本轮此前工具交换，排除整个当前组。
3. 定义式空历史；Fork 复制背景与 Skill 快照后追加子 prompt，固定后台；无角色 Fork 继承模型。
4. 角色正文进入持续提示槽；不重排稳定系统段和历史，不为了缓存保留不允许的工具。
5. 保证 wait 屏障不持写锁且受正确等待预算；父调用在接纳后取消不取消子任务。

验证：`npm test -- src/tools/agent.test.ts src/core/agent-loop.test.ts src/runtime/agent-runtime.test.ts`。检查出站模型请求的完整配对、当轮历史、定义式空白、快照独立、前台 Fork 拒绝及父取消边界；已有 AgentLoop 测试继续通过。

## T8：安全边界结果投递与原子回执

- 对应：F13、F14、F15；Plan P7。
- 依赖：T6、T7。
- 文件：新建 `src/runtime/child-result-delivery.ts` 及测试；修改 `src/core/context/types.ts`、`context-manager.ts`、`message-groups.ts`、`token-estimator.ts`、必要的压缩处理，`src/core/conversations/types.ts`、`validation.ts`，`src/lib/local-conversation-store.ts`，`src/runtime/agent-runtime.ts`、`conversation-runtime-manager.ts`、`run-agent-turn.ts` 及相关测试。

步骤：

1. 添加 child-result 上下文消息与低信任模型渲染；压缩、估算和分组支持该消息，不能伪造工具结果或系统指令。
2. 在请求模型前的安全边界领取结果，终态后不自动开启新模型轮次，后台回调只入队。
3. claim/stage/commit 与本轮上下文、展示消息、childResultReceipts 同 revision 保存；先写成功后 ack。
4. 故障注入覆盖保存失败、版本冲突、ack 失败、重复通知；retry-save 只保存并补 ack，不重新执行。
5. 回执兼容旧检查点并保持有界；取消、世代失效和不可恢复队列有明确处理。

验证：`npm test -- src/runtime/child-result-delivery.test.ts src/core/context/context-manager.test.ts src/core/context/message-groups.test.ts src/core/conversations/validation.test.ts src/lib/local-conversation-store.test.ts src/runtime/run-agent-turn.test.ts`。期望每个任务最多一次正文投递，没有孤立 tool 消息，保存重试不重跑，旧会话仍可打开。

## T9：父子用量、缓存观测与运行记录

- 对应：F6、F15、F19；Plan P9。
- 依赖：T3、T6、T8。
- 文件：修改 `src/models/usage-tracker.ts`、`src/runtime/agent-run-tracker.ts`、`types.ts`、后台管理器和结果汇总；扩展 `src/models/usage-tracker.test.ts`，新建 `src/runtime/sub-agent-usage.test.ts`。

步骤：

1. 复用 Provider 已解析的缓存判别联合，记录 tokens/status/unavailable 观测，缺失不推测。
2. 父 self、各子 self 与聚合总量分开；按任务身份去重，覆盖摘要请求与失败请求。
3. 父日志结束后不再后台改写；子日志保存事实，运行时视图按查询时点聚合。
4. 运行记录加入父子关联、状态变化、投递和清理事实；旧 usage 记录仍能读取，新增字段运行时校验。

验证：`npm test -- src/models/usage-tracker.test.ts src/runtime/sub-agent-usage.test.ts`。固定序列验证父子总量、摘要用途、重复查询、缺失 usage、缓存计数与脱敏。

## T10：运行时关闭、会话清空与重试集成

- 对应：F10、F12、F14、F17；Plan P6、P7。
- 依赖：T6、T8、T9。
- 文件：修改 `src/runtime/agent-runtime.ts`、`conversation-service.ts`、`conversation-cleanup.ts`、`conversation-runtime-manager.ts`、`permission-session-manager.ts`；扩展对应测试。

步骤：

1. 运行时唯一持有任务管理器，父轮次正常结束仅释放父资源；关闭顺序覆盖子任务、受管进程、MCP 和记忆服务。
2. clear/delete 在成功取得会话操作资格后失效旧世代并取消任务，防止失败的清空请求先破坏仍有效的会话。
3. 失效与写入持有同一会话操作边界，旧完成事件只能被丢弃/标记 invalidated；保存失败可诊断，不能重新投递旧世代。
4. 任务终态容量清理、无权访问、断开前台与 shutdown 行为接入公开 runtime 方法。

验证：`npm test -- src/runtime/agent-runtime.test.ts src/runtime/conversation-service.test.ts src/runtime/conversation-cleanup.test.ts src/runtime/conversation-recovery.test.ts`。期望普通父结束不取消、关闭彻底回收、失败清空无提前副作用、旧结果不污染新会话，重启不恢复任务。

## T11：Web 任务管理 API

- 对应：F8、F11、F12、F16；Plan P9。
- 依赖：T10。
- 文件：新建 `src/web/agent-task-http.ts` 及测试；新建 `src/app/api/conversations/[conversationId]/agents/route.ts`、`tasks/route.ts`、`tasks/[taskId]/route.ts`、`tasks/[taskId]/wait/route.ts`、`tasks/[taskId]/detach/route.ts`、`tasks/[taskId]/cancel/route.ts`；修改必要的 `src/web/agent-runtime.ts`、`permission-http.ts`。

步骤：

1. 路由只校验请求并调用共用 runtime，绑定本地请求和会话权限，不接受客户端权限/路径覆盖。
2. 提供列表、详情、wait/detach/cancel，采用有界等待与轮询；父生成流不活跃时仍可访问任务。
3. 断开请求结束等待而非取消任务，跨作用域任务 ID 返回不泄露详情的错误。
4. 子审批通过任务身份和审批世代路由到独立 broker，detach 后迟到批准无效。

验证：`npm test -- src/web/agent-task-http.test.ts src/web/permission-routes.test.ts`。覆盖 GET/POST 参数、作用域、断连、无模型调用的查询、审批身份和取消幂等。

## T12：Web 任务面板与运行设置

- 对应：F2、F8、F11、F15、F16、F17、F19；Plan P3、P9。
- 依赖：T11。
- 文件：新建 `src/components/agent-task-panel.tsx` 及测试；修改 `use-chat-workspace.ts`、`chat-workspace.tsx`、`permission-request-card.tsx`、`settings/runtime-settings.tsx` 及相关测试。

步骤：

1. 展示角色来源和诊断，按所属会话列任务、状态、预算、用量、投递状态与验证边界。
2. 提供查看/等待/转后台/取消，等待时仍可操作；轮询只在所需界面激活并正确释放。
3. 子审批卡展示任务身份，任务结果区分模型文本、运行事实和验收状态。
4. 设置区编辑子预算并显示验证错误，使用已有服务契约，不在组件实现任务循环。

验证：`npm test -- src/components/agent-task-panel.test.tsx src/components/chat-workspace.test.tsx`；真实浏览器验证见 checklist B1—B3。期望关闭面板/切换会话不误取消任务，无错误覆盖层和控制台错误。

## T13：CLI 管理、交互等待和单次运行

- 对应：F11、F12、F15、F16、F19；Plan P9。
- 依赖：T10。
- 文件：新建 `src/cli/agent-commands.ts`、`agent-commands.test.ts`；修改 `commands.ts`、`session-controller.ts`、`terminal-chat.ts`、`run-once.ts`、必要的 `renderer.ts` 和 `main.ts`，扩展现有终端/单次测试。

步骤：

1. 实现 `/agents`、`/tasks`、`/task show|wait|background|cancel <id>`，解析错误清晰且兼容旧命令。
2. wait 时输入仍可处理，Ctrl+C 仅结束当前等待；显示子审批身份和终态事实。
3. 交互 CLI 运行时跨父轮次保留任务，退出时统一清理。
4. run-once 最终 JSON/JSONL 在关闭后报告未完成任务取消、用量和副作用，保持唯一最终事件与现有退出码契约；主正常回复不等同子验收成功。

验证：`npm test -- src/cli/agent-commands.test.ts src/cli/commands.test.ts src/cli/terminal-chat.test.ts tests/cli-run-once.e2e.test.ts tests/cli-run-once-process.e2e.test.ts`。验证输入不中断、等待/取消区分、退出无后台遗留及输出只有一个终态。

## T14：跨层验收、故障路径与使用说明

- 对应：F1—F19、N1—N5、AC1—AC20；Plan P12。
- 依赖：T1—T13。
- 文件：创建文件清单所列替身、六个 e2e 测试（另含 MCP 租约、保存重试与批次边界）及 `docs/evals/sub-agents.md`；更新 README 和本目录 checklist。

步骤：

1. 提供隔离数据目录、本地 OpenAI 兼容替身和 MCP 替身，不需要真实凭据；脚本显式输出本地 URL、测试配置路径和清理方式。
2. 替身支持成功、权限拒绝、工具失败、无效参数、命令超时、最大轮次、保存故障、慢任务和缓存 usage 样本；记录实际请求、工具计数和副作用证据。
3. 完成运行时、HTTP 和进程端到端；再执行全量 `npm test`，之后依次 lint/typecheck/build。
4. 用 agent-browser 检查 Web，用 tmux 检查交互 CLI；按 checklist 留下退出码、观察结果和未通过原因，关闭自建进程和浏览器。
5. README 记录角色格式、工具及 CLI 操作、后台寿命、共享文件和缓存边界；评估文档给出可重复场景与证据位置，不填入未经执行的通过结果。

验证：`npm test -- tests/sub-agents-runtime.e2e.test.ts tests/sub-agents-web.e2e.test.ts tests/sub-agents-cli.e2e.test.ts`，然后 `npm test`、`npm run lint`、`npm run typecheck`、`npm run build`；浏览器和 tmux 按 checklist 执行。期望所有已批准检查有真实证据；不支持沙箱等环境限制明确记未验证，不放宽保护。

## 执行顺序与覆盖

建议顺序为 T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12 → T13 → T14。各任务依赖已在对应章节列明；本计划不要求启动多个开发 Agent。

P1/P10 架构与文件边界贯穿全部任务；P2 对应 T1/T7，P3 对应 T1/T2/T12，P4 对应 T3/T7，P5 对应 T4，P6 对应 T6/T10，P7 对应 T8/T10，P8 对应 T5，P9 对应 T9/T11—T13，P11/P12 对应所有安全测试及 T14。

不包含提交、推送、PR 或部署。实现中若需改变公开行为、核心架构或验收标准，更新受影响文档后请求确认；机械性文件拆分可同步记录并继续。


## 实施进度（2026-10-19）

T1—T13 已实现并执行相关定向测试；T14 已建立本地替身、六个跨层测试、使用说明、浏览器与 tmux 证据，最终门禁与复合场景补测按 checklist 逐项记录。实现完成不替代用户验收。

机械拆分补充：`src/runtime/agents/delegation.ts` 承接委派装配；`src/runtime/sub-agent-usage.ts` 承接统计；新增 `tests/sub-agents-mcp.e2e.test.ts`、`tests/sub-agents-persistence.e2e.test.ts` 将 MCP 租约与持久化故障单独验证。结果边界测试位于 `child-execution/runner.test.ts` 及旧 Skill 汇总测试，没有单独创建仅重导出常量的 `result.test.ts`。已批准范围、权限边界与验收要求保持不变。

收尾修复有独立回归：Fork 排队前固定激活 Skill 快照；前台槽位授予与 runtime close 竞争不得迟到启动；已投递记录退休后旧创建调用不得重新执行；长进程持写许可直至退出。

最终补测新增 `tests/sub-agents-boundaries.e2e.test.ts` 与 `src/runtime/agents/delegation.test.ts`，覆盖当前多工具批、稳定请求、动态角色、清空冲突、流式投递及启动各阶段故障。日志状态通过结果可选字段 `evidenceLog` 明示，与已有 run ID 一起保留。最终检查与有限场景验收记录于 checklist。


2026-10-20在用户明确授权下追加真实模型复杂验收（38个样本，保留失败）。在已批准范围内修复Fork子身份说明与缓存统计落盘遗漏，定向回归和最终完整门禁通过。报告位于 `docs/evals/sub-agents-real-model-2026-10-20.md`。

## T13：用户授权的真实模型问题改进（2026-10-20）

依赖：T1–T12及既有真实模型报告。

- 持续子指令及当前任务边界：`agents/child-instructions.ts`、`delegation.ts`、`child-execution/runner.ts`；回归确认继承消息配对不变，当前子任务清楚可见。
- 有预算的上下文读取出口：`core/context/context-read-payload.ts`、`lightweight-compaction.ts`、`tools/read-context.ts`；验证Unicode连续读取、并行预算与容量停止，不再次卸载读取结果。
- 事实交接与主接管指引：`child-execution/handoff.ts`、`result.ts`、`child-result-delivery.ts`、`system-prompt/action-execution.ts`；验证失败到复验、批量部分写入、省略范围及投递截断。
- 固定复测：`scripts/run-sub-agent-real-evals.ts` 与 `scripts/evals/`；原任务/预算，逐请求哈希、独立契约验收、真实凭据精确扫描。命令入口 `npx tsx --tsconfig tsconfig.json scripts/run-sub-agent-real-evals.ts --root=<新隔离目录> --suite=all --repeat=2 --allow-real-model --provider=<现有配置名>`。
- 定向测试后运行全量npm test，依次lint、typecheck、build，保存全部真实样本与清理证据。对应F4/F5/F15/F18、P13；结果见改进评测报告。

T13已完成并验证：693项全量通过、增强交接定向4/4、工程门禁通过；真实样本18例14通过/4失败，最终修复后10例通过。未实施项和证据边界见 [改进验收](../../evals/sub-agents-improvements-2026-10-20.md)。

## T14：用户授权的报告语义与主汇总改善

依赖T13。

1. 修改core/completion-tracker.ts、tools/report-completion.ts、core/agent-loop.ts：只读有界证据候选、Schema说明和错误纠正，维持原证据/预算规则。验证tracker、report工具和loop定向测试，覆盖失败证据、过期验证及跨轮隔离。
2. 修改ChildHandoff、领域结果类型、结果投递与主执行指令：实际报告调用计数独立于最终verification，截断仍保留。验证handoff/投递及新增tests/sub-agents-completion.e2e.test.ts四个完整循环场景。
3. 新增scripts/run-completion-real-evals.ts和scripts/evals/sub-agent-completion-cases.ts、sub-agent-web-fixture.ts：五状态真实模型对照、父汇总逐字段检查、同入口CLI/Web；评测器反例测试防止将最终文本冒充运行时事实。原始repair任务另复测，不覆盖历史。
4. 运行全量测试、依次lint/typecheck/build、tmux真实输入、Web HTTP/SSE；隔离目录、凭据精确扫描及资源关闭。对应F15/F19、P14。结果见本轮报告。

T14完成实现与本轮验证；15个有效真实模型样本14通过/1部分通过，13个状态汇总对照通过。子报告漏提交的部分通过样本完整保留。工程门禁702项与lint/typecheck/build通过，详见 [报告语义验收](../../evals/completion-semantics-2026-10-20.md)。

## T15：按用户条件授权移除报告工具

依赖：T14真实模型证据及本轮明确授权。当前方案取代T14报告提交/纠错要求。

1. 删除tools/report-completion、默认注册和类型项；简化core/agent-loop、completion-tracker为被动证据，保留通用错误/预算/权限路径及旧Assessment读取。
2. 去除主提示和内置角色/Skill的提交要求；Skill/角色元数据兼容忽略旧名称，不扩权；子交接不再新生成报告次数。
3. 删除已退役工具专属用例并归档旧源码/脚本；用被动证据、历史读取、defined/Fork直接完成、普通参数错误恢复、旧角色/Skill白名单过滤回归替代。涉及文件：core/completion-tracker.test、tests/sub-agents-no-report.e2e、skills/agents definition测试、CLI/loop既有集成测试。
4. 同一原任务/预算运行真实模型Fork/上下文/协作/修复各2例，另覆盖direct/delegated/legacy-skill/legacy-role/legacy-history及Web/tmux；不只对比报告次数，制品仍独立检查。运行记录报告调用必须为0，检查实际出站工具定义无该名称。
5. 全量测试与lint/typecheck/build，保留所有样本/原始证据，精确凭据扫描与资源清理。既有702项是历史值，新测试数量随退役功能调整，不当作覆盖质量百分比。

T15已完成：21/21真实模型样本、报告调用0、678项现行测试及工程门禁通过。保留运行时事实与独立验收，不恢复自报门禁。证据见[移除验收](../../evals/report-completion-removal-2026-10-20.md)。

## T16：用户授权的源码探索故障修复与复测

依赖T15；授权来自本轮“修复问题，并继续进行这样的测试”。

1. 修正search_code参数契约和目标错误分类，回归文件当目录、目录当文件、缺失、非法路径和越界符号链接。
2. 增强ChildHandoff只读事实、失败原因和原生日志关联；验证成功与失败不混用、有界/去重/不复制正文、超限仍交接、超长投递保持省略事实。
3. 子预算提示放请求末尾，验证同一前缀、预算计量、无持久化、无隐藏工具、无额外请求。主级提示尊重只委派分工。
4. 使用源码副本重复原任务，覆盖defined/Fork、一次错误纠正、4轮预算、Web HTTP/SSE、真实tmux。保留全部失败，独立核对入口与调用方来源，人工审阅解释范围。
5. 全量测试后顺序lint/typecheck/build；全部样本精确凭据扫描、评测端口/进程清理，不影响现有用户服务。证据与剩余问题见本轮评测报告。

T16运行时修复已完成并验证：686项自动测试与工程门禁通过；有效真实场景22例16通过/6失败，另保留1次启动失败和1次无效夹具。父级重复探索及精确行号/语义覆盖仍待改善，未把整项标为无条件验收通过。详见[修复复测](../../evals/sub-agents-explorer-recovery-2026-10-20.md)。


## T17：用户授权的整体架构改进

依赖：整体评估报告与用户“进行改进”的直接授权。

1. 提取统一停止转换，发布完成序号；验证倒序完成、同墙钟、超时、清理失败、回执去重。
2. 保存正文与有界工具事实，接通 agent result、Web、CLI和导出；验证中文分页、重启后读取、归属/世代、过期、清空、符号链接及配额失败。分层交付包含JSON转义后的字节预算。
3. 接入显式父级执行契约与UI/CLI选择；覆盖隐藏定义、强行调用、已有PreparedToolCall、Skill豁免和显式切回协作。
4. 统一分页内容出口预算，证明低预算分页仍内联、游标连续、中文无遗漏；复测真实模型CLI/Web。
5. 全量测试及lint/typecheck/build；使用既有真实矩阵、源码副本、异常安全任务、长正文、浏览器及tmux；保存所有失败及修复前后证据，不用模型结束状态代替验收。

实现与有限验证结果见 [架构改进交付](../../evals/sub-agents-architecture-delivery-2026-10-20.md)。残余模型质量问题继续保留，不将功能完成等同于任意任务验收通过。

## T18：本轮追加改进

- [x] 共用引用全文搜索、Unicode偏移、精确计数、有界摘录及低预算覆盖信息。
- [x] 子任务搜索事实交接与持久化。
- [x] Web/CLI显式类型契约、Schema收窄、运行时拒绝、旧历史兼容。
- [x] Fork已复制引用别名及未复制对象拒绝。
- [x] 712项回归及工程检查；24个固定真实模型样本完整分布；浏览器/tmux交互验证与清理。
- [ ] 通用语义检索与完整引用质量：仍有已返回完整标记但模型仅引用前缀的失败，不标为已解决。

## T19：任务生命周期内核收敛

- [x] TaskState、BackgroundTaskManager：稳定接纳、准备队列、任务信号、scope 去重与输入冲突、一次终结、名额释放及闭包回收。
- [x] agents/delegation、task-transitions：接纳快照、可取消复制、清理结果、幂等有序资源释放。
- [x] tools/registry、tool-termination：停止原因与已观察执行事实分开处理；覆盖父/子命令交接。
- [x] child-result-delivery：未确认结果可重试、停止来源压缩保留、失效防止迟到确认。
- [x] 将 HTTP 准备期取消、未保存投递及结果丢失复现提升为仓库回归；提供显式授权的真实模型生命周期脚本。
- [ ] 路线 D 剩余：完整内部任务契约、上下文清单与组预算；工作区独占见 T20。
- [ ] 路线 E 的跨场景收益对照与 Worktree 后续阶段。

本轮验证与证据边界见 [内核收敛交付](../../evals/sub-agents-lifecycle-architecture-2026-10-20.md)。

## T20：共享工作区任务级协调

- [x] 协调器公平读写队列、任务所有权、取消、重入、结束失效与清理失败拒绝新许可。
- [x] 按真实工具元数据选择子任务访问策略，接入 defined/Fork、独立 Skill、父文件工具与 MCP 初始化。
- [x] TaskView/agent 输出访问模式，并明确控制工具不会持锁等待。
- [x] 原子计数、只读并发、父读一致性、排队取消、未知能力、清理失败与800次固定种子申请回归。
- [x] 733项完整回归及工程门禁；真实模型计数、只读及生命周期复测，完整分布和评测误判保留，见 [交付报告](../../evals/sub-agents-workspace-coordination-2026-10-21.md)。
- [ ] 路线 D 剩余：完整内部任务契约、上下文清单和组预算；路线 E 的单 Agent 质量/成本对照仍未完成。

## T21：子执行资源接纳与公平调度

- [x] 复现旧前台优先插队，保留修复前失败输出。
- [x] 提取唯一子执行FIFO并发池，分离资源等待，统一关闭与执行/清理结果。
- [x] TaskExecution acquire/run/close、waiting-resources状态、工作区所有权句柄接入后台及独立Skill。
- [x] 同根等待/跨根进度、就绪公平、关闭三阶段、动态并发、清理失败保留结果及固定种子压力回归。
- [x] 本轮742/742完整回归、lint/typecheck/build及7/7真实模型复测，含旧插队失败和中间时序断言记录，见[调度收敛交付](../../evals/sub-agents-scheduler-2026-10-21.md)。
- [ ] 完整内部任务契约和任务组总请求/token预算仍未实现。

## T22：不可变接纳契约与上下文清单

- [x] 版本化内部规格、管理器绑定契约及统一预算输入；删除旧生产start签名。
- [x] 有效工具交集和禁止优先、计划深复制冻结、动态撤权继续生效。
- [x] 接纳/准备清单、真实引用复制事实、哈希不符拒绝、映射有界和跨会话拒绝。
- [x] 角色模型实际请求/接纳/日志归属回归，保留修复前失败。
- [x] 最终752/752、lint/typecheck/build；真实模型11/11，其中最终行为代码8/8；凭据扫描与测试进程清理，见[交付记录](../../evals/sub-agents-admission-contract-2026-10-21.md)。
- [ ] 结构化制品与验收契约、任务组总预算、持久化恢复和单Agent对照仍待后续阶段。

## T23：任务组共享请求预算

- [x] 复测基线752/752，接通父/子/独立Skill/摘要共享账本和接纳关联。
- [x] OpenAI重试前同步接纳，不超发、不退款，明确报告与未知用量。
- [x] 跨父轮后台任务不重置额度、世代失效与历史记录回收；Web配置及旧值兼容。
- [x] 浏览器复现并修复客户端Node模块依赖；纯契约与证据运行时分离。
- [x] 可控时钟复现并修复总时限归因缺口；MCP与共用运行入口21/21定向回归。
- [x] 最终762/762、lint/typecheck/build；分阶段真实模型与浏览器保存刷新验证，完整版本分布见本轮交付报告。
- [ ] token预算的保守预留、缺失usage结算与硬上限仍待独立实现；结构化验收和跨进程隔离继续按路线后续处理。

## T24：生命周期阶段诊断

- [x] 先复测762/762；提取被动单调时间清单，保持状态/资源所有者不变。
- [x] 接入准备两阶段、资源/执行等待、执行、清理及终结；首个停止和回收延迟。
- [x] 投递时序独立；TaskView、状态工具、CLI/HTTP、交付与截断回退共用事实。
- [x] 769/769、工程门禁、真实模型9/9，含10份子任务清单及独立文件/进程验收；证据见本轮报告。
- [ ] token硬预算、结构化验收、跨进程隔离/恢复和质量成本对照仍待后续阶段。

本轮实现、测试分布与持久化边界见[生命周期阶段诊断交付](../../evals/sub-agents-phase-timing-2026-10-21.md)。

## T25：调度接纳与回收屏障

- [x] 建立五个同步回调边界的确定性关闭复现，保留提前返回及排队悬挂输出。
- [x] 先登记操作再调用回调，先登记FIFO顺序再通知就绪观察者，队列变更与派发避免重入。
- [x] 开始回调后复查取消，执行事实严格区分实际调用与仅通知。
- [x] 关闭屏障在取消广播前发布且重复调用复用；明确关闭后调用的清理归属。
- [x] 管理器集成、回调异常与40种子混合测试。
- [x] 最终781/781及工程门禁通过，真实CLI/Web10/10；完整分布与边界见[调度所有权交付](../../evals/sub-agents-scheduler-ownership-2026-10-21.md)。

## T26：当前版本剩余开发与验证

- [x] 共享token预留/已知结算/未知保留，OpenAI实际输出限制及重试竞争，旧配置与设置页。
- [x] 有界文件输出契约、不可变接纳/身份/子指令/交接。
- [x] 独立文件verify、动态权限和工作区协调，结果与子verification分离，父检查点保留。
- [x] 预算、输出、权限与修改后复验的确定性测试。
- [x] 最终792/792、门禁、设置页保存/刷新；17/17场景含14次实际模型样本与3次发送前拒绝，完整版本边界见[收口报告](../../evals/sub-agents-final-delivery-2026-10-21.md)。

当前版本状态统一见[交付状态](delivery-status.md)；上述历史未勾选项为当轮证据或非目标边界，不代表现行版本仍缺少已交付能力。

## T27：默认权限下的子任务审批闭环（2026-10-22）

- [x] 先加入内置general/default的四路径失败复现，保存4/4失败基线。
- [x] 移除执行器detach权限副作用，后台交互审批复用原通道，停止仍使请求失效。
- [x] Web入口待审批提示、面板说明及父模型awaitingApproval事实。
- [x] 拒绝、取消、关闭、非交互与执行前撤权回归。
- [x] 完成工程门禁、真实模型/Web浏览器验收及证据归档（802/802，5个真实模型样本通过，另保留1个无模型调用的夹具准备失败）。

## T28：主子Agent全面移除人工审批（2026-10-22）

- [x] 先固定默认非交互父/子失败基线，再移除共享门禁及调度/MCP等待分支。
- [x] 移除子审批会话、任务决定通道、Web/CLI交互与无效模式控件；保留历史只读展示和旧接口410。
- [x] 迁移旧审批测试为直接执行、显式拒绝、取消与复检测试；全量792/792通过。
- [x] 真实模型和实际开发浏览器验收、最终文档和清理归档：9次真实尝试7通过/2次MCP失败原样保留，6类脚本场景及浏览器均有最终通过样本。
