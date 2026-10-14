# 界面配置与 Agent 评测闭环 Tasks

状态：已批准
日期：2026-10-11
依据：[spec.md](spec.md) 与 [plan.md](plan.md) 已批准
关联：[验收清单](checklist.md)

> 本文保留批准时的任务划分。实现已于 2026-10-14 收尾；实际文件映射与验证见文末及 checklist.md。不包含提交、推送、PR 或部署。

## 文件与职责清单

| 操作 | 路径 | 职责 | 需求 |
| --- | --- | --- | --- |
| 新建 | src/runtime/settings-types.ts、settings-service.ts、settings-import.ts | 配置领域、来源与导入 | F1–F6 |
| 新建 | src/lib/local-settings-store.ts | 原子私密存储、冲突与恢复 | F2–F6 |
| 新建 | src/runtime/storage-paths.ts | 所有存储和权限路径注入 | F10 |
| 修改 | src/runtime/config.ts、workspace-config.ts、mcp-config.ts、types.ts、agent-runtime.ts、conversation-service.ts | 托管配置与旧配置适配、快照与身份 | F1–F6 |
| 修改 | src/models/config.ts、src/lib/local-agent-run-log.ts、src/runtime/agent-run-tracker.ts | 可复用校验与运行来源记录 | F2、F6、F8、F13 |
| 修改 | src/tools/permission-config.ts、src/lib/local-conversation-store.ts、local-context-store.ts | 隔离路径与显式规则输入 | F9、F10 |
| 新建/修改 | src/runtime/mcp-management.ts、mcp-connections.ts、mcp-host.ts | 管理操作、租约排空与重连 | F4、F6 |
| 新建 | src/web/local-management-guard.ts、settings-contract.ts、settings-operations.ts | 本地会话保护、公开投影、异步操作事件 | F1–F6 |
| 新建 | src/app/api/settings/ 下 route.ts、import/route.ts、recovery/route.ts、operations/route.ts、operations/[operationId]/route.ts | 设置读写、导入、恢复和操作适配 | F1–F6 |
| 修改 | src/app/api/providers/route.ts、src/app/api/workspaces/route.ts、src/web/server-config.ts、workspace-config.ts、agent-runtime.ts、chat-contract.ts | 旧列表契约迁移、共享注入 | F1–F7 |
| 新建 | src/app/settings/page.tsx、src/components/settings/、src/components/run-summary.tsx | 设置界面与运行摘要 | F1–F7 |
| 修改 | src/components/chat-workspace.tsx、conversation-binding.ts、message-list.tsx、src/app/globals.css | 空态、切换、状态与样式 | F1、F7 |
| 新建/修改 | src/cli/run-once.ts、run-result.ts、arguments.ts、main.ts、session-controller.ts | 单次执行与兼容交互 | F8–F10 |
| 新建 | src/evals/types.ts、runner.ts、acceptance.ts、report.ts、scripts/run-agent-evals.ts、tests/fixtures/agent-evals/ | 固定任务及独立验收 | F12、F13 |
| 修改 | package.json、README.md、docs/evals/README.md | 命令与使用边界 | F5、F8、F11–F13 |
| 新建/修改 | 下列任务对应 *.test.ts、tests/*.e2e.test.ts、tests/helpers/ | 契约及集成测试 | F1–F13 |

## T1：配置领域与私密事务存储

- 对应：F1、F2、F3、F5、F6；N1、N3；Plan 第 3 节。
- 文件：新增 settings-types.ts、settings-service.ts、local-settings-store.ts 及同名测试。
- 依赖：无。
- 步骤：定义公开/私密类型、稳定 ID、归档和默认项约束；实现 revision、跨进程租约、原子写入、权限与损坏恢复；实现 keep/replace/environment/clear 凭据动作和公开投影。允许空配置。
- 验证：`npx tsx --test src/lib/local-settings-store.test.ts src/runtime/settings-service.test.ts`；使用两个子进程竞争同 revision，仅一个成功；模拟中途失败不产生半份配置；合成密钥不出现在响应和错误；损坏配置未经显式恢复不变。

## T2：来源解析、旧配置导入与会话兼容

- 对应：F2、F3、F5、F6；Plan 第 3 节。
- 文件：新增 settings-import.ts 及测试；修改 runtime/config.ts、workspace-config.ts、mcp-config.ts、types.ts、conversation-service.ts、models/config.ts。
- 依赖：T1。
- 步骤：抽取可复用校验；实现托管/旧配置/显式 --config 来源规则；导入预览及版本/源文件指纹复检；保留旧 Provider 身份；归档资源、工作区根不可变、默认项有效性检查；更新类型消费者但不改旧会话内容。
- 验证：`npx tsx --test src/runtime/settings-import.test.ts src/models/config.test.ts src/web/workspace-config.test.ts src/runtime/conversation-service.test.ts`；覆盖旧会话继续、改名不变 ID、损坏托管配置不回退、导入全有或全无、同名 MCP 覆盖与禁用遮蔽。

## T3：共享快照与隔离路径

- 对应：F6、F10；N2、N4；Plan 第 3、6 节。
- 文件：新增 storage-paths.ts 及测试；修改 agent-runtime.ts、config.ts、web/agent-runtime.ts、cli/main.ts、tools/permission-config.ts、lib 的会话/上下文构造注入、agent-run-tracker.ts、local-agent-run-log.ts。
- 依赖：T2。
- 步骤：两端注入同一配置服务与路径工厂；会话租约后固定整轮资源快照；记录非秘密配置版本；隔离目录覆盖配置/日志/会话/上下文/权限/MCP；禁止隔离环境隐式读取用户文件和 .env.local。
- 验证：`npx tsx --test src/runtime/storage-paths.test.ts src/runtime/agent-runtime.test.ts tests/runtime-parity.e2e.test.ts tests/conversation-cross-process.e2e.test.ts`；运行中变更只影响下一轮；在用户目录放置哨兵配置验证隔离运行不读取/修改；原有 source 与日志旧 schema 仍可读取。

## T4：MCP 管理服务与连接生命周期

- 对应：F4、F6；N4、N6；Plan 第 4 节。
- 文件：新增 mcp-management.ts 及测试；修改 mcp-connections.ts、mcp-host.ts 及测试，复用 mcp-initialization.ts 权限流程。
- 依赖：T3。
- 步骤：实现状态快照、显式连接/断开/重连、作用域显示；新增不接新租约但保留已有调用的排空语义；探测使用独立 operationId/取消/时限；所有连接经授权与复检；不重放工具。
- 验证：`npx tsx --test src/runtime/mcp-management.test.ts src/runtime/mcp-connections.test.ts src/runtime/mcp-initialization.test.ts tests/mcp-e2e.test.ts`；覆盖 HTTP/stdio、保存零外部动作、审批后才启动、活跃租约排空、失败重连、取消与子进程清理。

## T5：受保护的配置接口与探测操作

- 对应：F1–F6；N1、N5、N6；Plan 第 4、5 节。
- 文件：新增 web/local-management-guard.ts、settings-contract.ts、settings-operations.ts 及测试；新增 settings 路由；修改现有 provider/workspace 路由、server-config.ts、workspace-config.ts、chat-contract.ts。
- 依赖：T4。
- 步骤：实现公开字段白名单、本地会话、Origin/Host/token 校验、冲突 HTTP 状态；接入导入/恢复及事件型管理操作；模型探测不携带会话/工具；保证未配置时接口可用，操作订阅先于审批等待。
- 验证：`npx tsx --test src/web/local-management-guard.test.ts src/web/settings-contract.test.ts src/web/settings-operations.test.ts tests/settings-api.e2e.test.ts`；跨站/伪 Host/缺 token 被拒绝，普通 GET 无密钥，冲突为 409，字段错误可定位，取消探测无悬挂操作。

## T6：首次使用与资源设置界面

- 对应：F1–F6；N5；Plan 第 5 节。
- 文件：新增 app/settings/page.tsx、components/settings/{settings-panel,model-form,workspace-form,mcp-form,preferences-form,diagnostic-status}.tsx 及组件测试；修改 globals.css、chat-workspace.tsx。
- 依赖：T5。
- 步骤：实现空态引导、资源 CRUD/归档与默认项、路径检查、导入预览、凭据保留/清除、MCP 工具列表；显示来源与下轮生效；错误直达对应表单；键盘与可访问标签完整。
- 验证：`npx tsx --test src/components/settings/*.test.tsx`；随后在开发服务下用 agent-browser 从空配置完成模型/工作区/MCP 设置及第一轮模拟对话，记录各状态、错误覆盖层与控制台，结束关闭浏览器和服务。不截图真实凭据。

## T7：聊天状态与结束摘要

- 对应：F7；Plan 第 5 节。
- 文件：新增 run-summary.tsx 及测试；修改 chat-workspace.tsx、conversation-binding.ts、message-list.tsx 及关联测试。
- 依赖：T6。
- 步骤：展示绑定、模型/工具/审批/停止/保存阶段；切换提示新会话；配置失效保持历史可读；摘要分别投影 stopReason、verification、persistence；提供重试保存与配置修复操作。
- 验证：`npx tsx --test src/components/chat-workspace.test.tsx src/components/conversation-binding.test.ts src/components/run-summary.test.tsx`；浏览器实测审批、取消、保存失败、刷新与恢复；确认重试保存不重复执行工具，运行结束不等同验收成功。

## T8：CLI 单次执行与结果协议

- 对应：F8、F9、F10；Plan 第 6 节。
- 文件：新增 cli/run-once.ts、run-result.ts 及测试；修改 arguments.ts、main.ts、session-controller.ts、tests/helpers/cli-process.ts；新增 tests/cli-run-once.e2e.test.ts。
- 依赖：T3、T4。
- 步骤：实现文件/stdin 多行输入、resume 约束、JSON/JSONL、executionId/runId 关联和退出码；实现有限预算、信号取消、清理；新 run 的审批阻塞取消策略及 policy-file；隔离子进程环境；保留交互入口和旧导出命令。
- 验证：`npx tsx --test src/cli/arguments.test.ts src/cli/run-result.test.ts src/cli/run-once.test.ts tests/cli-run-once.e2e.test.ts tests/cli-permission.e2e.test.ts`；直接子进程捕获 stdout 并解析，模拟配置错误、审批、日志/保存/清理失败、EOF、SIGINT、超时；断言单一终态且进程退出，不用输出文本 contains 判断协议成功。

## T9：固定任务与独立评测执行器

- 对应：F12；N4、N6；Plan 第 7 节。
- 文件：新增 evals/types.ts、runner.ts、acceptance.ts 及测试、scripts/run-agent-evals.ts、tests/fixtures/agent-evals/、tests/eval-runner.e2e.test.ts；修改 package.json。
- 依赖：T8。
- 步骤：实现 E1–E6 fixture、外部验收、独立数据目录、显式预算与元数据；子进程超时终止进程组；验收器不可被 Agent 写入；建立执行结果和验收结果双维度。新增 eval:agent 脚本，默认 npm test 不执行真实模型。
- 验证：`npx tsx --test src/evals/runner.test.ts src/evals/acceptance.test.ts tests/eval-runner.e2e.test.ts`；mock 驱动通过、错误产物、伪造完成、越界尝试、验收器崩溃、缺终态和外部服务失败；确认验收脚本被工作区同名文件替换也不能骗过判分。

## T10：评测报告与使用文档

- 对应：F5、F8、F11、F13；Plan 第 6–8 节。
- 文件：新增 evals/report.ts 及测试；修改 README.md、docs/evals/README.md；新增 docs/evals/agent-evaluation.md。
- 依赖：T9、T7。
- 步骤：输出每 case 重复结果、分母、失败分类、耗时/usage/人工介入和证据缺口；按版本检查是否可比较；撰写无手工配置上手流程、旧配置来源、CLI 退出码、隔离和显式真实评测用法；保留只读诊断语义。
- 验证：`npx tsx --test src/evals/report.test.ts`；合成混合结果检查分母与缺失值，拒绝初态/验收版本不同却标受控对比；人工逐条检查文档命令与 help 一致，示例无真实凭据。

## T11：整链路回归与真实基线

- 对应：F11–F13、全部 N；Plan 第 8 节。
- 文件：更新 checklist.md 证据；必要时补对应 tests；原始结果写入 tmp/agent-evals/，脱敏基线写入 docs/evals/agent-evaluation.md。
- 依赖：T10。
- 步骤：先运行全部确定性测试；依次 lint/typecheck/build；agent-browser 完整用户链路；tmux 真实 CLI 输入与观察，使用本地替身稳定覆盖工具失败/参数错误/命令超时/轮数上限。随后在运行者显式选定 provider 与预算下运行真实模型 E1–E6 重复基线。凭据缺失或预算未指定时标未验证，不调用默认真实服务。
- 验证：`npm test`、`npm run lint`、`npm run typecheck`、`npm run build` 均记录退出码；真实评测记录每个 runId、独立验收与资源清理，不把 fixture 测试通过写成模型效果通过。浏览器/tmux/服务与子进程完成后关闭。

## T12：证据驱动的最小改善与复测

- 对应：F13；Plan 第 7 节。
- 文件：以 T11 确认问题所在模块为准，变更前在此补具体路径与失败用例；报告写 docs/evals/agent-evaluation.md，原始证据留 tmp/。
- 依赖：T11。
- 步骤：按现有诊断模板给出最多三个问题；区分明确缺陷、效果假设与证据不足；针对一个主要因素提出最小改动和证伪标准，固定对比条件后执行目标用例与回归。不得预先承诺修改未知模块；改变安全、公开行为或本轮范围时先修订受影响文档。没有证实问题则报告基线与限制，不强行修改。
- 验证：对应回归命令写入任务证据；同模型/初态/预算重复目标 case，报告全部结果而非挑选最好一次；涉及代码变更再次依次 lint/typecheck/build，涉及页面再跑浏览器检查。未改善或出现回归须明确记录，不标效果提升。

## 执行顺序与交付门槛

```text
T1 → T2 → T3 → T4 → T5 → T6 → T7
                T4 → T8 → T9
                  T7 + T9 → T10 → T11 → T12
```

此图只表达依赖，不授权额外 Agent 或独立任务。阶段交付为：T1–T3 配置与隔离契约；T4–T7 可操作的界面闭环；T8–T10 可复测工具链；T11–T12 有证据的基线与改善结论。每阶段验证通过后再推进依赖项。


## 2026-10-14 实施映射与收尾证据

T1–T12 已按现有边界落地，验证见 [收尾验收](../../evals/interaction-closeout-2026-10-14.md)。若实现合并了原计划中的文件职责，以此映射为准，不生成空壳模块：

- T1–T3：`runtime/settings-{types,service,import}.ts`、`lib/local-settings-store.ts`、`lib/settings-lock.ts`；路径由 `web/storage-paths.ts` 与 CLI 入口显式注入，整轮资源来自共享 ProviderContext 快照。
- T4–T6：`runtime/mcp-connections.ts` 维护租约和排空；`web/settings-mcp.ts` 在设置改变后只清理旧连接；`web/settings-operations.ts` 维护订阅、归属和取消，settings API 复用原客户端。连接按钮本身是显式人工连接授权，对话的连接及工具审批仍走原 PermissionGateway。操作在首次 SSE 订阅后执行，工作区验证和断开是直接有界操作，不建立无必要的后台任务。
- T6–T7：设置表单集中于 `components/settings/settings-panel.tsx`，浏览器操作适配独立在 `settings-operation.ts`；结束摘要复用 `message-list.tsx`，不新增重复的摘要数据源。保存状态由 chat-session-state 投影，重试只保存检查点。
- T8–T10：`cli/run-once.ts` 实现单次协议及资源清理；`evals/fixtures.ts` 集中固定初态与独立验收，`runner.ts` 负责父执行器，`report.ts` 负责双维度报告。
- T11–T12：18 次真实全用例回归、E4 三次专项复测及一次 tmux 真实交互；依据 E4 失败补充 `tools/run-command.ts` 的退出码契约说明，保留全部失败与人工评价，不放宽验收器。
