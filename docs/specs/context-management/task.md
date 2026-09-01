# 上下文管理 Tasks

状态：已批准
依据：已批准的同目录 `spec.md` 与 `plan.md`

## 文件清单

| 操作 | 文件 | 职责 | 对应需求 |
| --- | --- | --- | --- |
| 新建 | `src/core/context/types.ts`、`context-errors.ts` | 上下文消息、状态、配置、失败、存储端口与事务契约 | F1–F13 |
| 新建 | `src/core/context/message-groups.ts`、测试 | 验证并分组 tool-call/tool-result 协议，选择原子尾部 | F3、F5 |
| 新建 | `src/core/context/token-estimator.ts`、测试 | usage 锚点与字符/字节增量估算 | F1、F4、F12 |
| 新建 | `src/core/context/lightweight-compaction.ts`、测试 | 单结果与工具组稳定卸载 | F2、F3 |
| 新建 | `src/core/context/summary-prompt.ts`、`summary-parser.ts`、测试 | 七节摘要协议、草稿隔离与严格校验 | F6 |
| 新建 | `src/core/context/tool-free-summary-generator.ts`、测试 | 通过通用 Provider 强制无工具摘要 | F7 |
| 新建 | `src/core/context/heavy-compaction.ts`、测试 | 近期尾部、用户原文、摘要/边界与容量判断 | F5、F8 |
| 新建 | `src/core/context/context-manager.ts`、测试 | prepare 顺序、事务、状态机、失败计数与熔断 | F4、F9、F13 |
| 新建 | `src/lib/local-context-store.ts`、测试 | 仓库外私有文件存储、分块读取、清理 | F2、F10、F13 |
| 新建/修改 | `src/tools/read-context.ts`、测试，`types.ts`、`default-registry.ts`、`mode-policy.ts`、`tool-scheduler.ts` | 会话限定的内部只读读取及显式调度边界 | F10 |
| 修改 | `src/models/config.ts`、测试，`orbitcode.example.yaml`、`src/web/server-config.ts` | Provider 上下文配置解析、默认值和关系校验 | F12 |
| 修改 | `src/core/agent-loop.ts`、`agent-events.ts`、测试 | 每次调用前处理、usage 锚点、完整 transcript、提交/回滚、停止原因 | F1–F9、F13 |
| 新建 | `src/web/context-session-manager.ts`、测试，`context-session-store.ts` | 会话绑定、lease、TTL、核心装配与清理 | F9、F13 |
| 新建/修改 | Context Session routes、`src/app/api/chat/route.ts`、Web 合约与测试 | 创建/压缩/关闭 API，聊天请求改为 input + Context Session | F11–F13 |
| 新建/修改 | `context-compression-control.tsx`、聊天 reducer/workspace/CSS 与测试 | 手动压缩入口和状态展示 | F11 |
| 修改/新建 | `README.md`、`tests/web-context-management.e2e.test.ts` | 配置、行为说明和端到端证据 | F1–F13 |

## T1：固定上下文领域契约与配置不变量

- 对应：F1–F13，`plan.md` 的「核心类型与接口」「配置设计」
- 文件：`src/core/context/types.ts`、`src/core/context/context-errors.ts`、对应测试骨架
- 依赖：无

步骤：

1. 定义 `ManagedContextMessage`、`ContextPayload`、`TokenEstimate`、`ContextCompressionState`、`ContextFailure`、`ContextStore`、turn transaction 与压缩报告等判别联合。
2. 固定用户原文不可变、summary/boundary 唯一、tool-call group 合法和 revision/anchor 对应关系的断言函数。
3. 定义上下文配置和纯校验函数，覆盖安全正整数、阈值关系和硬上限。
4. 确保所有对象从会话向外返回时为不可变快照，不泄漏内部可变数组。

验证：

- 运行：`npm run test -- src/core/context/types.test.ts`
- 期望：非法消息状态与非法配置被确定性拒绝，TypeScript 不需要 `any` 或不必要断言。

## T2：实现消息分组与近期尾部选择

- 对应：F3、F5，`plan.md` 的「关键不变量」「近期尾部选择」
- 文件：`src/core/context/message-groups.ts`、`src/core/context/message-groups.test.ts`
- 依赖：T1

步骤：

1. 把普通消息视为单消息组，把 assistant tool-call 及其连续 tool results 视为原子组。
2. 严格检查未知、重复、缺失 `toolCallId` 和被普通消息打断的非法 transcript。
3. 从尾部累计组，先满足最少 5 条原始消息，再接近近期 Token 目标；记录因原子组造成的预算超出。
4. 返回可摘要旧区域、逐字保留的旧用户消息和近期组，不在此层生成摘要。

验证：

- 运行：`npm run test -- src/core/context/message-groups.test.ts`
- 期望：边界组不被拆分，至少 5 条规则、10K 目标、旧用户顺序和非法协议用例通过。

## T3：实现 usage 锚点与增量 Token 估算

- 对应：F1、F4，`plan.md` 的「Token 估算与预算」
- 文件：`src/core/context/token-estimator.ts`、`src/core/context/token-estimator.test.ts`
- 依赖：T1

步骤：

1. 实现全量字符/UTF-8 字节近似和消息、系统提示、工具定义的规范估算输入。
2. 保存普通 Agent prompt usage 的 revision/字节基线；对新增、删除和替换账本计算有符号 delta。
3. 明确区分 `usage-anchor` 与 `approximation`；usage 缺失、revision 不可追溯或配置变化时安全退化为全量估算。
4. 保证摘要调用 usage 不进入普通 Agent 锚点 API。

验证：

- 运行：`npm run test -- src/core/context/token-estimator.test.ts`
- 期望：锚点增量、删除后下降、配置变化退化、usage 缺失和 Unicode 输入均符合预期。

## T4：实现本地 Context Store

- 对应：F2、F10、F13，`plan.md` 的「本地存储」「安全与权限边界」
- 文件：`src/lib/local-context-store.ts`、`src/lib/local-context-store.test.ts`
- 依赖：T1

步骤：

1. 使用 Node 标准库在 `os.homedir()/.orbitcode/context-v1` 创建仅当前用户可访问的根目录、随机会话目录和仅当前用户可读写的对象文件，写入采用同目录临时文件与原子 rename。
2. 生成不含真实路径的版本化 opaque reference，并在读取时验证格式、会话归属、realpath、普通文件与非符号链接。
3. 实现有界 offset/limit UTF-8 分块读取，返回总长度、实际范围和 `hasMore`。
4. 实现关闭时删除会话目录、创建会话时清理超 TTL 孤儿目录；底层错误转换为安全错误。

验证：

- 运行：`npm run test -- src/lib/local-context-store.test.ts`
- 期望：原子写读、Unicode 分块、并发文件、跨会话、伪造引用、`..`、绝对路径、符号链接、过期和清理用例通过；测试只使用临时目录。

## T5：实现轻量预防层

- 对应：F2、F3，`plan.md` 的「轻量压缩」
- 文件：`src/core/context/lightweight-compaction.ts`、`src/core/context/lightweight-compaction.test.ts`
- 依赖：T1、T2、T3、T4 的 `ContextStore` 契约

步骤：

1. 规范序列化工具结果并计算单项估算；超过阈值时先持久化、后替换 payload。
2. 对每个工具组汇总仍内联结果，按估算体积降序和原序号稳定处理至预算内。
3. 生成有界头尾预览、原始体积、opaque reference 和读取提示；幂等跳过已卸载项。
4. 对存储失败保持候选历史未提交，并返回结构化 failure；验证用户消息和工具协议不变。

验证：

- 运行：`npm run test -- src/core/context/lightweight-compaction.test.ts`
- 期望：单项阈值、批次阈值、稳定排序、阈值相等、写入失败原子性、用户原文和配对测试通过。

## T6：实现严格摘要协议与核心无工具生成器

- 对应：F6、F7，`plan.md` 的「摘要请求与解析」
- 文件：`summary-prompt.ts`、`summary-parser.ts`、`tool-free-summary-generator.ts` 及对应测试
- 依赖：T1

步骤：

1. 构造固定 Prompt，明确两阶段输出、七节正式摘要、事实不确定性和不得猜测文件内容。
2. 严格解析单个 JSON envelope，拒绝 markdown fence、未知/缺失字段、超长草稿/条目、非字符串数组和尾随内容。
3. 核心生成器直接调用 `ChatProvider.stream`，不传 tools 且固定 `toolChoice: "none"`；只接受单次 usage、文本和 `stop`。
4. 解析成功后只返回正式 `ContextSummary`，让 `analysisDraft` 在函数返回前失去引用。

验证：

- 运行：`npm run test -- src/core/context/summary-parser.test.ts src/core/context/tool-free-summary-generator.test.ts`
- 期望：替身 Provider 捕获到强制无工具选项；工具事件、协议错误和非法 JSON 均失败且没有草稿泄漏。

## T7：实现重量压缩候选与边界消息

- 对应：F4、F5、F8，`plan.md` 的「重量压缩与摘要协议」
- 文件：`src/core/context/heavy-compaction.ts`、`src/core/context/heavy-compaction.test.ts`
- 依赖：T2、T3、T6

步骤：

1. 使用消息分组结果构造摘要输入，分别应用自动 13K 和手动 3K 安全余量。
2. 保留所有旧用户原文和近期原始组，只用正式摘要替换旧非用户内容；合并旧摘要并移除旧边界。
3. 插入唯一固定 system boundary，说明必须重新读取代码与 context reference。
4. 比较候选前后估算；无可压缩内容、无净收益或仍超过预算时返回 capacity，历史不变。

验证：

- 运行：`npm run test -- src/core/context/heavy-compaction.test.ts`
- 期望：至少 5 条、工具组原子性、用户逐字、七节摘要、唯一边界、旧摘要合并、自动/手动余量和无收益场景通过。

## T8：实现 Context Manager 状态机、事务与熔断

- 对应：F4、F9、F13，`plan.md` 的「状态与交互」
- 文件：`src/core/context/context-manager.ts`、`src/core/context/context-manager.test.ts`
- 依赖：T3、T5、T7

步骤：

1. 实现每次模型调用前的固定 light → estimate → optional heavy 顺序，并阻止同一调用点摘要重试。
2. 实现 Agent turn transaction：成功提交内部 transcript、自动压缩结果与新 usage 锚点；其他停止恢复轮次开始时的历史/锚点，并清理本轮未提交引用。摘要失败计数保持为会话级控制状态，手动成功压缩直接提交。
3. 实现连续摘要失败计数、第三次熔断、自动禁试、手动单次恢复和成功归零。
4. 实现 AbortSignal 和互斥状态；所有异常路径最终回到可解释状态。

验证：

- 运行：`npm run test -- src/core/context/context-manager.test.ts`
- 期望：顺序、单次尝试、1/2/3 次失败、熔断自动零调用、手动恢复、取消、存储失败和事务回滚全部通过。

## T9：增加 `read_context` 会话能力

- 对应：F10，`plan.md` 的「read_context 工具」
- 文件：`src/tools/read-context.ts`、`read-context.test.ts`、`types.ts`、`default-registry.ts`、`mode-policy.ts`、`tool-scheduler.ts` 及相关权限回归测试
- 依赖：T4

步骤：

1. 定义有界 `{ reference, offset, limit }` schema 和 `context-reference` 错误；工具由当前会话 reader 工厂创建。
2. 在 ToolAccess/调度中显式区分内部会话只读能力与 Workspace 工具：前者仅通过 capability validator，后者仍完整经过现有 PermissionGateway。
3. Plan 与 Do 都公开 `read_context`；伪造、跨会话、过期或路径输入由工具返回结构化失败。
4. 运行现有权限、Plan/Do 和工具调度测试，证明规则优先级与审批行为未变化。

验证：

- 运行：`npm run test -- src/tools/read-context.test.ts src/tools/mode-policy.test.ts src/core/tool-scheduler.test.ts src/tools/permission-gateway.test.ts`
- 期望：合法分块读取成功，非法引用安全失败；所有既有权限测试保持通过。

## T10：扩展 Provider 配置与示例

- 对应：F12，`plan.md` 的「配置设计」
- 文件：`src/models/config.ts`、`src/models/config.test.ts`、`src/web/server-config.ts`、`src/web/server-config.test.ts`、`orbitcode.example.yaml`
- 依赖：T1

步骤：

1. 在每个 Provider 严格解析必填 `context.window_tokens` 和可选策略阈值，拒绝未知字段。
2. 应用模型无关默认策略并运行 T1 的关系校验；错误不包含 API Key 或环境值。
3. 将解析后的配置传给 Context Session 创建流程；Provider 摘要 API 不向浏览器暴露敏感配置，可按需只展示窗口大小。
4. 更新示例 YAML，提供 128K 仅作为示例值并提醒按实际模型填写。

验证：

- 运行：`npm run test -- src/models/config.test.ts src/web/server-config.test.ts`
- 期望：多 Provider 不同窗口、默认阈值、未知字段、缺失 window、关系倒置和极端值测试通过。

## T11：把 Context Manager 接入 Agent Loop

- 对应：F1–F9、F13，`plan.md` 的「Agent Loop 集成」
- 文件：`src/core/agent-loop.ts`、`src/core/agent-loop.test.ts`、`src/core/agent-events.ts`
- 依赖：T8、T9

步骤：

1. 让 Agent Loop 从 Context turn transaction 取得模型 transcript，并在每次普通 Provider 调用前执行 prepare。
2. 把 assistant tool-call 与有序 tool results 追加到工作 transcript，保留完整调用供模型继续；最终回复成功后提交整个轮次。
3. 普通 Agent usage 回写 estimator；摘要 usage 不混入现有 token-usage 累计事件。
4. 新增安全的上下文停止原因/事件详情，保持 `stopped` 唯一终止；失败、取消、最大迭代和未知工具路径按事务规则处理。
5. 保持现有权限 gateway 注入和调用顺序，避免覆盖当前未提交权限改动。

验证：

- 运行：`npm run test -- src/core/agent-loop.test.ts src/core/tool-scheduler.test.ts`
- 期望：每次模型调用前顺序、跨迭代 transcript、成功提交、各停止回滚、自动压缩与熔断停止均通过，权限用例不回归。

## T12：实现 Context Session Manager 与本地生命周期

- 对应：F9、F13，`plan.md` 的「Web Context Session 与 API」
- 文件：`src/web/context-session-manager.ts`、`context-session-manager.test.ts`、`context-session-store.ts`
- 依赖：T4、T8、T10

步骤：

1. 实现随机 session ID、创建时指定并固定的 Workspace/Provider 绑定、Agent/manual 互斥 lease、快照、关闭和空闲 TTL。
2. 创建 session 时装配 Context Manager、Store namespace 和摘要 Provider；不得把 API Key保存进快照或日志。
3. 关闭/过期时取消活动操作并尽力删除本地文件；删除失败不复活会话，由后续孤儿清理处理。
4. 设计 lease 获取/释放幂等路径，供 Chat Route 与 Permission turn 协调失败回滚。

验证：

- 运行：`npm run test -- src/web/context-session-manager.test.ts`
- 期望：绑定、错绑、并发、TTL、取消、关闭、清理失败和快照脱敏测试通过。

## T13：扩展 Web 合约与 Route Handlers

- 对应：F11–F13，`plan.md` 的「Web Context Session 与 API」
- 文件：`src/web/chat-contract.ts`、`chat-contract.test.ts`、`src/web/chat-handler.ts`、相关测试、`src/app/api/chat/route.ts`、`src/app/api/context-sessions/**/route.ts`
- 依赖：T11、T12

步骤：

1. 把聊天请求改为 Provider、Workspace、权限会话 ID、上下文会话 ID、模式信息和单条非空 input；服务端不再接受浏览器提供的完整模型历史。
2. 增加按选定 Workspace/Provider 创建、查看和关闭 Context Session，以及手动压缩的严格请求/响应解析；返回 before/after、状态、失败种类和安全消息。
3. Chat Route 依次验证 Origin/大小/配置/Workspace/双会话绑定并获取 lease；任一后续步骤失败时释放已取得的 lease。
4. 把自动压缩状态和上下文停止原因加入 SSE 严格解析；保证停止事件仍唯一。
5. 覆盖 body 上限、exact fields、非法 ID、跨绑定、并发、会话失效和关闭清理。

验证：

- 运行：`npm run test -- src/web/chat-contract.test.ts src/web/chat-handler.test.ts src/web/context-session-manager.test.ts src/web/permission-routes.test.ts`
- 期望：新合约完整往返，非法输入拒绝，权限 Route 回归通过，所有 lease 在成功/错误/取消时释放。

## T14：接入 Web 手动压缩 UI

- 对应：F11、F13，`plan.md` 的「React 状态与展示」
- 文件：`src/components/context-compression-control.tsx`、`chat-session-state.ts`、`chat-session-state.test.ts`、`chat-workspace.tsx`、`chat-workspace.test.tsx`、`src/app/globals.css`
- 依赖：T13

步骤：

1. 页面可先创建权限会话；Provider/Workspace Catalog 就绪并完成选择后，再按该绑定创建独立 Context Session。聊天请求发送当前 input，不再发送 `session.history` 作为模型事实。
2. reducer 增加压缩判别状态、before/after 和安全失败；手动按钮只在双会话 ready 且 Agent/压缩均空闲时启用。
3. 成功显示前后估算及来源，失败显示原因，熔断状态提供手动恢复按钮；不得展示绝对存储路径或完整正文。
4. 清空、切换 Provider/Workspace、卸载和会话失效时取消活动请求并关闭/重建两个会话；保留现有权限审批卡交互。
5. 添加可访问名称、`aria-live` 状态和移动端布局。

验证：

- 运行：`npm run test -- src/components/chat-session-state.test.ts src/components/chat-workspace.test.tsx`
- 期望：按钮禁用矩阵、状态转换、前后 Token、失败、熔断恢复、重置和权限等待交互测试通过。

## T15：文档、浏览器与端到端闭环

- 对应：F1–F13，`plan.md` 的「验证策略」
- 文件：`README.md`、`tests/web-context-management.e2e.test.ts`
- 依赖：T10–T14

步骤：

1. 更新 README：配置字段、两层策略、usage 锚点、用户原文、Context Session 生命周期、`read_context`、熔断和手动操作。
2. 使用本地 OpenAI 兼容替身构造可控 usage、摘要 JSON、工具调用和失败序列；不使用真实密钥。
3. 端到端覆盖大结果卸载并重读、自动重量压缩、手动压缩、三次失败熔断、成功恢复、失败轮次不提交和 Workspace/Provider 隔离。
4. 启动 dev server，使用 `agent-browser` 检查真实页面、错误覆盖层和控制台；结束后关闭浏览器与服务器。
5. 在 tmux 运行 Web Agent 完整闭环与异常路径，并记录不含凭据的实际证据。

验证：

- 运行：`npm run test -- tests/web-context-management.e2e.test.ts`
- 运行：`npm run lint`
- 运行：`npm run typecheck`
- 运行：`npm run build`
- 期望：所有命令退出码 0，浏览器无错误覆盖层/控制台错误，tmux 场景符合 checklist。

## 执行顺序

```text
T1 → T2 → T3 ───────────────┐
 │         ├→ T5            │
 ├→ T4 ────┘                ├→ T8 → T11 ─┐
 ├→ T6 → T7 ────────────────┘            │
 └→ T10 ───────────────────────→ T12 ────┼→ T13 → T14 → T15
          T4 → T9 ────────────────────────┘
```

T4、T6、T10 可在 T1 后并行；权限系统现已合入当前基线，T9、T11、T13、T14 实现时仍应先复核相关接口，并以小范围补丁接入，不改变既有权限语义。

## 草案自检

- `plan.md` 的核心、存储、工具、Provider 配置、Agent、Web 会话、Route、UI 和验证组件均有任务负责。
- 每项任务包含文件、依赖、步骤与可执行验证，不把测试笼统堆到末尾。
- 任务依赖无环，先领域契约与纯核心，再实现适配，最后接入 Web。
- 未包含提交、推送、PR、部署或任何实现代码。
