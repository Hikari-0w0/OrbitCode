# 可复用 Skill 实施任务

状态：已批准
依据：同目录已批准的 spec.md、plan.md；用户明确批准开发后执行。

## 文件清单与使用约定

以下路径相对仓库根；新增测试已随对应实现创建。测试命令使用已有 `npx tsx --test`，不安装依赖。

| 操作 | 文件/文件组 | 职责 | 任务 |
| --- | --- | --- | --- |
| 新增 | `src/core/skills/types.ts` | 领域状态、结果与事件契约 | T1 |
| 新增 | `src/runtime/skills/{definition,catalog,service,resources,history,isolated-runner}.ts` 及对应 `.test.ts` | 解析到运行全链路 | T2—T9 |
| 修改 | `src/core/conversations/{types,validation}.ts`、`src/lib/local-conversation-store.ts`、`src/lib/local-conversation-exporter.ts` | 保存、校验、清空、导出 | T3 |
| 修改 | `src/runtime/{conversation-service,conversation-runtime-manager,conversation-recovery}.ts` | 变更锁、恢复、重试 | T3 |
| 新增/修改 | `src/tools/{load-skill,read-skill-resource,skill-policy}.ts`（新增）、`{types,registry,default-registry,mode-policy,permission-target,permission-gateway}.ts`（修改）及对应测试 | 加载、策略、目标校验与注册 | T4—T6 |
| 修改 | `src/core/{agent-loop,tool-scheduler,agent-events}.ts`、`src/core/system-prompt/{types,dynamic-context}.ts` 及对应测试 | 动态提示、调度与事件 | T5、T8 |
| 新增/修改 | `src/runtime/agent-session-factory.ts`（新增）、`{agent-runtime,run-agent-turn,types,agent-run-tracker}.ts`（修改）、`src/lib/local-agent-run-log.ts`（修改） | 共享装配、子执行、日志 | T7—T9 |
| 新增 | `src/runtime/skill-commands.ts` 及测试 | 双端命令解析 | T10 |
| 新增/修改 | `src/web/skill-http.ts`、`src/app/api/conversations/[conversationId]/skills/route.ts`（新增）；`src/web/{chat-handler,chat-contract,conversation-http}.ts`（修改） | API、DTO、SSE | T11 |
| 新增/修改 | `src/components/skill-panel.tsx`（新增）、`{chat-workspace,chat-composer}.tsx`（修改）及相关测试 | 列表、调用与状态 | T11 |
| 修改 | `src/cli/{commands,session-controller,renderer,run-once}.ts` 及对应测试 | 交互与单次执行 | T10 |
| 新增/修改 | `skills/{commit,review,test}/SKILL.md`（新增）、`next.config.ts`、`README.md`（修改） | 样板、打包与说明 | T12 |
| 新增/修改 | `tests/skills-*.test.ts`、`tests/helpers/skill-fixture.ts`（新增）、`tests/helpers/runtime-fixture.ts`（修改） | 集成、进程与端到端验证 | T9、T13 |

采用小模块；花括号表示具体文件集合，不代表预创建目录或空文件。若实施发现现有公开契约必须作实质变化，先更新受影响文档；简单位置调整可同步修订，不扩大产品范围。

## T1：固定领域契约

- 对应：F1、F4、F5、F11；plan P3、P6、P8。
- 文件：新增 `src/core/skills/types.ts`，修改 `src/tools/types.ts`。
- 依赖：四份文档获批。
- 步骤：定义共享/独立判别联合、历史策略、来源、激活快照、失败码与非递归子事件；增加工具名、调度/预算契约及可选执行事件出口；区分服务端快照与公开摘要。暂不连接 UI 或创建空实现。
- 验证：`npm run typecheck`；检查核心契约无 runtime/React/Next 导入，既有工具仍采用原默认调度/超时。

## T2：实现定义解析、目录发现和参数替换

- 对应：F1、F2、F3、F8；plan P2。
- 文件：新增 `src/runtime/skills/definition.ts`、`catalog.ts` 及对应测试，复用 `src/lib/bounded-files.ts`。
- 依赖：T1。
- 步骤：实现严格 YAML 和字段校验；实现单遍占位符和引号参数解析；发现三层入口、覆盖/重名/无效高层阻断；建立指纹和目录 revision；实施扫描预算与来源错误诊断。目录接口注入根位置和工具元信息，测试不读取真实 home。
- 验证：`npx tsx --test src/runtime/skills/definition.test.ts src/runtime/skills/catalog.test.ts`。覆盖 BOM/CRLF、恶意 YAML、缺参、嵌套占位符、三层覆盖、同层重复、损坏文件、缺目录、符号链接及扫描超限；每个失败检查其他有效 Skill 的行为。

## T3：激活状态保存、停用与恢复

- 对应：F4、F8、F11；plan P3。
- 文件：新增 `src/runtime/skills/service.ts` 及测试；修改清单中会话存储/服务/恢复文件及 `src/core/conversations/validation.test.ts`、`src/lib/local-conversation-store.test.ts`、`src/runtime/conversation-recovery.test.ts`。
- 依赖：T1、T2。
- 步骤：实现幂等激活、替换和停用的原子工作副本；新增可选 skills 状态、严格校验及旧检查点兼容；新增 skill-mutation 锁；清空显式移除 skills；恢复、压缩、重试保存和导出保留有效快照。保存失败不部分更新，跨进程 CAS 冲突不覆盖旧状态。
- 验证：`npx tsx --test src/runtime/skills/service.test.ts src/core/conversations/validation.test.ts src/lib/local-conversation-store.test.ts src/runtime/conversation-recovery.test.ts`。覆盖取消后的已激活状态、无效新激活保持旧值、清空 epoch、旧格式和源文件删除后的恢复。

## T4：建立白名单交集策略

- 对应：F6、F11；plan P4、P8。
- 文件：新增 `src/tools/skill-policy.ts` 及测试；修改 `src/tools/mode-policy.ts`、`types.ts`、`registry.ts` 及相关测试。
- 依赖：T1、T3。
- 步骤：统一 definitions/classify/prepare/executePrepared 的交集判断；处理无激活与空白名单差异；冻结父级上限；加入 load_skill 的唯一白名单豁免；外部工具依据已授权目录和身份校验，待发现工具不能激活。模式策略保持 Plan 对命令/写入/MCP 的限制。
- 验证：`npx tsx --test src/tools/skill-policy.test.ts src/tools/mode-policy.test.ts src/tools/registry.test.ts`。用伪造 prepared 调用验证执行端仍拒绝；验证允许审批不能绕过白名单、空交集及父级限制。

## T5：接入共享加载、动态提示与调度屏障

- 对应：F3、F4、F6、F11；plan P3、P4。
- 文件：新增 `src/tools/load-skill.ts` 及测试；修改 `src/tools/default-registry.ts`、`src/core/agent-loop.ts`、`tool-scheduler.ts`、提示类型与动态上下文；扩展对应测试和 `src/core/system-prompt/system-prompt.test.ts`。
- 依赖：T3、T4。
- 步骤：共享 loader 在所有校验通过后更新状态；每轮模型请求刷新提示和工具 definitions；有/无 ContextManager 两条路径一致；load_skill 作为 barrier，后序调用在屏障后准备，执行前复检；将总 deadline 下传，不让 parent-run 工具套用 10 秒文件时限；容量检查失败不截断正文。
- 验证：`npx tsx --test src/tools/load-skill.test.ts src/core/agent-loop.test.ts src/core/tool-scheduler.test.ts src/core/system-prompt/system-prompt.test.ts`。请求记录证明首次只有目录、同回合下一请求有正文、压缩后保留、多 Skill 共存；构造 load_skill 与被禁止工具同批次，断言没有执行。

## T6：实现目录资源安全读取

- 对应：F9、F8；plan P5。
- 文件：新增 `src/runtime/skills/resources.ts`、`src/tools/read-skill-resource.ts` 及测试；修改注册、路径权限目标识别与 Gateway 对应支持。
- 依赖：T3—T5。
- 步骤：name/path 解析到已激活目录，转成 Workspace path 权限目标；检查真实路径和受保护文件；读取记录 hash 并保存；每轮请求和副作用前校验已引用资源；变更阻断、资源超限报告；脚本不自动执行。
- 验证：`npx tsx --test src/runtime/skills/resources.test.ts src/tools/read-skill-resource.test.ts src/tools/permission-target.test.ts src/tools/permission-gateway.test.ts`。测试工作区内合法资源、用户级外部资源拒绝、symlink/穿越、审批拒绝及审批后变更；检查 load_skill 不能作为任意资源读取后门。

## T7：抽取共用会话装配与历史选择

- 对应：F5、N1、N5；plan P1、P6。
- 文件：新增 `src/runtime/agent-session-factory.ts`，由现有主流程一致性测试及 Skill 集成测试验证、`src/runtime/skills/history.ts` 及测试；修改 `src/runtime/agent-runtime.ts`。
- 依赖：T5、T6。
- 步骤：抽取主/子均需要的 provider/context/tools/AgentLoop 构造，不搬运 UI 或复制循环；主流程行为保持一致；历史按完整用户回合选取并验证工具配对；复制/重写卸载引用到子 ContextStore，明确摘要与不完整历史处理，落实展开预算。
- 验证：`npx tsx --test tests/runtime-parity.e2e.test.ts src/runtime/skills/history.test.ts src/runtime/agent-runtime.test.ts tests/runtime-parity.e2e.test.ts`。覆盖 none/recent/all、压缩历史、父引用不能直接访问、超限拒绝与现有无 Skill 行为。

## T8：实现子执行事件与实时审批通道

- 对应：F5、F7、F11；plan P6、P7。
- 文件：修改 `src/core/agent-events.ts`、`src/core/tool-scheduler.ts`、`src/tools/types.ts`、`src/runtime/{types,run-agent-turn,agent-run-tracker}.ts`、`src/lib/local-agent-run-log.ts`，扩展对应测试。
- 依赖：T5、T7。
- 步骤：定义有子 runId/callId 的 skill-run 包装事件；工具 pending 时通过有界队列转发进度/审批，加入背压及取消唤醒；保存主子关联日志；隔离父 CompletionTracker；不把子事件当作父工具成功证据。
- 验证：`npx tsx --test src/core/tool-scheduler.test.ts src/runtime/run-agent-turn.test.ts src/lib/local-agent-run-log.test.ts`。模拟工具等待审批，先观察 permission-requested 再提交决定并完成；队列满/消费者退出/取消不死锁，清理执行一次。运行日志继续由已有 log 测试及 Skill 集成测试共同验证。

## T9：独立执行闭环

- 对应：F5、F6、F11；plan P6、P8。
- 文件：新增 `src/runtime/skills/isolated-runner.ts` 及测试、`tests/skills-isolated.e2e.test.ts`；接入 `service.ts`、`agent-runtime.ts`、`load-skill.ts`。
- 依赖：T4、T7、T8。
- 步骤：独立 provider/上下文/进程/完成状态，复用父 broker 且不重开父权限回合；主会话冻结推进；继承模式与父权限上限；子迭代/时间/次数受限，拒绝独立递归；确定性摘要保留状态与副作用；失败、超时和取消清理；结果只写当前 epoch/revision，子日志不触发额外记忆任务。
- 验证：`npx tsx --test src/runtime/skills/isolated-runner.test.ts tests/skills-isolated.e2e.test.ts`。使用本地替身测试所有历史/模型选择、实时审批允许与拒绝、子写文件可见、父状态不污染、取消进程、超限、递归拒绝、摘要截断、迟到回传与父验证状态。

## T10：公共命令与 CLI 接入

- 对应：F7、F3、F5；plan P7。
- 文件：新增 `src/runtime/skill-commands.ts` 及测试；修改 `src/cli/{commands,session-controller,renderer,run-once}.ts`；新增 `tests/skills-cli.e2e.test.ts`，扩展命令/渲染测试。
- 依赖：T9。
- 步骤：统一管理与执行命令、引号参数及控制词冲突；显式 Skill 调用确定性预加载；展示目录与活动状态，忙碌状态拒绝变更；转发子审批与取消；JSON/JSONL 严格编码 skill-run 事件，run-once 保持非交互权限语义，管理命令明确拒绝。
- 验证：`npx tsx --test src/runtime/skill-commands.test.ts src/cli/commands.test.ts src/cli/renderer.test.ts tests/skills-cli.e2e.test.ts tests/cli-run-once.e2e.test.ts`。验证调用/刷新/停用/恢复、保留原控制命令、非交互审批没有自动放行。

## T11：Web API、列表和交互

- 对应：F7、F4、F5；plan P7。
- 文件：新增 `src/web/skill-http.ts` 及测试、skills route、`src/components/skill-panel.tsx` 及测试；修改 chat-handler/chat-contract/conversation-http、chat-workspace/chat-composer 及对应测试。
- 依赖：T10（复用公共命令契约）。
- 步骤：后端从会话解析 Workspace，明确 DTO 脱敏；列表和刷新不调用模型；变更做 CAS/busy 检查；输入和面板走同一公共命令；SSE 传递并校验子事件、实时审批；展示运行/更新/错误状态，状态刷新不覆盖会话。
- 验证：`npx tsx --test src/web/skill-http.test.ts src/web/chat-contract.test.ts src/web/chat-handler.test.ts src/components/skill-panel.test.tsx src/components/chat-workspace.test.tsx`；开发服务器下用 agent-browser 验证列表、参数调用、子审批和取消，检查覆盖层/控制台，关闭浏览器和服务器。保存截图仅作未入库证据。

## T12：内置样板、生产资源和用户文档

- 对应：F10、F1、F9；plan P2、P7、P8。
- 文件：新增三个 `skills/*/SKILL.md`、`src/runtime/skills/builtin.test.ts`；修改 `next.config.ts`、`README.md`。
- 依赖：T9—T11。
- 步骤：样板用确定的字段/占位符，commit/test 显式包含 run_command 及 report_completion，review 默认只读；不给模板隐含推送或敏感文件权限；完成配置、调用、历史、刷新和资源限制说明；生产文件追踪包含入口。
- 验证：`npx tsx --test src/runtime/skills/builtin.test.ts`；在临时 Git 仓库验证 commit 只处理显式授权文件且不推送，在临时 npm 项目验证 test 失败及退出码，如实展示 review 结果。最终 build 后使用 start 和不同 cwd CLI 检查内置发现。

## T13：跨入口、跨进程与最终验收

- 对应：AC1—AC15、N1—N6；plan P10、checklist 全部。
- 文件：新增 `tests/helpers/skill-fixture.ts`、`tests/skills-runtime.e2e.test.ts`、`tests/skills-cross-process.e2e.test.ts`、`tests/skills-web.e2e.test.ts`；按需扩展已有 runtime-fixture；更新本目录 checklist.md 实际证据。
- 依赖：T1—T12。
- 步骤：构建隔离用户配置、Workspace、会话和本地模型服务；覆盖 Web/CLI 同输入行为、请求内容和实际文件结果；跨进程恢复/清空/CAS；完成浏览器与 tmux 场景，记录退出状态；检查日志中的凭据哨兵；顺序运行 lint/typecheck/build 并做生产资源冒烟；清理所有本任务进程。
- 验证：`npx tsx --test tests/skills-runtime.e2e.test.ts tests/skills-cross-process.e2e.test.ts tests/skills-web.e2e.test.ts tests/skills-cli.e2e.test.ts tests/skills-isolated.e2e.test.ts`，然后依次 `npm run lint`、`npm run typecheck`、`npm run build`。按 checklist 执行浏览器、tmux 和生产检查，未验证项保持未勾选。

## 执行顺序与文档自检

顺序为 T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12 → T13。每项先完成自身验证，再推进后续；不授权自动提交、推送或创建 PR。

已检查需求与 plan 组件均有归属、无循环依赖、命名一致、每项有可执行验证；实现及相关检查已执行，实际验收证据与未覆盖项见 checklist.md。


## 实施结果与机械性归属调整

T1—T12 的领域契约、定义发现、快照保存、工具交集、动态提示、资源读取、共用装配、子事件/审批、独立执行、双端入口和三个样板均已实现。T13 已执行完整自动化检查与浏览器/tmux 验证；2026-10-17 深度补测补齐剩余条款，当前 checklist.md 为 34/34。历史未覆盖项及失败分别保留。

- `service.ts` 的具体类型名为 `SkillSession`；列表/刷新/停用编排在 `AgentRuntime`。
- `default-registry` 已有扩展工具入口，路径审批/Gateway 已接受动态 path 目标；本轮复用，无需修改它们。
- 会话 exporter、ConversationService/recovery、run-agent-turn 和 Web chat-handler 原有泛型状态/事件转发契约可复用；实际调整位于存储校验、runtime、chat-contract 和 display-timeline，没有复制这些流程。
- UI 只修改 chat-workspace 并新增 skill-panel，无需修改 chat-composer。测试 helper 原有 runtime-fixture 保持复用，另新增 skill-fixture 与独立 CLI helper。
- 新增 `event-queue`、`display-event`、`preload` 小模块承载背压、展示投影和显式调用；不新增另一套 Agent Loop。
- factory 由 runtime-parity 与 Skill 端到端覆盖；tracker 由 local-agent-run-log 与独立执行端到端覆盖，未创建只镜像实现的同名测试。
- 最终自动化命令为 `npm test` 后依次 lint、typecheck、build；详细退出状态、测试数量、浏览器与进程清理记录见 checklist.md。


## 真实模型问题修复（用户授权“开始修复”）

属于 T9/T12/T13 原行为的修复：明确已激活状态；在有界摘要内提供命令调用事实并区别模型陈述；test 样板要求按最新证据说明首次检查和追加复验。保持既有独立递归拒绝、权限、Plan/Do、load_skill 豁免规则和 Agent Loop。

新增 `src/runtime/skills/execution-summary.ts` 及单元测试、`tests/skills-summary.e2e.test.ts`，验证 4 次实际命令结果不会被子文本“三次”覆盖，覆盖显式预加载和模型 load_skill 两条路径。新增 `src/evals/skill-acceptance.ts` 及测试，修复精确资源授权、交集拒绝的判定和 Git porcelain 空格保留，并允许如实报告合理复验。真实模型复测条件、原始失败及完整分布另行保留，不覆盖首次证据。

修复验证：完整测试 554/554，lint/typecheck/build 均通过；真实模型主复测 12/12，最终标签预算补丁后追加 3/3。详细证据和未覆盖边界见 docs/evals/skills-fixes-2026-10-16.md。

## 深度补测与收尾（2026-10-17）

T2/T3/T6/T7/T9/T12/T13 原范围补测新增 27 项测试，最终 581/581。修复成功清空/删除后的待保存状态清理、recent 历史边界提示、资源容量错误分类、生产追踪配置和符号链接 CLI 入口。新增共用 `src/cli/entrypoint.ts`，没有复制主流程或引入依赖。

`verify-skill-terminal.ts` 在真实 tmux 中完成 12 个审批/取消/异常/上限场景；`verify-skill-package.ts` 在仓库祖先目录之外运行纯生产 Web 和编译后 CLI，验证三份内置资源确实来自副本。补齐跨进程 CAS、保存重试、迟到响应、资源审批竞态、MCP 租约和清理故障。最终 lint/typecheck/build 均通过；初次 lint 的临时生成副本污染和其他修复前失败保留在报告中。

本次验收 34/34，仅代表清单定义的有限验证；没有新增真实模型调用。详细结果见 [深度补测报告](../../evals/skills-acceptance-2026-10-17.md)。没有提交、推送或创建 PR。
