# CLI 与 Web 功能对齐 Tasks

状态：已批准
依据：已批准的 [spec.md](spec.md) 与已批准的 [plan.md](plan.md)
流程：用户授权连续生成文档；四份文档已获用户统一批准，按以下顺序实施。

## 文件清单

所有路径相对仓库根目录。迁移保留 Web 兼容包装；不删除历史规格或无关代码。下表与各任务文件项共同构成本轮文件清单。

| 操作 | 文件组 | 职责 | 任务 |
| --- | --- | --- | --- |
| 新建 | `src/runtime/types.ts`、`config.ts`、`workspace-config.ts`、`prompt-environment.ts` | 共用配置与契约 | T1 |
| 新建 | `src/runtime/permission-session-manager.ts`、`conversation-runtime-manager.ts`、`conversation-operation-guard.ts`、`conversation-service.ts` | 共用会话操作与授权 | T2 |
| 新建 | `src/runtime/agent-runtime.ts`、`agent-run-tracker.ts` | 单轮编排和运行统计 | T3 |
| 修改 | `src/web/` 对应迁移源、`chat-contract.ts`、`conversation-store.ts`、`permission-session-store.ts`、`agent-run-log-store.ts` | 兼容类型与实例组装 | T1–T4 |
| 修改 | `src/app/api/chat/route.ts`、`src/web/chat-handler.ts`、`src/app/api/conversations/**/route.ts` | Web 调用共享服务 | T4 |
| 新建/修改 | `src/core/conversations/plan-execution.ts`、`src/components/chat-session-state.ts`、`chat-workspace.tsx` | 共享计划规则 | T5 |
| 修改/新建 | `src/cli/arguments.ts`、`main.ts`、`commands.ts`、`session-controller.ts`、`terminal-chat.ts` | CLI 接入、命令与并发输入 | T6–T7 |
| 新建 | `src/cli/renderer.ts`、`terminal-text.ts` | 文本展示与控制序列净化 | T6 |
| 修改 | `src/lib/local-agent-run-log.ts`、`local-agent-run-exporter.ts`、`local-conversation-exporter.ts` | 来源兼容及完整导出 | T3、T7 |
| 新建/修改 | 对应 `*.test.ts`、`tests/cli-*.e2e.test.ts`、`tests/runtime-parity.e2e.test.ts`、`tests/helpers/` | 行为和跨入口验证 | T1–T8 |
| 修改 | `README.md`、`AGENTS.md`、`docs/evals/README.md` | 操作与结构说明 | T9 |

## T1：抽出配置与运行契约

- 对应：F1、F10，plan「核心类型与接口」「模块设计与文件组织」。
- 文件：表中 T1 模块；原 `src/web/server-config.ts`、`workspace-config.ts`、`prompt-environment.ts`、`chat-contract.ts`；新增 `src/web/server-config.test.ts`、`workspace-config.test.ts`。
- 依赖：无；实施前四份文档必须通过统一审核。

步骤：

1. 定义 RuntimeTurnEvent、PersistenceState 和配置摘要，公共限制不再由 runtime 引用 Web 提供。
2. 迁移 Provider、环境、Workspace、迭代数/时长解析和提示环境，增加显式 configPath；保持 Web 默认配置行为。
3. 保留 Web 导出包装，新增可注入 cwd/environment 的配置测试，验证不会随 Workspace 切换重新加载凭据。

验证：`npx tsx --test src/web/server-config.test.ts src/web/workspace-config.test.ts src/web/server-config.test.ts src/web/workspace-config.test.ts src/web/prompt-environment.test.ts`；默认/显式配置、非法参数、缺失凭据和 Workspace 边界测试通过。以 `rg -n '@/web|@/app|@/components|from "react"|from "next' src/runtime src/core` 检查依赖方向，预期无反向导入。

## T2：共享会话与权限生命周期

- 对应：F4、F7–F9，plan「单轮执行与保存」「Plan、会话和恢复」。
- 文件：表中 T2 模块；原 Web 对应管理器/守卫包装与 store；新增 `src/runtime/conversation-service.test.ts`、`permission-session-manager.test.ts`，复用现有 lib 存储测试。
- 依赖：T1。

步骤：

1. 迁移管理器与操作守卫，权限 TTL、授权匹配和关闭行为保持原样；运行实例由入口组装，测试不共享全局实例。
2. 抽取会话 CRUD、setMode、压缩、recover、retrySave；所有写操作取得租约后检查 revision，释放失败不掩盖原始错误。
3. 压缩返回报告和实际 checkpoint；pending save 继续只驻留本进程。配置不可用仍可读取历史与导出。
4. 增加保存失败、冲突、模式保存、摘要失败、失效授权及中断恢复测试。

验证：`npx tsx --test src/runtime/conversation-service.test.ts src/web/permission-session-manager.test.ts src/lib/local-conversation-store.test.ts src/web/conversation-operation-guard.test.ts src/web/permission-session-manager.test.ts`；重试保存不调用模型、不重复执行工具，过期授权无效，冲突不覆盖已有记录。

## T3：共享 Agent 单轮编排与日志

- 对应：F2、F6、F7、F9–F11，plan「单轮执行与保存」「安全与权限边界」。
- 文件：`src/runtime/agent-runtime.ts`、`agent-run-tracker.ts` 及同名测试；日志与两个 exporter；对应现有 lib 日志、导出测试。
- 依赖：T2。

步骤：

1. 从 chat 路由抽取工具、权限、上下文、完成跟踪及 AgentLoop 组装，保留完整 registry 和提示信息。
2. 抽取 AgentRunTracker，将现有日志 source 从 web 扩展为 web/cli；更新实际读写校验与导出路径，保留版本 3/4 的 Web 记录兼容，缺失必要字段仍报错。
3. 实现运行、保存、日志、资源清理和唯一 finished 顺序；消费者提前关闭触发取消和 finally，清理步骤彼此独立。
4. 注入可控 Provider、存储、时钟和沙箱，覆盖工具失败、模型失败、超时、上下文停止、取消、保存与日志失败。测试只针对编排新增风险，不复制所有工具内部单测。

验证：`npx tsx --test src/runtime/agent-runtime.test.ts src/web/chat-handler.test.ts src/lib/local-agent-run-log.test.ts src/lib/local-agent-run-exporter.test.ts`；唯一终止、租约和子进程回收、未保存状态、旧日志兼容均通过。完整注册工具逐项有调用适配覆盖。

## T4：Web 切换到共享运行时

- 对应：F2、F4、F7–F11、N5，plan「架构概览」「验证策略」。
- 文件：chat 路由与 handler、全部 conversation 路由及 Web 单例组合；`src/web/chat-handler.test.ts`，现有 `tests/web-*.e2e.test.ts`。
- 依赖：T3。

步骤：

1. HTTP 保留请求大小、同源、字段解析、错误状态码；代理 runtime 事件为现有 SSE 格式。
2. conversation 路由调用 ConversationService，保持原响应形状与可读历史行为。
3. 删除路由/handler 内被抽取的重复执行逻辑；Web 断连时仍驱动保存和清理。warning 对 Web 使用现有错误/状态展示机制或兼容可选事件，不破坏旧事件解析。

验证：`npx tsx --test src/web/chat-handler.test.ts src/web/chat-contract.test.ts tests/web-tool-agent.e2e.test.ts tests/web-permission-agent.e2e.test.ts tests/web-context-management.e2e.test.ts tests/web-conversation-persistence.e2e.test.ts`；HTTP 契约、断连收尾和现有 Agent 流程通过。

## T5：共享计划执行规则

- 对应：F3，plan「Plan、会话和恢复」。
- 文件：`src/core/conversations/plan-execution.ts`、`plan-execution.test.ts`；`src/components/chat-session-state.ts`、`chat-session-state.test.ts`、`chat-workspace.tsx`。
- 依赖：T4。

步骤：

1. 抽取最新成功 Plan 资格、失效条件及执行请求文案，保持纯函数与判别状态。
2. Web 使用共享规则；确保 request/modeTurn 的现有约定不变。
3. 覆盖失败、取消、后续请求、Workspace 切换、清空、历史恢复和 revision 变化后的计划失效。

验证：`npx tsx --test src/core/conversations/plan-execution.test.ts src/components/chat-session-state.test.ts src/tools/mode-policy.test.ts`；不合法计划无法触发 Do，模式切换不请求模型。

## T6：CLI 运行输入与展示闭环

- 对应：F1–F6、F10，plan「终端输入状态机」「命令表」「安全与权限边界」。
- 文件：CLI 全部模块；更新 `arguments.test.ts`、`terminal-chat.test.ts`，新增 `commands.test.ts`、`session-controller.test.ts`、`renderer.test.ts`、`terminal-text.test.ts`。
- 依赖：T5。

步骤：

1. 接入独立 runtime 组装，替换纯文本 session；参数默认配置和原有 export-run 保持兼容，更新帮助与退出码。
2. 单一输入监听驱动状态机，Agent 消费另行异步推进；运行中管理命令与普通文本明确拒绝，审批按请求 ID 处理。
3. 接入模式、计划执行、权限模式、Provider/Workspace 切换；校验完成后再替换当前绑定，失败保留原会话。
4. 实现流式文本、阶段、工具结果、Usage、停止、副作用和完成报告显示；控制字符净化器处理跨 chunk 序列及残缺结尾。
5. 区分 TTY 与管线输入；无交互 ask 即拒绝，Ctrl-C/EOF/exit 与清理、保存状态协调。

验证：`npx tsx --test src/cli/arguments.test.ts src/cli/commands.test.ts tests/cli-conversation.e2e.test.ts src/cli/terminal-chat.test.ts src/cli/renderer.test.ts src/cli/terminal-text.test.ts`；必须观察到生成仍未结束时审批答案已被处理，不允许只在轮次结束后验证输入。

## T7：CLI 会话管理、上下文与导出

- 对应：F7–F9、F11，plan「命令表」「Plan、会话和恢复」。
- 文件：`src/cli/commands.ts`、`session-controller.ts`、`main.ts`、`arguments.ts` 及测试；必要的 exporter 适配；新增 `tests/cli-conversation.e2e.test.ts`、`tests/cli-context.e2e.test.ts`。
- 依赖：T6。

步骤：

1. 接通列表、新建、历史、resume、rename、clear、delete、compress、retry-save、recover、tool、export。
2. clear/delete 使用绑定目标和 revision 的确认 token，状态变化或取消使 token 失效；保护未保存结果，恢复时创建新的权限会话。
3. 保留完整工具详情访问及上下文引用隔离；导出子命令在无有效模型配置时可用。写导出文件失败明确反馈，不宣称成功。
4. 重启后恢复模式和历史，旧会话与旧日志可读；绑定失效只读；压缩失败不丢失历史。

验证：`npx tsx --test src/cli/arguments.test.ts tests/cli-conversation.e2e.test.ts tests/cli-conversation.e2e.test.ts tests/cli-context.e2e.test.ts`；检查导出实际内容、保存后 revision、清理后的引用和模型调用次数。

## T8：跨入口、跨进程和完整异常验收

- 对应：F1–F11、AC1–AC12，plan「验证策略」。
- 文件：更新 `tests/cli.e2e.test.ts`、`tests/helpers/openai-mock.ts`；新增 `tests/cli-agent.e2e.test.ts`、`cli-permission.e2e.test.ts`、`runtime-parity.e2e.test.ts`、`conversation-cross-process.e2e.test.ts` 和 `tests/helpers/cli-parity-server.ts`。
- 依赖：T7。

步骤：

1. 扩展本地 SSE 替身场景，以公开模型协议控制工具、多轮修复、摘要、部分流断开、Usage 和异常；使用合成凭据。
2. 同场景比较 CLI 和 Web 的工具集合、权限、停止和磁盘结果，忽略展示格式、随机 ID、时间差异。
3. 两个独立进程竞争同会话；强制结束一个进程后检查中断恢复，不重放工具。失败路径检查无残留服务及租约。
4. tmux 使用替身完成审批、Ctrl-C、EOF、最大迭代和超时场景；浏览器完成 Web→CLI→Web 继续、计划执行和压缩。

验证：`npx tsx --test tests/cli.e2e.test.ts tests/cli-agent.e2e.test.ts tests/cli-permission.e2e.test.ts tests/runtime-parity.e2e.test.ts tests/conversation-cross-process.e2e.test.ts`；端到端操作和预期按 checklist 逐项留证。测试全部使用临时会话目录和 Workspace，不删除或污染用户真实会话库。

## T9：文档与最终检查

- 对应：N1–N5、AC12，plan「模块设计与文件组织」「验证策略」。
- 文件：`README.md`、`AGENTS.md`、`docs/evals/README.md`、本目录 `checklist.md`。
- 依赖：T8。

步骤：

1. 在现有结构中更新 CLI 启动、命令、终端审批、配置互通前提、恢复限制、日志来源和 runtime 职责；移除“迭代限制仅影响 Web”等过时描述。
2. 运行 `npm test`，再依次 `npm run lint`、`npm run typecheck`、`npm run build`，最后 `git diff --check`。
3. 依据 checklist 完成浏览器与 tmux 操作；未配置安全真实 Provider 环境则单列未验证，模拟结果不得替代。
4. 记录逐项命令、退出码、关键观察和剩余问题；关闭所有测试创建的服务器、浏览器、tmux 会话与子进程。

验证：检查项逐一对应实际证据，没有执行的项目保持未勾选；不提交、推送或发布。

## 执行顺序

T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9。

每步先完成聚焦验证再进入下一步；共享架构或公开行为发生超出 plan 的变化时更新受影响文档并报告，不以降低安全限制解决测试失败。

## 实施记录（2026-09-18）

T1–T9 的实现及文档更新已完成。共享单轮执行另拆为 `src/runtime/run-agent-turn.ts`，Web 单例由 `src/web/agent-runtime.ts` 组装；原 Web store 实例保持原职责。配置、权限和运行统计测试复用 Web 兼容入口测试；CLI controller 通过端到端行为测试覆盖，未额外创建同名单测。导出复用已有 exporter，无需修改其协议。清空会话的 Do 模式同步写入持久层。

新增测试辅助入口显式注入临时存储，不访问用户会话库。受管进程 IPv6 测试改为有界等待日志，消除端口就绪早于日志到达的时序假设；未放宽安全限制。未新增运行时依赖，未提交或推送。

全量测试 341/341 通过，lint、typecheck、build 通过。终端及浏览器使用本机 SSE 替身完成实际文件/命令操作；用户随后授权 tertiary 补验并修复完成报告反馈，原场景已正常收尾；最新全量测试 344/344 通过，详见 [checklist.md](checklist.md)。

### 已授权的完成报告反馈修复

用户确认最小修复方案后，完成 `src/core/completion-tracker.ts` 的多错误定位、`src/tools/report-completion.ts` 的结构化反馈及 `src/core/system-prompt/action-execution.ts` 的恢复说明。新增 tracker/CLI 回归测试；调整 Web 压缩测试 fixture 的容量余量以容纳提示增长，生产限制不变。该改动不新增工具或放宽验收、安全与失败预算规则。tertiary 原场景复验及最终检查证据见 checklist 末节。
