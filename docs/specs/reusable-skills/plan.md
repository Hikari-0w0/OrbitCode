# 可复用 Skill 技术计划

状态：已批准
依据：同目录已批准的 `spec.md`；用户明确“批准，开始开发”后实施。本文已同步实现中的机械性接口与文件归属调整。

## P1：架构与当前基线

立项时 `AgentRuntime` 负责配置、Workspace、权限、MCP 初始化、AgentLoop 装配和保存；`runAgentTurn` 负责事件与清理。`AgentLoop` 在用户回合入口构建系统提示和工具列表；调度器预先准备整个工具批次，再并发只读调用。会话校验严格限制字段，新增状态必须同时调整保存、校验、恢复、导出及清空。用户配置根默认是 `~/.orbitcode`，隔离 CLI 数据目录已有覆盖入口。

新增能力遵循以下依赖：入口 → 运行层 Skill 服务 → 解析、会话及工具抽象；核心仅依赖领域类型和注入接口，禁止导入运行层、React 或 Next.js。工具工厂接收加载/资源读取接口，不直接引用运行层实现。

| 组件 | 文件与职责 |
| --- | --- |
| 领域契约 | 新增 `src/core/skills/types.ts`：定义、激活快照、历史策略、错误与子执行事件 |
| 解析与发现 | 新增 `src/runtime/skills/definition.ts`、`catalog.ts`：格式、插值、覆盖、来源及内容指纹 |
| 会话服务 | 新增 `src/runtime/skills/service.ts`：列表、刷新、激活、停用、校验及持久化协作 |
| 资源访问 | 新增 `src/runtime/skills/resources.ts`：绑定激活来源、资源指纹、路径校验 |
| 独立执行 | 新增 `src/runtime/skills/isolated-runner.ts`、`history.ts`：子会话装配、历史选择、结果摘要 |
| 共享装配 | 新增 `src/runtime/agent-session-factory.ts`，从现有运行时抽取模型、上下文、工具与 AgentLoop 装配，供主/子会话调用 |
| 工具 | 新增 `src/tools/load-skill.ts`、`read-skill-resource.ts`、`skill-policy.ts`，修改默认注册与模式策略 |
| 状态与循环 | 修改会话类型/校验/存储、AgentLoop、工具调度器与相关事件契约 |
| 双端适配 | 新增公共 `src/runtime/skill-commands.ts`；新增 Web HTTP 适配与 Skill 面板；接入 CLI 控制器与渲染器 |
| 内置资源 | 新增 `skills/commit/SKILL.md`、`skills/review/SKILL.md`、`skills/test/SKILL.md`；构建时显式包含 |

不复制 Agent Loop；子会话通过共同装配器产生独立实例，运行主/子会话均使用 `runAgentTurn`。

## P2：格式、目录与发现

### 配置契约

规范示例：

```markdown
---
name: review
description: 审查指定范围并给出有证据的问题清单
allowed-tools: [read_file, find_files, search_code, read_context, read_skill_resource]
mode: isolated
history: { kind: recent, turns: 3 }
---
审查 {{arguments}}。将第一个参数 {{arg:1}} 作为重点范围。
```

上方示例无 `model` 时继承当前配置；可选 `model: configured-provider-id` 引用现有模型配置 ID，绝不接受凭据或 URL。必填字段为 name、description、allowed-tools、mode；history 仅用于 isolated，缺省 `{kind: none}`，也接受 `{kind: all}`；recent 的 turns 为 1—50 整数。shared 出现 history 即拒绝。名称匹配 `[a-z][a-z0-9-]{0,63}`，区分明确、小写唯一；说明为 1—200 Unicode 字符的单行文本。工具是无通配符的精确名称列表，最多 64 项，重复项拒绝，空数组合法。

使用已有 `yaml` 的文档解析接口，拒绝重复键、未知字段、自定义标签、锚点/别名、多文档及非对象元信息；只识别文件开头 frontmatter（允许 UTF-8 BOM、LF/CRLF）。正文至少一个非空白字符，格式错误带文件和字段定位，不把原文或环境变量放入诊断。

参数统一使用原始字符串。`{{arguments}}` 替换完整参数文本；`{{arg:N}}` 从 1 开始，按空白切词，单双引号保留含空格参数、反斜杠仅转义引号/反斜杠/空白；不支持 Shell 展开。未闭合引号、缺位置参数报错；反斜杠转义的 `\{{...}}` 保留字面占位符。单遍替换，只处理上述占位符，普通 Markdown 花括号不变，参数中的占位符不再次展开。

### 来源与快照

- 项目级：授权 Workspace 的 `.orbitcode/skills/`。
- 用户级：现有 `userConfigurationRoot` 下的 `skills/`，遵从 CLI 数据目录隔离。
- 内置：应用随包提供的 `skills/`，基于应用资源位置定位，不依赖用户当前工作目录。修改 `next.config.ts` 的文件追踪配置保证生产包包含它，测试 dev、build/start 和任意 cwd 的 CLI。
- 每个根只发现直接子级 `*.md` 以及直接子目录的 `SKILL.md`；附属目录不参与 Skill 发现，不递归把模板识别成入口。根和文件均解析真实路径，项目根不能逃逸 Workspace，用户/内置入口不能逃逸其配置根。
- 先收集候选及名称归属，再按项目 > 用户 > 内置决胜；同层重名或可识别名称的无效高层定义保留阻断诊断。语法损坏到无法可靠识别名称时，不用正则猜名阻断其他定义。
- 扫描解析入口以验证元信息，正文仅留在服务端候选快照，不进入列表响应或提示；“两阶段”指模型上下文按需加载，而非声称初始完全不读取磁盘正文。
- 入口原文、规范化元信息和来源共同生成 SHA-256 指纹。目录刷新生成新目录 revision，已有回合持有旧目录快照，后续回合取新目录；跨进程每个新回合检查入口指纹，不依赖进程内刷新广播。
- 显式调用校验客户端目录 revision，过期返回 conflict；模型调用绑定本回合目录。加载前入口变化则返回 definition-stale，需要刷新后重试，不混合两份内容。

### 初始预算

每来源最多 256 个入口、1024 个直接目录项，扫描总时限 5 秒；入口 64 KiB、frontmatter 8 KiB、三个来源入口累计 8 MiB。超限来源标记不完整并禁用其候选，而非截取前 N 个假装完整；无法确认高优先级来源时，低层候选显示来源未确认并禁止激活，避免错误覆盖。其他有效文件的正常解析错误仍仅影响该文件/名称。

每会话最多 8 个激活 Skill，替换后正文合计 128 KiB，参数 16 KiB；目录摘要上限 16 KiB，过大时模型不接收部分目录，返回目录超限诊断供用户缩减，界面仍可查看完整有界列表。上下文估算还必须满足模型窗口及现有回复保留预算，不能只检查字节上限。

## P3：核心契约与状态

以下为拟定接口，不是已实现代码；ToolName、AgentMode、ConversationCheckpoint 等复用现有领域类型。

```ts
type SkillHistory =
  | { readonly kind: "none" }
  | { readonly kind: "recent"; readonly turns: number }
  | { readonly kind: "all" };

type SkillDefinition = {
  readonly name: string;
  readonly description: string;
  readonly allowedTools: readonly ToolName[];
  readonly model?: string;
} & (
  | { readonly mode: "shared" }
  | { readonly mode: "isolated"; readonly history: SkillHistory }
);

type SkillSource = "project" | "user" | "builtin";
type ActivatedSkill = {
  readonly definition: SkillDefinition;
  readonly source: SkillSource;
  readonly definitionHash: string;
  readonly resourceRoot: string;
  readonly arguments: string;
  readonly instructions: string;
  readonly resourceHashes: Readonly<Record<string, string>>;
};

type SkillFailureCode =
  | "invalid-definition" | "invalid-arguments" | "not-found"
  | "tool-unavailable" | "model-unavailable" | "definition-stale"
  | "resource-stale" | "boundary-denied" | "capacity"
  | "busy" | "conflict" | "cancelled" | "execution-failed";

type SkillLoader = (
  input: { name: string; arguments: string },
  context: ToolExecutionContext,
) => Promise<ToolExecutionResult>;
```

领域快照只含可序列化数据。`resourceRoot` 为服务端字段，客户端列表使用来源标签而非绝对路径；校验磁盘状态时重新验证根绑定，不能因为检查点含某路径就信任它。列表、激活摘要、完整持久化快照分别使用明确 DTO。

`SkillSession` 管理激活快照、目录与校验；`AgentRuntime` 提供列表/刷新和停用编排；在已持有回合租约的环境内创建 `SkillLoader`，不再次获取主会话锁。会话增加可选 `skills` 状态（含格式版本 1、generation 和激活集合），旧检查点缺省为空，保持现有会话 schemaVersion 的向后读取兼容；不保证旧程序读取新字段。

状态变化：未激活 → 全部校验通过 → 激活；相同定义与参数 → 幂等；不同参数/显式更新 → 全量校验后原子替换；停用 → 移除；任何失败 → 保持旧状态。每次真实变化递增 generation。空白名单不是“未激活”，必须保留空集合约束。

回合内使用工作副本，在回合结束（含取消）与消息一并 CAS 保存；已成功激活后取消仍保存激活，尚未完成的加载不保存。保存失败保留现有 pending-save 流程，不单独写入 Skill 状态。显式停用使用 `skill-mutation` 操作锁、expectedRevision；忙碌时拒绝。清空重置 skills 并更新 lifecycleEpoch。恢复/重试保存不得重新执行 Skill，原始已保存指令无需源文件仍存在，但资源访问仍须当前边界校验。

## P4：提示、工具策略与调度

新增可选提示字段 `availableSkills`，只序列化名称/简介；沿用 `activatedSkills` 展示有效指令、Skill 名称及参数结果。动态内容沿用现有标签转义，明确其优先级低于系统安全规则。

AgentLoop 接收无 UI 依赖的当前提示快照提供器，每次模型请求前重建系统消息与 `access.definitions()`；有 ContextManager 时将最新 envelope 传入 prepareForModel，无 ContextManager 时替换 transcript 系统前缀，不能追加多份旧提示。激活前用现有 token estimator 验证新 envelope；压缩只处理历史，不删减有效指令。

工具层增加 `SkillToolPolicy`，组合现有 ModeToolPolicy，definitions、classify、prepare 和 executePrepared 统一检查：已注册工具 ∩ 模式允许 ∩ 父级上限 ∩ 全部激活白名单。没有激活时本层不限制；仅 `load_skill` 豁免父级及本级 Skill 白名单，仍校验调用用途和模式。停用只由用户入口完成，模型不能调用它扩大权限。

`load_skill` 是上下文状态操作，权限目标仍为 context，但不能作为普通只读调用并发。为工具描述/PreparedToolCall 增加独立的调度字段 `scheduling: "normal" | "barrier"`，load_skill 采用 barrier，不把它伪装成 workspace-write 以混淆 Plan。调度器到达 barrier 先完成前序调用，独占执行，再准备后序批次；取消原先整批预准备跨 barrier 的行为。每个调用在审批前及实际执行前检查当前 generation 和权限，工具代码不允许绕过 policy 直接执行 prepared closure。

补充执行预算字段 `budget: "standard" | "parent-run"`，只有 load_skill 使用 parent-run，以剩余父运行 deadline 限制；其他文件/命令工具保持现有时限。ToolExecutionContext 明确传递总 deadline，不能为子调用重新生成更长预算。

白名单本地名称在扫描时核验；外部名称使用 MCP 配置及已授权发现目录，已配置但尚未发现的名称标记待验证；目录扫描不连接外部 Server。回合沿用现有 MCP 初始化审批，完成后再校验 Skill；Plan 中保持外部工具不可用。MCP 名称还绑定已发现 schema/identity，定义变化时重新校验，禁止信任伪造前缀。

加载返回正文供模型立即读取，同时仅将规范化快照保留在 activatedSkills；历史工具结果可按原策略卸载，激活提示独立保留。完成报告仍受现有阶段条件与白名单约束；不因 load_skill 成功就产生已验证的工作区完成证据。

## P5：目录型资源

新增 `read_skill_resource`，参数为已激活 name、相对 path；作为普通只读工具，必须出现在 Skill 白名单及 Plan 允许集合中，不享受 load_skill 豁免。仅接受当前激活目录树中的 UTF-8 文件，单次最多 128 KiB，最多记录 64 个资源指纹，总读取时间 10 秒。单文件 Skill 可使用其所在目录作为资源根，但同样要求 Workspace 内。

工具在准备阶段将资源映射到 Workspace 相对路径，使用现有 path 权限目标及 Gateway；执行阶段再次校验根、真实路径和文件身份后读取，不将其伪装成 context 免审批读取。入口允许从配置来源读取，不意味着附属资源允许越过 Workspace。资源内容第一次成功读取后记录 hash；再次读取及每次模型请求/执行副作用工具前检查已引用资源，变化即 resource-stale 并阻止继续按旧激活执行，提示重新激活。

运行中的脚本及普通工作区文件不提供不可变文件系统保证；既有命令沙箱也不保证脚本执行期间文件无法被外部进程改写。这里承诺的是工具边界上的指纹校验，不宣称能消除外部并发修改。模板应先经资源工具读取脚本，再使用已有 run_command 执行；不得自动执行目录内文件。

## P6：独立模式

### 会话与历史

`isolated-runner` 生成子 runId、独立 ContextManager、CompletionTracker、ManagedProcessController 和受限工具策略，经共享 factory 装配 AgentLoop。子上下文使用本次运行专属临时 LocalContextStore，结束后清理；不作为普通可恢复主会话列入列表，不触发独立长期记忆提取。保留带 parentRunId/parentCallId 的运行证据与摘要，不保留可自动重放的子任务。

历史选择在调用开始时冻结，只取先前已完成的用户回合；当前正在执行的用户输入通过调用说明另行传入，排除尚未完成的调用批次。recent 按用户回合而不是消息条数，工具组保持完整；不足 N 回合就携带全部可用完整回合并标注数量。压缩摘要无法可靠拆成最近回合时不计入 recent，报告历史已压缩；all 包含当前有效摘要。

被携带的卸载工具结果在父会话授权范围内读取并复制到子上下文存储，重写引用，禁止共享父会话句柄；累计展开上限 1 MiB，超限、缺失或无法重写时拒绝启动并建议缩小范围。可解析正文中父级 context 引用也必须重映射，无法验证的父会话引用替换为“本子会话不可用”并明确诊断，不能留可访问的跨会话通道。历史复制不调用摘要模型，也不恢复已丢弃原文。

子输入和 activatedSkills 标记明确当前 Skill 已加载并激活，直接执行已有指令，不再次加载自身。此提示用于消除模型歧义，不代替递归执行拒绝或白名单限制。

### 模型、权限与边界

省略 model 继承当前 provider；显式 model 从已有配置解析，shared 不一致拒绝。子模型不改变主会话绑定；缺配置、凭据或模型能力失败不回退。

父白名单交集被冻结为子会话上限，子 Skill 以及后续共享 Skill 继续取交集。子会话继承 Plan/Do，不能通过加载改变模式。独立模式中再次加载独立模式返回可恢复错误；主回合最多顺序启动 4 次独立执行，即使配置 unlimited 仍受此上限限制。

子审批复用父回合有效的 broker 和动态 permissionMode/rules，但创建绑定子 workspace/provider 的 Gateway；不调用 beginTurn 覆盖父回合。审批请求 ID 全局唯一；模型 call ID 在子会话内使用，展示时添加子 runId 前缀，并保留子运行归属；一次性审批只适用原操作，不能因父会话批准加载就默认批准子命令。父已有 MCP 工具通过带生命周期的租约复用并重新约束，不绕过授权发现或任意建立子连接。

### 事件与完成

扩展工具执行上下文的有界事件出口，将子执行 progress、tool-started/result、permission-requested/resolved 和 stopped 包装为 `skill-run` 事件，使用独立 core Skill 事件联合，避免递归 AgentEvent 类型。调度器在工具 Promise pending 时持续消费事件队列，再把它们传给父 AgentLoop 和 runtime；不能等工具返回才展示审批。队列最多 128 条，有背压；取消必须唤醒消费者/生产者，禁止丢弃审批事件。Web SSE 校验、CLI 渲染、JSONL 输出和运行日志同步支持包装事件；子 tool-result 不计入父 CompletionTracker 的工具证据。子工具结果投影到独立的 display timeline，保存恢复后仍可查看 stdout、stderr 和退出状态，不把子原始上下文复制给主模型。

子执行最多 16 次模型迭代，并受父有限轮数配置取更小值；最多 5 分钟且不超过父剩余运行/调用预算。超时覆盖初始化、审批等待、模型请求和工具执行。子停止、失败、取消都关闭其进程和临时存储；不销毁父工具连接。父清理最终等待子清理完成，清理失败显式记录。

摘要由运行记录确定性生成，最多 8 KiB；结构化状态、sideEffect、stopReason、验证状态及计数优先保留，模型最终文本只是有界摘录，截断标记和子日志引用用于查看余项，不额外请求摘要模型。工具失败结果必须带实际摘要和副作用信息，启动失败与已执行失败明确区分。load_skill 虽以 context 目标加载定义，其独立执行结果仍须聚合子 sideEffect；超时、异常及取消包装不得因为加载工具被分类为只读而把已发生或可能的副作用改成 none。主任务不能把子摘要的“成功结束”等同于主任务 verified。

子摘要增加运行时生成的 `commandCalls`：完整调用总数、成功/失败数、最近 16 条结果的顺序/退出码/超时与取消状态，以及省略条数。不复制命令正文、stdout/stderr 或错误正文；该计数包含被拒绝的调用，不等于 Shell 子命令次数或文件行数。主会话须把这些事实与子模型最终陈述区分，冲突时说明差异；首次检查与追加复验分别报告。摘要继续受整体 8 KiB 上限约束。

## P7：双端交互与公共协议

统一命令：`/skills` 查看、`/skills refresh` 刷新、`/skill <name> [参数]` 调用、`/skill deactivate <name>` 停用。为避免名称 deactivate 的歧义，显式形式为 `/skill run <name> [参数]`，简写 `/skill <name>` 仅在名称不冲突时启用；固定控制词优先。已有 `/plan`、`/test` 等控制命令不被 Skill 抢占，本轮不提供顶层 `/<Skill名称>` 自动别名。`//` 转义保持既有语义。

公共 parser 在 runtime，Web、CLI 只转交识别结果。调用命令经正常运行入口：解析后由运行层先执行与 load_skill 相同的加载流程，再启动共享任务或把子摘要交给主模型继续；记录真实用户命令和加载结果，不让模型决定是否执行用户指定 Skill。不虚构未发生的工具调用，预加载记录使用专门事件。模型主动 load_skill 与命令调用复用同一 loader。shared 显式调用正文以调用目的和参数作为当前用户输入。

Web 新增 `GET /api/conversations/[conversationId]/skills` 和同路由 POST（refresh/deactivate）；变更携带 expectedRevision，刷新携带 catalogRevision，来源由服务端会话 Workspace 决定，客户端不得传目录。执行仍走 `/api/chat`。新增 `src/web/skill-http.ts` 与 `src/components/skill-panel.tsx`；对外会话 DTO 只公开激活摘要，不能通过 spread 检查点泄露完整入口、参数或绝对资源根。

CLI 控制器接入公共 parser，renderer 展示来源、诊断、激活和子执行状态；run-once 同样识别 Skill 执行命令，列表等管理命令在单次运行中明确返回不支持管理操作，避免误送模型。非交互审批继续按既有 CLI 拒绝/终止语义，不自动批准；输出 JSON/JSONL 不混入普通终端文本。README 写明三种目录、元信息、调用与资源边界。

## P8：错误、安全与依赖

业务 SkillError 通过 skillFailure 映射现有结构化工具错误：参数/定义/模型不可用 → invalid-arguments（保留具体 Skill code）；未知名称 → not-found；工具不可用/边界拒绝 → permission-denied；定义或资源变化 → conflict；预算 → limit-exceeded；取消 → cancelled。资源路径工具继续使用既有路径边界错误。子运行终止使用原 AgentStopReason，不合并为成功。不得把未捕获异常原文或配置凭据返回模型。

扫描不启动进程、不联网；白名单限制不替代权限系统。load_skill 的 context 豁免仅允许读取受约束定义、改变会话及进入受限子执行，所有子副作用仍经完整 Gateway。保留命令 stdout/stderr、退出码和超时，测试不弱化路径/危险命令限制。

零新增运行时依赖。采用现有 yaml、Node fs/path/crypto、现有 ContextStore、模型适配及测试框架；无需 Agent SDK、文件托管或模板执行库。

## P9：需求映射与决策

| 需求 | 负责章节/组件 | 核心行为 |
| --- | --- | --- |
| F1 | P2 definition | YAML、参数、严格校验 |
| F2 | P2 catalog | 分层覆盖与逐文件诊断 |
| F3 | P3/P4 loader、提示 | 两阶段与原子激活 |
| F4 | P3/P4 会话及循环 | 持久化、动态提示与清空 |
| F5 | P6 factory、runner、history | 独立上下文、审批与摘要 |
| F6 | P4 policy、scheduler | 交集、双重校验、屏障 |
| F7 | P7 公共命令和双端 | 一致交互及传输 |
| F8 | P2/P3/P5 快照 | 刷新隔离与指纹 |
| F9 | P5 资源工具 | 路径、权限、按需读取 |
| F10 | P2/P7 内置资源 | 三样板与生产打包 |
| F11 | P3/P6/P8 | 错误、预算、取消与恢复 |

| 决策 | 选择及理由 | 未采用 |
| --- | --- | --- |
| 多 Skill 权限 | 用户确认交集，保持最严格约束 | 并集扩大单个 Skill 权限 |
| 独立执行 | 同循环、独立实例及临时上下文，边界明确 | 复制循环或生成第二套 Agent |
| 更新策略 | 新目录 + 已激活快照，显式更新 | 热替换执行中正文 |
| 资源访问 | 单独受白名单控制的路径工具 | load_skill 任意文件读取豁免 |
| 子摘要 | 确定性证据摘要，稳定且无额外调用 | 额外模型摘要请求 |
| 配置解析 | 已有 yaml + 显式校验 | 新模板引擎或第三方 Agent 框架 |

## P10：验证策略与自检

单元验证格式、覆盖、参数、历史与策略；集成用记录请求的本地模型替身验证同回合激活、压缩、权限事件、CAS 和取消；跨进程测试恢复、刷新与迟到结果；Web/CLI 对比同输入的可见工具、状态和副作用。生产 build/start 验证内置资源不依赖源码 cwd。

完成后执行相关测试，再依次 lint、typecheck、build；使用 agent-browser 检查页面、控制台和错误覆盖层，在 tmux 做真实程序端到端交互，模型替身与真实模型结果明确区分。检查点、工具返回、工作区文件分别取证。详细步骤及实际结果见 task/checklist；初次验证使用本地可控协议替身；用户后续授权的真实模型评测及其失败样本见 docs/evals/skills-real-model-2026-10-16.md。

已检查 F1—F11 归属、核心无反向 UI 依赖、子审批可实时消费、同批次权限变更有屏障、清空与恢复有修订号边界；本计划已批准；验收结果独立记录，不由文档状态推断。

## 实施后的边界修正（2026-10-17）

未扩展需求范围：成功清空/删除后丢弃旧待保存状态，清空成功后删除旧回合标记；recent 遇到压缩或回合不足给出明确边界；资源超限按既定 capacity 映射返回；生产文件追踪明确排除本地配置/私有数据且包含内置资源；CLI 主入口双方先解析真实路径，支持符号链接。新增实际终端与仓库外隔离包验证脚本。最终 581 项测试及 lint/typecheck/build 通过，原清单 34/34；故障、证据和非穷尽验证边界见 docs/evals/skills-acceptance-2026-10-17.md。
