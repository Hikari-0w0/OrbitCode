# 结构化系统提示与缓存可观测性 Plan

状态：已批准
依据：已批准的 `spec.md`

## 架构概览

本阶段新增一个位于核心层的系统提示子系统。七个固定模块只导出声明式内容；固定提示组装器按唯一顺序连接它们；动态上下文组装器负责白名单环境、可选扩展和会话级模式提醒，并输出一组 system 消息。Agent Loop 在进入模型迭代前只组装一次这些消息，随后复用于该用户请求内的所有迭代。

Web 入口负责从已验证的 Workspace 配置和页面会话状态构造核心层输入，不持有固定提示文本。Provider 继续只负责 OpenAI 兼容协议转换，并把经过校验的基础 Token 与提示缓存信息转换成统一用量类型。Agent 事件将统一用量传到现有 Web SSE 契约，页面只渲染结果。

```text
Web 会话状态 ──模式连续轮次──┐
Workspace 配置 ──安全环境────┼─→ 核心提示组装 ─→ Agent Loop ─→ Provider
固定七模块 ─────────────────┘        │                 │
稳定工具注册表 ───────────────────────┘                 ↓
Web 展示 ← SSE 用量事件 ← Agent 用量累计 ← Token/缓存解析
```

依赖方向保持为：页面与 Route Handler 调用核心；核心调用 Provider 和工具抽象；Provider 不反向依赖核心提示；核心提示不依赖 React、浏览器或 Next.js。

## 需求映射

| 需求 | 负责模块/交互 | 设计说明 |
| --- | --- | --- |
| F1 | `src/core/system-prompt/*` | 七个固定模块分别导出内容，由固定组装器按常量优先级和单空行拼装。 |
| F2 | 七个固定模块及模块级测试 | 每个模块只覆盖自身职责，交叉规则通过固定提示快照和关键语义断言检查。 |
| F3 | 核心消息组装器、Agent Loop | 统一生成固定 system、环境、三个可选扩展、会话动态、历史和当前用户消息的确定顺序。 |
| F4 | 核心动态补充构造器 | 为五类补充使用固定标签和 system 角色，固定提示声明其上下文语义。 |
| F5 | 核心动态补充校验、Web 组装层 | 使用白名单环境、长度限制和标签转义；Route 在模型调用前提供已验证 Workspace 元数据。 |
| F6 | 核心轮次策略、Web 会话状态 | 连续模式轮次 1、5、9……使用完整版本，其余使用精简版本；一次用户请求只计算一次。 |
| F7 | 任务模式固定模块、会话动态指令、现有模式工具策略 | 提示明确 Plan/Do 行为，服务端权限与停止条件继续独立强制执行。 |
| F8 | 工具使用固定模块、现有六个工具描述 | 全局规则和相关工具描述双重声明专用工具优先与编辑前读取。 |
| F9 | 固定提示组装、工具注册表、Provider 请求测试 | 同一模式的固定提示和工具定义以稳定数组顺序发送，不加入动态描述或 `cache_control`。 |
| F10 | Provider 用量模型与 OpenAI 流解析 | 解析标准缓存 Token、兼容数值别名和明确命中状态；缺失或异常可选字段降级为不可用。 |
| F11 | Agent 用量事件与累计器 | 每迭代保留基础 Token 和缓存可用性；仅完整数值链累计缓存 Token。 |
| F12 | Web SSE 契约、会话 reducer、消息列表 | 严格解析用量事件并展示缓存 Token、比例、命中状态或不可用。 |
| F13 | `docs/evals/structured-system-prompt.md` | 固定六类任务、前提、观察表和证据记录方式，实施前后人工执行同一任务集。 |

## 核心类型与接口

```ts
export type FixedPromptModuleId =
  | "identity"
  | "system-constraints"
  | "task-mode"
  | "action-execution"
  | "tool-use"
  | "tone-style"
  | "text-output";

export type FixedPromptModule = {
  readonly id: FixedPromptModuleId;
  readonly priority: number;
  readonly content: string;
};

export type PromptEnvironment = {
  readonly workspace: {
    readonly id: string;
    readonly name: string;
  };
  readonly platform: string;
  readonly currentDate: string;
  readonly timeZone: string;
  readonly pathSemantics: "workspace-relative-posix";
};

export type OptionalPromptContext = {
  readonly customInstructions?: string;
  readonly activatedSkills?: string;
  readonly longTermMemory?: string;
};

export type SessionInstructionContext = {
  readonly mode: AgentMode;
  readonly modeTurn: number;
};

export type PromptSystemMessage = {
  readonly role: "system";
  readonly content: string;
};

export function buildFixedSystemPrompt(): string;

export function buildSystemPromptMessages(input: {
  readonly environment: PromptEnvironment;
  readonly optional?: OptionalPromptContext;
  readonly session: SessionInstructionContext;
}): readonly PromptSystemMessage[];
```

`priority` 仅用于启动时校验模块声明与固定顺序一致，不能由请求参数修改。`buildFixedSystemPrompt` 必须对相同程序版本返回逐字符一致的字符串。动态组装结果至少包含固定、环境和会话指令三条 system 消息；三个可选扩展只有非空且通过校验时才出现。

```ts
export type PromptCacheUsage =
  | { readonly availability: "tokens"; readonly cachedTokens: number }
  | { readonly availability: "status"; readonly hit: boolean }
  | { readonly availability: "unavailable" };

export type ModelTokenUsage = {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly promptCache: PromptCacheUsage;
};

export type TokenUsage =
  | {
      readonly availability: "reported";
      readonly promptTokens: number;
      readonly completionTokens: number;
      readonly totalTokens: number;
      readonly promptCache: PromptCacheUsage;
    }
  | { readonly availability: "unavailable" };
```

基础 Token 缺失时沿用整体 `unavailable`。基础 Token 存在而缓存字段缺失时，`promptCache` 单独为 `unavailable`，不会丢弃有效基础数据。累计事件沿用 `TokenUsage` 外形：当此前每次缓存数据均为数值时累计 `cachedTokens`；全部有命中信息但不能完整累计 Token 时，以 status 记录“本轮累计范围内是否至少一次命中”只用于摘要展示；任一迭代未报告缓存时累计缓存为 `unavailable`。Web 不根据 status 计算 Token 比例。

```ts
export type WebChatRequest = {
  readonly provider: string;
  readonly workspaceId: string;
  readonly mode: AgentMode;
  readonly modeTurn: number;
  readonly messages: readonly PlainConversationMessage[];
};
```

`modeTurn` 由页面状态维护，模式实际改变、切换 Workspace、切换 Provider、清空会话或刷新页面时归零；提交请求时，新模式从 1 开始，否则加 1。它不是权限依据，服务端仍执行模式工具策略；服务端只接受正整数和稳定上限内的值。模型文本无法写入该字段。

## 状态与交互

### 请求组装

1. Web Route 严格解析请求，解析 Provider 和 Workspace，并从授权清单取得 Workspace 的 `id` 与 `name`；绝对根路径仅用于创建既有 Workspace 边界。
2. Route 使用注入的当前时间、运行平台和时区构造白名单环境。日期规范化为 `YYYY-MM-DD`，平台和时区使用受限字符串；不遍历或复制进程环境变量。
3. Agent Loop 在用户轮次开始时调用提示组装器。组装器验证环境、可选文本和 `modeTurn`，选择完整或精简模式指令并转义动态标签内容。
4. 初始 transcript 顺序固定为：七模块固定 system → 环境 system → 自定义指令 system（可选）→ 已激活 Skill system（可选）→ 长期记忆 system（可选）→ 会话指令 system → 已成功历史 → 当前用户消息。
5. 同一用户请求中的后续模型迭代复用同一个 transcript 前缀，只在末尾追加 assistant 工具调用与 tool 结果；不会因迭代号改变 system 消息。

### 模式强化

- `modeTurn <= 0`、非整数或超出 10,000 时在模型请求前拒绝。
- `modeTurn === 1` 或 `(modeTurn - 1) % 4 === 0` 时选择完整指令，即 1、5、9……轮；其他轮次选择精简指令。
- 完整和精简版本都包含当前模式、工具权限概述和禁止越权；完整版本额外包含该模式的工作流程、验证和失败说明。
- 页面在请求开始时提交并保存本次 `modeTurn`，即使请求失败或取消也视为已经发生一次用户轮次；模式变化和会话重置路径统一归零。
- 服务端权限判定不读取 `modeTurn`，因此伪造轮次最多影响提示长度，不能扩大工具权限或迭代上限。

### Provider 用量与缓存

1. 先独立解析并校验 `prompt_tokens`、`completion_tokens` 和 `total_tokens`。
2. 按优先级识别 `prompt_tokens_details.cached_tokens`、根级 `prompt_cache_hit_tokens` 和布尔 `prompt_cache_hit`。数值必须是非负安全整数且不超过 `prompt_tokens`。
3. 多个已识别缓存字段同时存在且语义一致时使用优先级最高的精确信息；冲突、类型错误或越界只把缓存子信息降级为 `unavailable`，不丢弃合法基础 Token，也不暴露原始值。
4. Provider 仍在流结束时只产出一次 usage 事件。Agent 把它转换为每迭代和累计用量；某次完全无 usage 时维持现有“模型未报告”语义。
5. Web SSE 解析器执行与核心类型相同的严格校验。页面数值型缓存显示“缓存 N · 命中率 P%”；status 只显示“缓存命中/未命中”；不可用显示“缓存未报告”。

### 失败与终止

- 固定模块声明冲突、缺失或顺序错误属于启动期编程错误；测试和构建必须发现，不在运行时静默重排。
- 不合法环境、补充文本或会话轮次属于 Agent 配置错误，在 Provider 调用与工具副作用前结束。
- 可选缓存字段异常只影响缓存可观测性；基础 usage 非法仍沿用现有 Provider 协议错误。
- 新增提示与用量事件不新增 Agent 停止原因；模型错误、取消、最大迭代等现有终止路径保持不变。

## 模块设计

### 七个固定提示模块

- 职责：每个文件仅声明一个模块的 ID、优先级和固定中文内容。
- 对外契约：导出只读 `FixedPromptModule`，不接受运行时参数。
- 依赖：只依赖核心提示类型；不读取时间、环境、Workspace、模式或工具注册表。
- 错误处理：由固定组装器断言七项完整、ID 唯一、优先级严格递增、内容非空且无动态标签。

### 固定与动态提示组装

- 职责：确定性拼装七模块，构造五类带标签的补充消息，选择会话提醒版本并保证消息顺序。
- 对外契约：接收已白名单化的环境、可选内容和会话上下文，返回只读 system 消息数组。
- 依赖：只依赖核心领域类型和 AgentMode；不依赖 Provider、React 或 Next.js。
- 错误处理：拒绝非法日期、未知平台、空白或超长补充、非法轮次；对 `<`、`>`、`&` 做实体转义，避免闭合标签。

动态文本单项最大 20,000 字符，三项可选文本合计最大 40,000 字符；环境字段继续服从既有 Workspace ID/名称上限，系统生成字段使用更小固定上限。没有内容时调用方不传字段，组装器不产生空消息。

### Agent Loop 接入

- 职责：在进入循环前组装一次系统消息，把现有内联模式提示移除，并保持工具迭代消息只追加在 transcript 尾部。
- 对外契约：构造时接收环境与可选提示上下文；每次 `streamTurn` 接收 mode 与 modeTurn。
- 依赖：调用核心提示组装器、Provider 抽象和工具策略；仍不依赖 UI。
- 错误处理：提示输入错误映射为现有 Agent 配置/内部错误路径，并保证调用模型前失败。

### Web 会话与组装层

- 职责：维护连续模式轮次，提交并校验 `modeTurn`，从服务端授权 Workspace 元数据构造安全环境。
- 对外契约：Web 请求新增必填正整数 `modeTurn`；客户端 reducer 在所有模式与会话重置路径维护计数。
- 依赖：Route 依赖核心、Provider 工厂、工具策略和 Workspace 配置；组件只依赖 Web 契约及展示类型。
- 错误处理：非法轮次返回安全的 400 错误；环境构造失败不启动 Agent。绝对路径不进入提示或 Web 响应。

### 工具定义

- 职责：在六个现有工具描述中加入使用时机和限制，并保持注册顺序稳定。
- 对外契约：不改变工具名称、参数 schema、执行结果或权限分类。
- 依赖：沿用工具注册表和 schema；描述不调用提示组装器。
- 错误处理：由工具注册表测试检查名称、顺序、描述关键语义和无动态标签。

### Provider 与用量模型

- 职责：解析缓存子字段，向上提供统一的基础 Token 与缓存判别联合。
- 对外契约：usage 流事件仍为一次，但数据增加 `promptCache`。
- 依赖：Provider 只依赖协议类型与 SSE，不依赖 Web 展示。
- 错误处理：基础 usage 非法为协议错误；缓存子字段缺失、未知或非法时保守降级为 unavailable。

### Web 展示

- 职责：严格解析新增缓存字段，在现有用量行展示数值、比例、状态或不可用。
- 对外契约：SSE 事件名称不变，`token-usage` 的 usage 与 cumulative 结构扩展。
- 依赖：Web 契约依赖核心事件类型；组件只消费已经校验的事件。
- 错误处理：非法 SSE 数据按现有传输失败处理；合法 unavailable 不触发错误提示。

### 人工对比文档

- 职责：保存六类固定任务、隔离 Workspace 准备、运行条件、逐项观察和前后结果。
- 对外契约：每项使用相同输入、模式、模型和 Workspace 基线，记录工具序列、是否读取、是否越权、验证动作和最终文本表现。
- 依赖：不参与运行时代码，不包含配置密钥或敏感输出。
- 错误处理：环境不可用或未执行时明确标为未验证，不能预填通过。

## 文件组织

```text
src/
├── app/api/chat/route.ts                         # 构造安全环境并传入 modeTurn
├── app/globals.css                              # 缓存用量在窄屏下的展示
├── components/
│   ├── chat-session-state.ts                    # 维护模式连续轮次与缓存用量状态
│   ├── chat-session-state.test.ts
│   ├── chat-workspace.tsx                       # 随请求提交 modeTurn
│   ├── chat-workspace.test.tsx
│   ├── message-list.tsx                         # 展示缓存 Token、比例或状态
│   └── message-list.test.tsx
├── core/
│   ├── agent-events.ts                          # 扩展 TokenUsage
│   ├── agent-loop.ts                            # 接入提示组装并累计缓存用量
│   ├── agent-loop.test.ts
│   └── system-prompt/
│       ├── types.ts
│       ├── identity.ts
│       ├── system-constraints.ts
│       ├── task-mode.ts
│       ├── action-execution.ts
│       ├── tool-use.ts
│       ├── tone-style.ts
│       ├── text-output.ts
│       ├── fixed-prompt.ts
│       ├── dynamic-context.ts
│       ├── session-instructions.ts
│       ├── assemble.ts
│       └── system-prompt.test.ts
├── models/
│   ├── provider.ts                              # 扩展 ModelTokenUsage
│   ├── openai-provider.ts                       # 解析缓存字段
│   └── openai-provider.test.ts
├── tools/
│   ├── read-file.ts
│   ├── write-file.ts
│   ├── edit-file.ts
│   ├── run-command.ts
│   ├── find-files.ts
│   ├── search-code.ts
│   └── registry.test.ts                         # 稳定定义与描述断言
└── web/
    ├── chat-contract.ts                         # 校验 modeTurn 与缓存事件
    ├── chat-contract.test.ts
    ├── prompt-environment.ts                    # 从受信任服务端状态构造环境白名单
    └── prompt-environment.test.ts
tests/
├── helpers/openai-mock.ts                       # 构造缓存 usage 事件
└── web-tool-agent.e2e.test.ts                   # 消息顺序与用量集成
docs/
└── evals/structured-system-prompt.md             # 典型任务人工对比表
```

不创建自定义指令加载器、Skill 管理器、记忆存储或 MCP 目录；可选输入只存在于核心组装契约与测试中。

## 安全与权限边界

- Route 只把 Workspace ID、显示名称、平台、日期、时区和固定路径语义传入提示；规范根路径仍只存在于 WorkspaceBoundary。
- 不读取或枚举 `process.env` 生成提示。日期与时区通过受控值构造，测试使用注入值，避免快照随机器漂移。
- 动态补充先做长度与格式校验，再转义 XML 保留字符；每类内容位于独立 system 消息，不能改变角色数组结构。
- `modeTurn` 只影响完整/精简文本选择，不参与 Plan/Do 权限、工具集合、最大迭代或停止判定。
- “编辑前读取”和“专用工具优先”是模型行为指令；实际文件与命令安全继续由参数校验、WorkspaceBoundary、受保护路径和命令沙箱强制。
- Provider 不记录原始 usage、认证头或上游正文；异常缓存字段只降级，不进入事件和 DOM。
- 人工对比使用专用临时 Workspace，不读取 `.env` 等保护内容，不将模型配置、密钥或绝对路径写入文档。

## 依赖决策

- 零新增运行时依赖。字符串拼装、实体转义、日期规范化、判别联合、累加与运行时校验均可由 TypeScript、Node.js 和现有 Web 平台能力完成。
- 不引入提示模板库、XML 库、Agent 框架、评估框架或缓存 SDK。标签格式简单且固定，专用小函数更易审查并避免间接引入禁止能力。
- 继续使用 OpenAI 兼容 Chat Completions 的隐式前缀缓存，不发送 Anthropic `cache_control`，也不增加 Provider 专属缓存配置。

## 技术决策

| 决策点 | 选择 | 理由 | 被否决方案 |
| --- | --- | --- | --- |
| 固定模块组织 | 七个独立常量模块 + 单一确定性组装器 | 满足职责拆分，顺序集中可测，固定内容不接触运行态 | 单一超长字符串难维护；运行时插件排序会损害稳定性 |
| 消息布局 | 固定 system 一条，动态类别各一条 system，历史随后追加 | 保留最长稳定前缀，角色语义清楚，缺失可选项可直接省略 | 拼成一个每轮变化的 system；伪装 user 消息 |
| 动态边界 | 固定 XML 风格标签 + 实体转义 | 人类与模型均可辨认，能阻止内容闭合标签 | 原样插值；依赖第三方模板/XML 库 |
| 强化周期 | 连续模式轮次 1、5、9……完整，其余精简 | 三个精简轮后重新强化，规则简单、确定、易测试 | 每轮完整浪费 Token；仅首轮完整易长期淡化；按 Agent 迭代改变会破坏同轮前缀 |
| 模式切换计数 | Web 显式维护 `modeTurn`，服务端严格校验但不用于授权 | 当前历史不记录旧模式，显式字段能在保留计划历史时重置计数 | 模式切换清空历史破坏现有工作流；从纯文本猜测模式不可靠 |
| Plan 工具稳定性 | Plan/Do 分别维持稳定定义集合 | 保留已批准的 Plan 最小暴露和服务端双重权限 | 所有模式都发送六工具虽更统一，但扩大 Plan 模型可见能力 |
| 环境信息 | 最小白名单，不提供绝对路径或环境变量 | 足够指导工具路径和时效判断，避免敏感信息泄漏 | 复制进程环境；把 Workspace 根路径交给模型 |
| 缓存数据模型 | 基础 Token 与缓存子信息分别标记可用性 | 兼容只报告基础 usage 的服务，不因可选字段丢数据 | 缺字段当零；缓存异常使整个响应失败 |
| 缓存字段兼容 | 标准 `cached_tokens` 优先，显式支持少量兼容别名 | 覆盖标准和常见兼容形态，同时避免猜测任意字段 | 扫描所有含 cache 的字段；供应商专用适配散落 UI |
| 人工对比 | 版本化任务表 + 同条件前后观察 | 能检查真实遵守行为且不把主观评估伪装成自动门禁 | 本阶段引入 LLM judge 或线上 A/B 系统 |

## 验证策略

- 核心单元测试：验证七模块完整性、固定顺序、单空行、重复组装稳定性、五类标签顺序、缺失可选项、转义和长度边界；覆盖完整/精简周期及模式重置输入。
- Agent 集成测试：捕获每次 Provider 请求，验证 system 消息始终位于历史前，同一用户请求的所有迭代前缀一致，既有工具结果只追加在末尾；提示错误发生在 Provider 与工具调用前。
- 工具测试：检查六工具名称/schema/顺序未变，描述含各自关键使用规则且没有环境或模式文本；保留模式权限测试。
- Provider 测试：覆盖标准缓存 Token、兼容数值、布尔命中、零、缺失、null、冲突、越界和完全无 usage，验证基础 Token 与缓存降级相互独立。
- Web 契约与 reducer 测试：覆盖 `modeTurn` 解析、模式切换/清空/Provider/Workspace 重置、请求失败后计数，以及各种缓存判别分支的 SSE 往返。
- 浏览器验证：桌面和窄屏检查 Token/缓存文案、Plan/Do 切换与控制台；使用可控 Provider 覆盖 tokens、status、unavailable，避免依赖真实缓存命中。
- 人工对比：在代码改动前后使用相同本地模型配置和重置后的临时 Workspace 执行六类任务，记录真实工具序列和最终文本；没有可用本地配置时保持未验证并说明原因。
- 完整回归依次执行 `npm run test`、`npm run lint`、`npm run typecheck`、`npm run build`；涉及 Web 的开发服务器和浏览器进程在结束后关闭。
