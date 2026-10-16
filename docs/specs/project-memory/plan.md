# 项目指令、会话接续与长期记忆 Plan

状态：已批准
依据：已批准的同目录 `spec.md`。

## 架构概览

Web 与 CLI 只负责展示、输入和管理操作确认。`src/runtime/` 加载指令、准备背景快照、安排记忆任务和清理会话；`src/core/system-prompt/` 负责来源、优先级与背景标识；现有 AgentLoop、ContextManager、PermissionGateway 与 LocalConversationStore 继续负责运行、预算、权限和会话一致性。

依赖方向为入口 → runtime → core/models/tools 与存储基础设施。核心只接收已经校验的文本、标识与读取接口，不读取用户目录，也不依赖 runtime 或 React。记忆提取是无工具的一次模型调用，不启动第二套 Agent Loop。

## 需求映射

| 需求 | 负责模块/交互 | 设计 |
| --- | --- | --- |
| F1 | instruction-loader、background-service、AgentRuntime | 每轮加载三来源，失败关闭执行 |
| F2 | instruction-loader、bounded-files | 相对引用、边界校验、visited 与限额 |
| F3 | system-prompt、现有权限网关 | 显式优先级，不授予权限 |
| F4 | conversation-recovery、现有恢复存储 | 检查工具配对，显式恢复，不重放 |
| F5 | background-service、ContextManager | 轮次时间提醒，现有预算与压缩 |
| F6 | run-agent-turn、ConversationService、memory-service | 正常回复且保存成功的统一提交钩子 |
| F7 | memory-jobs、memory-extractor | 有界异步任务与取消 |
| F8 | memory-validation、memory-extractor | 四分类、作用域与证据校验 |
| F9 | memory-store、memory-index | Markdown 笔记、原子代际提交、索引上限 |
| F10 | memory-validation、memory-store | 去重、并发版本保护、来源及冲突检查 |
| F11 | background-service、read-memory、system-prompt | 作用域索引与不透明只读引用 |
| F12 | memory-service、background-http、Web 面板、CLI 命令 | 检查状态、开关、编辑与删除 |
| F13 | conversation-cleanup、两端入口 | 30 天只读预览 |
| F14 | conversation-cleanup、ConversationService、操作守卫 | 逐条复检和显式删除 |

## 核心类型与接口

以下是待实现契约，不是现有 API；结果分支必须穷尽处理，不使用 `any`。

```ts
type InstructionSource = 'user' | 'project-agents' | 'project-instructions';
type NoteCategory = 'preference' | 'correction' | 'project-knowledge' | 'reference';
type MemoryScope =
  | { readonly kind: 'user'; readonly configurationId: string }
  | { readonly kind: 'project'; readonly workspaceRootIdentity: string };
type NoteEvidence =
  | { readonly kind: 'user-stated'; readonly messageId: string }
  | { readonly kind: 'tool-observed'; readonly callId: string }
  | { readonly kind: 'reference-only'; readonly source: string };
type SavedTurnIdentity = {
  readonly conversationId: string;
  readonly turnId: string;
  readonly savedRevision: number;
  readonly lifecycleEpoch: string;
};
type BackgroundResult =
  | { readonly status: 'ready'; readonly snapshot: BackgroundSnapshot }
  | { readonly status: 'blocked'; readonly source: InstructionSource; readonly reason: string };
type MemoryJobState =
  | { readonly status: 'queued' | 'running'; readonly source: SavedTurnIdentity }
  | { readonly status: 'saved'; readonly source: SavedTurnIdentity; readonly noteIds: readonly string[] }
  | { readonly status: 'skipped' | 'failed' | 'abandoned'; readonly source: SavedTurnIdentity; readonly reason: string };
type MemoryWriteResult =
  | { readonly status: 'saved'; readonly revision: string; readonly noteIds: readonly string[] }
  | { readonly status: 'rejected'; readonly reason: 'invalid' | 'capacity' | 'conflict' | 'disabled' | 'source-retired' };
type CleanupResult =
  | { readonly id: string; readonly status: 'deleted' }
  | { readonly id: string; readonly status: 'skipped' | 'failed'; readonly reason: string };
```

`BackgroundSnapshot` 包含已展开的分来源指令、有效索引、不透明引用映射、可选时间提醒及安全诊断。`MemoryCandidate` 包含类别、声明作用域、标题、描述、正文和证据引用；来源轮次由宿主填入，候选不能提供实际路径。证据引用必须在已保存输入集合中存在；结构校验无法证明任意自然语言为真，工具观察仅标为观察，不升级为任务验收。

主要服务接口：

- `InstructionLoader.load({ workspaceRoot, userConfigRoot, signal }) → BackgroundResult` 中的指令部分。
- `BackgroundService.prepare({ checkpoint, workspaceRoot, userConfigRoot, now, signal }) → BackgroundResult`，一次准备一轮的稳定快照。
- `MemoryService.scheduleSavedTurn(identity, inputSnapshot, provider)`：同步登记后返回，不等待模型；`inspect`、`setEnabled`、`updateNote(expectedRevision)`、`deleteNote(expectedRevision)` 为管理入口。
- `MemoryStore.commit({ scope, expectedRevision, candidates, source }) → MemoryWriteResult`：仅接受宿主校验后的候选；独立作用域分别提交并报告，用户/项目两级不宣称跨目录事务。
- `MemoryReader.read({ reference, offset, limit, signal })`：只接受本轮快照签发的引用，返回分块正文或结构化失败。
- `ConversationCleanup.preview(now)` 与 `execute({ candidates: [{ id, expectedRevision }], now })`：后者逐条重新获取操作守卫并校验。

## 状态与交互

### P1：指令加载与一轮背景

1. 解析现有配置与绑定的 Workspace，使用统一的用户配置根：默认 `~/.orbitcode`，隔离运行使用显式 data-dir；Web 沿用 `ORBITCODE_DATA_DIR`。
2. 加载用户 instructions、根 AGENTS、项目 instructions，记录来源。读取每个根文件前确认真实边界；引用路径以当前文件所在目录为基准。
3. `@include <相对路径>` 要求独立行、尖括号内非空；支持路径中的空格，不支持 glob、环境变量或转义展开。以规范真实路径 visited 去重，重复/循环跳过并诊断；不同根文件分别维护 visited。深度检查先于展开。
4. 使用受限文件读写基础设施：真实路径检查、普通文件检查、打开后身份复核、有界读取；拒绝符号链接逃逸，目录/文件身份变化时失败。不能只使用字符串前缀判断路径包含关系。
5. 生成来源分段快照。文件缺失仅根文件允许；引用缺失或非法内容阻止本轮，错误在初始化阶段展示，不启动模型或 MCP 连接。
6. 加载记忆索引，损坏时安全告警降级。每轮固定快照，轮内每个 Agent 请求都包含该快照；人工变更及后台新笔记从下一轮生效，避免轮内行为漂移。
7. 核心组装明确“系统安全与真实权限 > 当前用户明确要求 > 项目 instructions > AGENTS > 用户 instructions；记忆只作背景”。保留已有固定提示和模式提示；新增具名背景字段，不用字符串伪造角色。

当前 optional context 每项 20,000 字符、总计 40,000 字符，不能直接容纳两级合法索引。新增受控的 `projectInstructions`、`memoryIndex`、`resumeReminder` 字段及各自预算，既有 activatedSkills 上限保留。索引两级合计最多 50,000 字节，全部提示仍参与现有 Token 估算和压缩；容量不足按现有错误停止，不扩大模型窗口或默默截断规则。记忆承载块清楚注明它是不可信背景，不能覆盖任何指令；角色标签本身不被视为安全保证。

### P2：恢复与保存元信息

在检查点增加向后兼容的可选 `lastTurn` 元信息（turnId、endedAt、stopReason、memoryEligibility）和 `lifecycleEpoch`。保持 schemaVersion 1，扩展严格验证与序列化；旧记录无元信息时不补提取，提醒时间显示未知。新建或首次写入旧记录时生成 epoch；清空更新 epoch，删除使来源失效。重命名、压缩和模式操作保留 lastTurn，不改变时间提醒依据。

运行前在已有写租约内校验修订与工具配对；有中断标记仍要求显式 recover。恢复逻辑扩展当前检查点修复：对可识别、唯一的缺结果调用补结构化 cancelled/unknown 结果，sideEffect 为 possible，并保留 callId；重复 callId、孤立结果或其他歧义视为损坏，不猜测配对。将修复作为一次有 revision 保护的保存。缺少结果的检查点能被安全读取和诊断，但不能直接送模型。未落盘的真实工具执行仍无法重建。

提醒只进入动态背景，不追加持久化 transcript。间隔至少 24 小时则在整个接续轮次保持一份提醒，成功保存后更新 lastTurn；保存失败不伪造新时间。当前时间由可注入时钟生成；非法或未来的结束时间视为不可用，显示时间未知且不生成负间隔提醒。组合背景后沿用 ContextManager.prepareForModel，工具调用和结果按既有消息组压缩，不丢弃未修复调用。

### P3：正常保存后的任务提交

`runAgentTurn` 最终已知 stopped 和 persistence，新增 `onPersistedTurn` 钩子，仅在 `reason === final-response`、存在完整最终文本、无未完成调用且保存成功时触发。资格记录与 turnId 在原始保存时一起落盘；保存重试路径使用同一元信息调用 MemoryService，不能根据 lastStopReason 或旧 displayMessages 猜资格。当前进程保留原轮次的模型配置快照；retry-save 不重新选择已变更的模型。

钩子只安排后台工作，失败变成安全诊断；不把已经保存的对话变为失败。完成资源清理并释放会话租约后开始提取。后台持有该轮解析完成的 Provider 快照，仅内存持有凭据，不写入任务记录。复用 ChatProvider.stream，tools 为空、toolChoice 为 none；出现工具调用、非 stop 结束、非法 JSON 或超限响应均失败。

提取输入由本轮已保存用户内容及必要的新工具证据组成；助手自述和 read_memory 返回的旧笔记不作为新事实来源，不包含完整历史、环境或原始配置。纯旧记忆查询且无新增记忆要求时直接返回空候选，不调用提取模型。按限额筛选并保留证据标识，被省略证据不能被候选引用；先过滤已知凭据和明显密钥模式，输出再次校验。类型与来源校验不能替代事实验证，未经支持的“代码已实现/验收通过”候选拒绝。合法数组中的候选逐条严格校验，非法项单独拒绝；若有有效候选则继续作用域提交，任务显式显示未收录数量；全非法仍失败，不自动重试。

同一进程提取并发 1、队列最多 8、单任务 30 秒、不自动重试；网络或协议失败记状态，后续正常轮次可提取新事实。关闭 CLI/单次运行退出时取消未完成后台任务，不为提取阻塞退出；标记 abandoned。重启不重放队列。

### P4：存储、幂等与人工编辑

存储位置：用户 `<userConfigRoot>/memory-v1/`，项目 `<workspaceRoot>/.orbitcode/memory-v1/`。设置与来源任务账本位于 `<userConfigRoot>/memory-state-v1/`，不混入会话正文；项目状态位于项目记忆根以支持多进程去重。原始模型输入输出不落盘，只保留来源、状态、原因和笔记标识。

每个作用域采用版本化提交：`HEAD.json` 指向一个完整 generation；generation 包含 `index.md`、`notes/<id>.md` 与清单（修订、内容 hash、来源去重标识、删除墓碑）。frontmatter 用现有 yaml 库解析，禁止 alias、重复键、未知字段和非标量嵌套的非约定数据。正文按 UTF-8 有界解析，拒绝 NUL。ID 和实际路径由宿主生成。

写入在作用域独占锁内读取最新 HEAD、校验 expectedRevision 与文件 hash，写新 generation 并 fsync，再原子切换 HEAD；失败时旧代仍有效，临时未提交代不会用于加载。不同进程共享作用域锁，锁包含持有者与失效检测；超时失败，不按时间盲抢活跃锁。实现复用/提炼现有本地存储原子写与租约实践，不复制会话业务。

纠正默认可新建独立记录；选择替代时只能引用本轮提供的同项目目标。提取前记录目标 hash，提交时再次比对；模型等待期间被人工改过的目标拒绝覆盖。偏好问句不能当作新偏好声明。模型合并永远写新版本，不能原地覆盖旧 Markdown。更新前检测人工变更，冲突保留旧文件并拒绝该候选，不自动重试覆盖；提交后发现人工编辑与旧代分叉时标记冲突并保留两份供用户决定。任意外部编辑器不遵守应用锁，因此不能承诺与外部写入的严格线性一致；自动流程不删除旧代，保证原始人工内容可找回。管理入口通过 expectedRevision 更新和删除可提供受控一致性。

用户可通过两端管理入口读取/更新 Markdown；也可编辑当前代文件，下一轮读取时重新校验 hash、结构及索引并在锁内登记人工变更。删除正文或入口删除都产生墓碑，去重来源状态保留。索引损坏不自动信任手写链接；有效条目必须匹配清单和有效笔记。用户修复/管理入口重建后才重新注入。

默认确定性去重为规范化类别、作用域和正文 hash；同一 turnId 的来源账本避免重复提交。提取模型可提出既有 noteId 合并，服务验证属于当前作用域且 expectedRevision 一致；不额外调用第二次去重模型。矛盾且没有用户明确纠正的候选标记 conflict，不静默覆盖。索引容量不足时该候选不提交，账本记录未收录。无容量驱逐、无后台旧代删除。

关闭开关、清空/删除来源及笔记提交共享一个短期来源提交守卫：关闭/清空先取消任务并持久化禁写状态，再进行操作；提交锁顺序固定为来源会话守卫 → 用户记忆状态锁 → 目标作用域锁，在这些锁内重新检查开关、epoch、来源存活与去重状态。模型请求不持锁，清理不反向获取作用域锁。前台轮次遇到 memory-commit 短暂占用时最多等待 2 秒；空候选无需申请来源提交守卫。清空/删除失败可保留取消状态，不能复活任务。设置关闭请求成功返回之后不得再有被关闭任务提交。

一个轮次最多一个提取任务；任务安排标识持久化后即不因刷新/恢复重新调度。崩溃后 running/queued 可显示 abandoned，提交成功但状态未更新时通过来源清单对账，不再写相同笔记。账本仅保证幂等和诊断，不是重试队列。来源会话被删除不删除已经提交的长期记忆。

### P5：受控正文读取与两端管理

仅在本轮签发了有效索引时注册 `read_memory` 只读工具，接收 `memory://<本轮随机引用>`、offset、limit，不接受文件路径。工具通过现有 context 类只读权限目标进入 PermissionGateway（现有 context 目标不使用文件路径规则），扩展引用验证器而不放宽 read_context 的 context:// 校验。Plan/Do 均可用；注册表、工具名称联合与 Web 协议解析同时更新。

引用绑定 configuration、Workspace、conversation、turn、noteId、内容 hash；读取时再次确认属于当前快照、未删除且正文 hash 一致，变化返回 reference-expired 等安全错误而不读取任意新路径。分页最多 8,000 字符，每笔记最多 16,000 字节；工具结果照常进入上下文预算与压缩。不增加通用用户目录文件权限。

Web 在会话背景面板提供来源、诊断、笔记列表/正文、编辑/删除及开关，后台状态按用户打开面板时查询刷新；不为了状态重开 Agent SSE。管理 API 采用现有本地请求保护，Workspace 由受信配置或会话绑定解析，不能提交绝对路径。笔记更新要求 expectedRevision，失败保留用户输入。

CLI 增加 `/background`、`/memory list`、`/memory show <id>`、`/memory update <id> <file>`、`/memory delete <id>`、`/memory on|off`。update 读取用户显式指定的本地 Markdown 并通过同一校验服务提交；提供 scope 选择，默认当前项目。运行中不接受改变当前快照的操作；下一轮反映修改。

### P6：过期会话清理

预览服务使用现有会话列表与 guard.inspect，按 updatedAt 与当前时钟计算至少 30 × 24 小时；invalid/future/active/interrupted/pending-save 单独显示原因。预览不写会话、不生成模型请求。

执行请求携带用户选择的 id 与 expectedRevision。逐条获取现有操作守卫，在锁内再读 updatedAt、revision、活动标记和待保存状态；符合条件才调用现有删除。避免在已经持锁时递归调用再次申请锁的服务方法：给 ConversationService 增加持守卫的内部删除路径，统一清理与普通删除的来源任务失效处理。活动与待恢复状态必须在申请守卫前及取得守卫后分别按可观察状态复核。

Web 预览表中选中后明确点击删除；CLI `/cleanup preview` 输出候选，`/cleanup delete <id...>` 展示待删除集合并要求终端确认；两端执行均禁止隐式“全部”。单次最多 100 条，逐条结果返回；取消后不继续下一条，已删条目不伪称回滚。

## 资源与失败边界

| 项目 | 限额/行为 |
| --- | --- |
| include | 深度 5；每根最多 32 个唯一文件；每文件 16,000 字节；三来源累计展开文本最多 48,000 字节 |
| 指令加载 | 总计 5 秒，支持取消；任何超限阻止该轮 |
| 每级索引 | 200 行且 25,000 字节；按逻辑行计数，末尾换行不额外生成空行 |
| 笔记 | 正文含 frontmatter 最多 16,000 字节；标题 120 字符、描述 160 字符；每次最多 8 候选 |
| 模型提取 | 输入最多 32,000 字符且不超过配置窗口可用预算；输出最多 16,000 字符；30 秒；0 自动重试 |
| 前后台预算 | 各自估算；提取输入无法容纳时 skipped，不消耗前台上下文 |
| 锁 | 最多等待 2 秒；忙则 conflict，不长期阻塞前台 |
| 后台状态 | 保存有界安全原因，不保存原始错误响应或密钥；管理入口按当前来源查看最多 100 条；运行层提供有界 offset 读取 |
| 加载错误 | 指令 blocked；记忆 degraded；恢复损坏 blocked；清理逐条 failed/skipped |

无索引的首次启动为空；缺失配置开关按默认启用处理。现有提示标签转义继续保留，但权限、路径和存储校验必须独立成立。已知凭据过滤使用当前解析凭据集合及现有脱敏基础设施，测试只用虚构哨兵，不声称通用隐私识别。

## 文件组织与职责

新增：

- `src/runtime/background-types.ts`、`instruction-loader.ts`、`background-service.ts`：背景领域契约、指令加载与快照。
- `src/runtime/conversation-recovery.ts`：配对检查和纯恢复判定，存储仍由现有会话仓库执行。
- `src/runtime/memory-types.ts`、`memory-validation.ts`、`memory-index.ts`：笔记与任务类型、严格校验、索引生成。
- `src/runtime/memory-store.ts`、`memory-service.ts`、`memory-jobs.ts`、`memory-extractor.ts`：作用域提交、管理、任务与模型提取。
- `src/runtime/conversation-cleanup.ts`：清理预览、执行条件及报告。
- `src/lib/bounded-files.ts`：有界且复检身份的本地文件操作基础设施。
- `src/lib/local-file-lock.ts`：提炼现有设置锁的所有者、失效检测与释放机制；`settings-lock.ts` 保留设置领域错误映射。
- `src/tools/read-memory.ts`：注入的引用读取接口适配工具。
- `src/web/background-http.ts`、`src/web/conversation-cleanup-http.ts`：HTTP 契约与请求保护。
- `src/app/api/conversations/[conversationId]/background/route.ts`、`src/app/api/memory/route.ts`、`src/app/api/conversations/cleanup/route.ts`：薄入口。
- `src/components/conversation-background-panel.tsx`、`src/components/conversation-cleanup-panel.tsx`：展示与用户操作。
- 相应同名 `.test.ts` / `.test.tsx`；端到端模型替身位于 `scripts/fixtures/project-memory-provider.ts`，隔离目录与历史构造由同目录 `project-memory-sandbox.ts`、`project-memory-history.ts` 提供。

修改：

- runtime 的 `agent-runtime.ts`、`run-agent-turn.ts`、`conversation-service.ts`、`conversation-runtime-manager.ts`、`types.ts`：注入背景、保存钩子、guard 操作与诊断。
- core 的 `conversations/types.ts`、`conversations/validation.ts`、`system-prompt/types.ts`、`system-prompt/dynamic-context.ts`、`system-prompt/assemble.ts`、`system-prompt/system-constraints.ts`：兼容元信息及提示契约。
- `src/lib/local-conversation-store.ts`：恢复修复与元信息保存；相应存储测试。
- `src/tools/types.ts`、`default-registry.ts`、`permission-target.ts`、`mode-policy.ts`：工具类型、注册、引用与模式接入；如 context 引用现有实现可直接适配，则不扩大权限类型。
- `src/web/agent-runtime.ts`、`storage-paths.ts`、`chat-contract.ts` 及 `src/cli/main.ts`、`run-once.ts`、`session-controller.ts`、`commands.ts`、`renderer.ts`：共用服务注入与协议兼容。
- `src/components/chat-workspace.tsx`、`conversation-list.tsx`：面板入口；`README.md`：公开行为与限制。

## 技术决策

| 决策 | 选择 | 原因与替代方案 |
| --- | --- | --- |
| 背景刷新 | 每轮快照、每次请求携带 | 避免轮内不一致；不采用每次迭代重新读磁盘 |
| 相关性 | 按用户/项目作用域选择全索引 | 无额外检索模型与 RAG，预算失败可解释 |
| 正文读取 | 独立 read_memory 与不透明引用 | 不扩大文件工具目录，不混淆压缩结果的生命周期 |
| 存储 | Markdown + 版本化提交 + 原子 HEAD | 比独立覆盖正文/索引更易保障一致；不使用数据库 |
| 自动提取 | 有界内存任务 + 持久幂等账本 | 不影响对话，允许退出时放弃；不承诺持久任务队列 |
| 清理 | 显式选择、锁内复检 | 避免启动删除和预览/执行竞态 |

## 依赖决策

零新增运行时依赖。文件、锁与 hash 使用 Node 标准库，frontmatter 使用已有 yaml，模型使用现有 ChatProvider。禁止引入 Agent 框架或服务端代码/文件执行能力。

## 验证策略

单元验证路径/预算/解析/资格/时间边界；集成使用临时目录、可注入时钟与模型替身，验证真实保存、重试、跨进程竞争、失败注入和请求载荷。Web/CLI 合同测试覆盖新增状态，真实浏览器与 tmux 覆盖用户流程。测试与实现一同推进，不以全绿单测替代端到端证据。完整对应关系见 task.md 与 checklist.md；实际实施结果和验证边界记录在 checklist.md。


真实失败修复说明：本轮修复沿用用户已批准的事实来源、作用域、安全校验与异步提交约束，不新增运行时依赖或模型重试，不修改会话/Markdown 格式。最终回复明确不能提前确认本轮异步写入；没有事实记忆时回答未知，项目代号不替代文件观察。
