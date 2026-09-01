# Agent 运行可靠性、效率与对话并发安全 Tasks

状态：已批准
依据：已批准的 `spec.md` 与 `plan.md`

## 文件清单

| 操作 | 文件 | 职责 | 对应需求 |
| --- | --- | --- | --- |
| 修改 | `src/models/provider.ts`、`src/core/agent-events.ts` | 模型阶段、超时、验证状态和停止原因契约 | F5、F6、F9、F14、F16 |
| 修改 | `src/models/config.ts`、`src/models/config.test.ts`、`src/web/server-config.ts`、`orbitcode.example.yaml` | Provider transport 与上下文效率阈值配置 | F6、F12、F13 |
| 修改 | `src/models/openai-provider.ts`、`src/models/openai-provider.test.ts` | SSE 阶段、trace、容量、超时和安全重试 | F5～F7、F13 |
| 新建 | `src/core/tool-failure-budget.ts`、`src/core/tool-failure-budget.test.ts` | 同类失败指纹、预算和熔断决策 | F9 |
| 修改 | `src/core/agent-loop.ts`、`src/core/agent-loop.test.ts` | 接入模型进度、失败预算、完成证据和终止持久化 | F5、F6、F9、F14、F16 |
| 新建 | `src/tools/command-preflight.ts`、`src/tools/command-preflight.test.ts` | 明确畸形命令的无副作用预检 | F8 |
| 修改 | `src/tools/run-command.ts`、`src/tools/run-command.test.ts` | 在授权与执行前应用命令预检 | F8、F9 |
| 新建 | `src/tools/write-files.ts`、`src/tools/write-files.test.ts` | 有界批量文件写入和逐项结果 | F11、F13 |
| 修改 | `src/tools/types.ts`、`src/tools/schema.ts`、`src/tools/registry.ts`、`src/tools/registry.test.ts` | 共享容量与多目标权限准备 | F8、F11、F13 |
| 修改 | `src/tools/permission-gateway.ts`、`src/tools/permission-gateway.test.ts`、`src/tools/permission-target.ts` | 对批量目标逐项授权和重校验 | F11 |
| 修改 | `src/core/tool-scheduler.ts`、`src/core/tool-scheduler.test.ts` | 保留多调用并发/串行边界和批量结果顺序 | F11 |
| 修改 | `src/tools/default-registry.ts`、`src/tools/mode-policy.ts`、`src/tools/mode-policy.test.ts` | 注册新工具并约束 Plan/Do 可用性 | F10、F11、F14 |
| 修改 | `src/tools/command-sandbox.ts`、`src/tools/macos-seatbelt-sandbox.ts`、`src/tools/macos-seatbelt-sandbox.test.ts` | 通过 Seatbelt 启动可管理长驻进程 | F10 |
| 新建 | `src/tools/managed-process.ts`、`src/tools/managed-process.test.ts`、`src/tools/process-tools.ts` | 进程启动、就绪、日志、状态、停止和回收 | F10 |
| 新建 | `src/core/completion-tracker.ts`、`src/core/completion-tracker.test.ts`、`src/tools/report-completion.ts` | 验证证据账本与结构化完成报告 | F14 |
| 修改 | `src/core/system-prompt/action-execution.ts`、`src/core/system-prompt/system-prompt.test.ts` | 动态测试数据、依赖步骤和完成报告协议 | F14 |
| 新建 | `src/core/context/operational-compaction.ts`、`src/core/context/operational-compaction.test.ts` | 确定性折叠旧工具交换 | F12 |
| 修改 | `src/core/context/types.ts`、`src/core/context/context-manager.ts`、`src/core/context/context-manager.test.ts` | 效率阈值、引用生命周期和压缩报告 | F12、F13 |
| 修改 | `src/lib/local-conversation-store.ts`、`src/lib/local-conversation-store.test.ts` | 可检查租约、所有权标记、显式恢复和错误脱敏 | F1、F2、F4、F16 |
| 新建 | `src/web/conversation-operation-guard.ts`、`src/web/conversation-operation-guard.test.ts` | 统一进程内操作与跨进程租约 | F1、F2 |
| 修改 | `src/web/conversation-runtime-manager.ts`、`src/web/conversation-runtime-manager.test.ts` | 按操作种类跟踪会话活动状态 | F1、F2 |
| 修改 | `src/app/api/chat/route.ts`、`src/app/api/conversations/[conversationId]/route.ts`、`clear/route.ts`、`compress/route.ts`、`retry/route.ts` | 所有会话写操作接入统一守卫，详情保持只读 | F1、F2、F16 |
| 新建 | `src/app/api/conversations/[conversationId]/recover/route.ts` | 同源、带 revision、幂等的中断恢复 | F1、F2、F16 |
| 修改 | `src/web/conversation-http.ts`、`src/web/chat-contract.ts`、`src/web/chat-contract.test.ts` | 安全错误、activity、模型进度和验证状态 Web 合约 | F1、F3～F7、F14、F16 |
| 修改 | `src/web/chat-handler.ts`、`src/web/chat-handler.test.ts` | 保留 Provider 分类、唯一终止与日志观测 | F6、F7、F16 |
| 修改 | `src/lib/local-agent-run-log.ts`、对应测试、`src/lib/local-agent-run-exporter.ts`、对应测试 | 版本化 attempt/阶段日志与导出脱敏 | F7 |
| 修改 | `src/core/conversations/types.ts`、`validation.ts`、`display-timeline.ts`、对应测试 | 持久验证状态和纯空白 part 归一化 | F14～F16 |
| 修改 | `src/components/chat-workspace.tsx`、`chat-workspace.test.tsx` | 会话加载失败收敛和显式恢复交互 | F1、F3 |
| 修改 | `src/components/chat-session-state.ts`、对应测试、`message-list.tsx`、对应测试、`src/app/globals.css` | 模型阶段、验证标签及紧凑工具时间线 | F5、F14、F15 |
| 修改 | `README.md` | 统一 Workspace/Provider 切换与记录保留语义 | F4 |

## T1：固定跨层事件、容量与配置契约

- 对应：F5、F6、F12～F14、F16，`plan.md` 的「核心类型与接口」
- 文件：`src/models/provider.ts`、`src/core/agent-events.ts`、`src/models/config.ts`、`src/models/config.test.ts`、`src/web/server-config.ts`、`orbitcode.example.yaml`、`src/tools/types.ts`
- 依赖：无

步骤：

1. 增加模型请求阶段、timeout phase、attempt、验证状态和新增停止原因的判别类型，保持现有 model/tools progress 外层结构。
2. 为 Provider transport、工具参数统一容量和 Context 效率阈值定义保守默认值、最小/最大边界及严格配置解析。
3. 保证配置对象与公开 Provider 摘要不携带 API Key、内部 URL 或 transport 诊断细节。
4. 补充合法边界、未知字段、交叉阈值冲突和旧配置默认值测试。

验证：

- 运行：`npm run test -- src/models/config.test.ts src/web/server-config.test.ts`
- 期望：配置默认值与所有边界用例通过，未知或互相冲突的值被结构化拒绝。

## T2：实现可观察且有界的 Provider 传输

- 对应：F5～F7、F13，`plan.md` 的「Provider 传输与观测」
- 文件：`src/models/openai-provider.ts`、`src/models/openai-provider.test.ts`、`src/models/provider.ts`
- 依赖：T1

步骤：

1. 在 fetch、响应流读取和 SSE 解析之间实现首字节、idle 与 total 三类计时器，并与调用方 AbortSignal 合并清理。
2. 从 `x-siliconcloud-trace-id` 优先、`x-request-id` 兜底读取并清洗 trace 标识，产生等待、正文、工具参数和结束阶段事件。
3. 工具参数按增量累计但只发布名称、规模和耗时；完整调用仍在 finish reason 与统一容量校验后一次性交付。
4. 只在首个语义输出前对 retryable 网络/流错误执行小预算退避重试；取消、HTTP 配置错误、协议错误及已有语义输出不重试。
5. 覆盖 `[DONE]` 缺失、空流、错误 content-type、超限参数和每个计时器的资源清理。

验证：

- 运行：`npm run test -- src/models/openai-provider.test.ts`
- 期望：受控 SSE 的阶段顺序、trace、重试次数、超时分类、取消和容量行为全部符合契约，无悬挂计时器。

## T3：增加工具失败预算并接入 Agent Loop

- 对应：F5、F6、F9、F16，`plan.md` 的「Agent 运行策略」与「工具失败预算与完成证据」
- 文件：`src/core/tool-failure-budget.ts`、`src/core/tool-failure-budget.test.ts`、`src/core/agent-loop.ts`、`src/core/agent-loop.test.ts`、`src/core/agent-events.ts`
- 依赖：T1、T2

步骤：

1. 基于工具名、错误 kind、schema issue path 和现有参数 fingerprint 生成不含原文的错误指纹。
2. 实现精确重复、同工具同类和轮次总失败三级预算；成功替代方案只重置相关计数。
3. Agent Loop 转发模型阶段进度，将 Provider timeout/stream/network 分类映射到明确终止，并在预算到限时产生策略切换提示或 `repeated-tool-failure`。
4. 确保所有路径仍只产生一个 stopped，且取消、运行时限、unlimited 和旧未知工具熔断不回退。

验证：

- 运行：`npm run test -- src/core/tool-failure-budget.test.ts src/core/agent-loop.test.ts`
- 期望：连续 4～7 次同类失败被预算阻断，合法替代方案可继续，所有终止路径只有一个停止事件。

## T4：强化工具预检并增加有界批量写入

- 对应：F8、F11、F13，`plan.md` 的「工具与权限」
- 文件：`src/tools/command-preflight.ts`、对应测试、`src/tools/run-command.ts`、对应测试、`src/tools/write-files.ts`、对应测试、`src/tools/types.ts`、`src/tools/schema.ts`、`src/tools/registry.ts`、对应测试、`src/tools/permission-gateway.ts`、对应测试、`src/tools/permission-target.ts`、`src/core/tool-scheduler.ts`、对应测试、`src/tools/default-registry.ts`、`src/tools/mode-policy.ts`、对应测试
- 依赖：T1

步骤：

1. 在 Registry 准备阶段对命令执行 JSON-as-command、整串外层引号和显式 cwd 后重复同目录 `cd` 的保守检测，返回带安全建议的 `invalid-arguments`。
2. 保持精确 schema 对未知字段、缺失 content 和错误类型的拒绝，不自动补字段或重写 shell。
3. 扩展 Prepared Tool Call 支持同类多权限目标；所有目标在授权和执行前冻结、逐项校验和重校验。
4. 实现 `write_files` 的项数、单文件与总字节上限，全部预检成功后按输入顺序串行原子写入，返回逐项真实结果与整体 sideEffect。
5. 注册批量工具并保持 Plan 模式只读；验证多个模型工具调用的只读并发和写入串行顺序不变。

验证：

- 运行：`npm run test -- src/tools/command-preflight.test.ts src/tools/run-command.test.ts src/tools/write-files.test.ts src/tools/registry.test.ts src/tools/permission-gateway.test.ts src/core/tool-scheduler.test.ts src/tools/mode-policy.test.ts`
- 期望：畸形参数在授权/副作用前失败，批量路径全部经过权限判断，部分 I/O 失败被准确报告且写操作不并发。

## T5：提供受沙箱保护的长驻进程生命周期

- 对应：F10，`plan.md` 的「工具与权限」
- 文件：`src/tools/command-sandbox.ts`、`src/tools/macos-seatbelt-sandbox.ts`、对应测试、`src/tools/managed-process.ts`、对应测试、`src/tools/process-tools.ts`、`src/tools/default-registry.ts`、`src/tools/mode-policy.ts`
- 依赖：T4

步骤：

1. 扩展 Command Sandbox，使其可返回受控子进程句柄，同时复用现有 Seatbelt profile、cwd、网络和取消边界。
2. 实现单次 Agent 运行作用域的进程控制器：随机 ID、数量上限、stdout/stderr 有界环形缓冲、cursor、进程状态和进程组清理。
3. `start_process` 支持可选 loopback 端口就绪等待；未就绪、提前退出和取消时停止进程并返回结构化结果。
4. `process_status` 只读取本控制器 ID 的状态与增量日志；`stop_process` 使用温和终止后有界升级，`close` 回收所有残留进程。
5. Chat 路由在 Agent 结束、抛错或取消的 finally 路径调用 `close`，普通 `run_command` 超时语义保持不变。

验证：

- 运行：`npm run test -- src/tools/macos-seatbelt-sandbox.test.ts src/tools/managed-process.test.ts src/tools/run-command.test.ts`
- 期望：测试 HTTP 服务可启动、等待端口、分页读日志和停止；超时、取消及 Agent 结束后没有残留进程。

## T6：建立结构化完成证据与验证状态

- 对应：F14，`plan.md` 的「工具失败预算与完成证据」
- 文件：`src/core/completion-tracker.ts`、对应测试、`src/tools/report-completion.ts`、`src/core/agent-loop.ts`、对应测试、`src/tools/default-registry.ts`、`src/tools/mode-policy.ts`、`src/core/system-prompt/action-execution.ts`、`src/core/system-prompt/system-prompt.test.ts`、`src/core/agent-events.ts`
- 依赖：T3、T4

步骤：

1. 跟踪当前轮工具 call ID、结果、迭代、sideEffect 和最后一次应用写入的位置，不保存工具参数原文。
2. 实现 `report_completion` schema，校验检查项、blocker、证据引用、成功状态和写入后的验证时序。
3. Agent 最终停止时携带 accepted assessment；缺少报告为 unverified，失败/未运行项映射 partial 或 blocked，不把自然语言当证据。
4. 更新系统提示，要求运行期 ID 来自实际响应、依赖测试在前置成功后执行、完成报告与最终文字一致。
5. 用脚本 Provider 覆盖硬编码 ID 诱因、前置失败跳过级联、伪造 call ID 和局部验证过度声明。

验证：

- 运行：`npm run test -- src/core/completion-tracker.test.ts src/core/agent-loop.test.ts src/core/system-prompt/system-prompt.test.ts`
- 期望：只有引用有效成功证据的完整报告得到 verified，其他场景稳定为 partial/unverified/blocked。

## T7：增加运行阶段驱动的上下文效率压缩

- 对应：F12、F13，`plan.md` 的「上下文效率压缩」
- 文件：`src/core/context/operational-compaction.ts`、对应测试、`src/core/context/types.ts`、`src/core/context/context-manager.ts`、对应测试、`src/models/config.ts`、对应测试
- 依赖：T1、T3

步骤：

1. 以完整 assistant-tool-call/tool-result 交换组为最小选择单元，识别已完成的大写入、旧成功结果和重复失败组。
2. 把选中原始交换组有界序列化到 Context Store，并用结构化边界摘要与 `context://` 引用替换，保持 Provider 消息协议合法。
3. 保护最近工作集、未完成工具、最近失败、用户指令、当前目标和完成证据；写入或协议校验失败时原地回滚。
4. 在估算阈值和工具密集阶段触发确定性压缩，保留现有轻量结果卸载与窗口临界模型摘要。
5. 记录压缩前后估算和引用生命周期，清空/删除/回滚继续正确清理。

验证：

- 运行：`npm run test -- src/core/context/operational-compaction.test.ts src/core/context/context-manager.test.ts src/models/config.test.ts`
- 期望：长工具历史显著缩小、消息协议配对有效、引用可读、近期事实保留，任何失败不破坏原上下文。

## T8：统一会话写操作、只读活动检查与显式恢复

- 对应：F1～F4、F16，`plan.md` 的「会话读取、运行与恢复」与「会话操作与存储」
- 文件：`src/lib/local-conversation-store.ts`、对应测试、`src/web/conversation-runtime-manager.ts`、对应测试、`src/web/conversation-operation-guard.ts`、对应测试、`src/web/conversation-http.ts`、`src/app/api/chat/route.ts`、`src/app/api/conversations/[conversationId]/route.ts`、`clear/route.ts`、`compress/route.ts`、`retry/route.ts`、`recover/route.ts`
- 依赖：无

步骤：

1. 扩展租约返回 owner token，活动 marker 绑定 token；增加完全只读的 lease/marker activity 检查，不在 GET 中调用恢复。
2. 实现 Operation Guard，统一进程内活动登记、跨进程租约、expected revision、取消和逆序释放。
3. 将 Agent、压缩、重命名、清空、删除、未保存重试和恢复路由接入守卫；busy/conflict 使用统一错误码。
4. 新增显式恢复 POST：只有租约可取得、marker 所有者已失效且 revision 匹配时原子提交一次中断；重复调用幂等返回最新版本。
5. 底层存储错误保留 cause 供受控诊断，但公开 RepositoryError 和 API 不再拼接原始消息或路径。

验证：

- 运行：`npm run test -- src/lib/local-conversation-store.test.ts src/web/conversation-runtime-manager.test.ts src/web/conversation-operation-guard.test.ts`
- 期望：第二实例读取活动会话不改 revision，所有写冲突被拒绝，过期恢复只提交一次，注入绝对路径不会进入公开错误。

## T9：贯通 Web 合约、持久化和阶段日志

- 对应：F5～F7、F14、F16，`plan.md` 的「模型请求、重试与终止」「运行日志」
- 文件：`src/web/chat-contract.ts`、对应测试、`src/web/chat-handler.ts`、对应测试、`src/core/conversations/types.ts`、`validation.ts`、`display-timeline.ts`、对应测试、`src/lib/local-agent-run-log.ts`、对应测试、`src/lib/local-agent-run-exporter.ts`、对应测试、`src/app/api/chat/route.ts`
- 依赖：T2、T3、T6、T8

步骤：

1. 严格解析和编码扩展 progress、停止原因、verification 与 conversation activity；未知字段仍拒绝。
2. Web handler 保留 Provider/Agent 分类，任何异常路径都产生唯一停止事件并尝试提交部分文本、工具结果和中断上下文。
3. 持久显示记录保存 verification，旧记录缺失时安全默认为 unverified；未完成工具统一收敛为 cancelled/failed。
4. 日志 schema 增加每次 attempt 的 trace、阶段耗时、参数规模、重试与结果分类；继续兼容导出旧 schema。
5. 用伪密钥、授权头、工具参数和临时绝对路径做负向断言，日志失败不得改变会话保存状态。

验证：

- 运行：`npm run test -- src/web/chat-contract.test.ts src/web/chat-handler.test.ts src/core/conversations/display-timeline.test.ts src/lib/local-agent-run-log.test.ts src/lib/local-agent-run-exporter.test.ts`
- 期望：完整与中断运行均可恢复和导出，阶段信息可关联，所有敏感测试串均不存在于输出。

## T10：修复页面加载收敛和工具时间线空隙

- 对应：F1、F3、F5、F14、F15，`plan.md` 的「前端加载与时间线」
- 文件：`src/components/chat-workspace.tsx`、对应测试、`src/components/chat-session-state.ts`、对应测试、`src/components/message-list.tsx`、对应测试、`src/app/globals.css`
- 依赖：T8、T9

步骤：

1. 把会话加载改为保留旧快照的显式 loading/ready/error/cancelled 收敛，所有事件 handler 消费 Promise 失败。
2. activity 为 active 时展示只读运行状态；interrupted 时调用显式恢复并处理 busy/conflict；不再通过读取触发恢复。
3. reducer 和持久时间线构造忽略纯空白 text part，MessageTimeline 对旧历史做防御性过滤。
4. 用时间线容器 gap 统一文字/工具间距，移除工具 wrapper 重复 margin；保持语义文字 `pre-wrap`、顺序和 aria 标签。
5. 展示模型请求阶段、参数规模/耗时和 verification 状态，不显示 trace 或完整参数。

验证：

- 运行：`npm run test -- src/components/chat-workspace.test.tsx src/components/chat-session-state.test.ts src/components/message-list.test.tsx src/core/conversations/display-timeline.test.ts`
- 期望：失败加载不再卡 loading 或产生未处理 rejection；3～13 个纯换行片段不生成空白块，有意义多行文字和工具顺序保持。

## T11：完成配置说明、性能基准和整体验收

- 对应：F1～F16，`plan.md` 的「验证策略」
- 文件：`README.md`、`orbitcode.example.yaml`、上述模块及其测试 fixture
- 依赖：T1～T10

步骤：

1. 修正 README 中切换 Workspace/Provider 的矛盾描述，只补充本轮必要的安全和配置信息。
2. 增加受控 Provider 基准：约 30 个文件变更、批量/多调用、验证报告在不超过 30 次模型迭代内完成。
3. 运行全部测试、lint、typecheck、build 和 `git diff --check`，只修复本轮引入的问题。
4. 启动开发服务器，用浏览器复现并验证跨标签页读取、加载失败、模型阶段和连续工具卡布局，检查控制台与错误覆盖层后停止服务。
5. 在 tmux 中执行安全的 Agent 端到端场景，覆盖畸形参数、重复失败、受管进程、模型流中断、继续和 unlimited 运行时限；不记录或展示真实密钥。

验证：

- 运行：`npm run test && npm run lint && npm run typecheck && npm run build && git diff --check`
- 期望：所有命令退出 0；基准不超过 30 次迭代；浏览器与 tmux 验收没有残留进程、控制台错误、敏感输出或会话冲突。

## 执行顺序

```text
T1 → T2 → T3 ───────────────┐
 │        ├──→ T6 ──────────┤
 │        └──→ T7 ──────────┤
 └──→ T4 → T5 ──────────────┤
                             ├──→ T9 → T10 → T11
T8 ──────────────────────────┘
```

T8 与模型、工具、上下文主线相互独立，可在 T1～T7 期间单独实施；所有共享文件的最终接入集中在 T9，避免多条任务同时修改 Chat 路由和 Web 合约。
