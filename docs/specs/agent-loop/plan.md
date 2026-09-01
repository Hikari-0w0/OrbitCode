# Agent Loop 与 Plan Mode Plan

状态：已批准
依据：已批准的 `spec.md`

## 架构概览

本轮用新的 `AgentLoop` 取代 Web 当前的 `SingleToolAgent`。循环核心只依赖模型抽象、模式化工具访问和工作区边界，通过统一 `AsyncIterable<AgentEvent>` 向上游报告过程；OpenAI Provider、工具调度、Web SSE 和 React 展示各自保持单一职责。

```text
ChatWorkspace（模式、历史、过程视图）
  → WebChatRequest / WebChatEvent
    → Next.js Route Handler（解析配置、组装依赖）
      → AgentLoop（循环、历史、停止条件、事件）
        ├→ ChatProvider
        │   └→ OpenAICompatibleProvider（SSE、多工具、Usage）
        └→ ToolScheduler
            └→ ModeToolPolicy（定义过滤 + 执行时复核）
                └→ ToolRegistry（校验、超时、本地执行）
```

`src/core/` 不导入 React、Next.js、浏览器组件或 OpenAI SSE 细节。Route Handler 只读取服务端配置、构造 Provider/Registry/Policy/Agent 并连接请求取消信号；Web handler 只把核心事件安全编码为 SSE。客户端依据事件维护可视状态，不自行推断工具权限、调度结果或停止原因。

CLI 继续使用现有 `InMemoryConversationSession`。共享模型消息扩展必须保持纯文本 CLI 行为与测试兼容，但本轮不把 `AgentLoop` 接到终端入口。

## 需求映射

| 需求 | 负责模块/交互 | 设计说明 |
| --- | --- | --- |
| F1 | `src/core/agent-loop.ts` | 用显式迭代状态机重复收集模型响应、执行工具、追加内部 transcript，直到终止。 |
| F2 | `src/core/agent-loop.ts`、`src/models/provider.ts` | Agent 在遍历 Provider 流时同步累计完整响应并立即转发文本；流结束后才依据完整集合决策。 |
| F3 | `src/models/openai-provider.ts` | 以调用索引维护多个 accumulator，严格校验标识、名称、参数、完成原因和调用数量上限。 |
| F4 | `src/core/tool-scheduler.ts`、`src/tools/mode-policy.ts` | 调度器按原顺序形成连续只读批次和单例非只读批次；只读批次受并发上限约束，结果最终恢复原顺序。 |
| F5 | `src/core/tool-scheduler.ts`、`src/tools/registry.ts` | 所有工具失败收敛为结构化结果；调度器只把取消和核心不变量破坏视为终止信号。 |
| F6 | `src/core/agent-loop.ts`、`src/web/server-config.ts` | 核心验证正整数与硬上限；Web 从本地环境解析可配置值，缺失使用默认 8，硬上限 32。 |
| F7 | `src/core/agent-events.ts`、`src/core/agent-loop.ts` | 单一 `stopped` 事件承载判别式停止原因、迭代数、副作用和安全详情。 |
| F8 | `src/web/chat-handler.ts`、`src/core/agent-loop.ts`、`src/core/tool-scheduler.ts` | 一个请求级 `AbortSignal` 贯穿模型、调度器和工具；每个新阶段启动前复查取消状态。 |
| F9 | `src/core/agent-events.ts` | 定义文本、调用确认、执行开始、结果、Usage、进度和停止事件的判别联合。 |
| F10 | `src/core/agent-loop.ts`、`src/models/provider.ts` | 内部 transcript 保存 system/assistant tool_calls/tool；成功后公开历史只提交普通用户与最终助手消息。 |
| F11 | `src/components/chat-workspace.tsx`、`src/web/chat-contract.ts` | 客户端拦截独立 `/plan`、`/do`，维护页面模式并随普通请求发送；清空、刷新和 Provider 切换恢复 Do。 |
| F12 | `src/tools/mode-policy.ts`、`src/app/api/chat/route.ts` | 模式策略既过滤 definitions，又在执行前基于底层注册信息区分允许、拒绝和未知。 |
| F13 | `src/components/message-list.tsx`、`chat-workspace.tsx`、`globals.css` | 以迭代和 callId 归并过程事件，展示模式、进度、Usage、工具状态、结果和终止原因。 |
| F14 | `src/tools/registry.ts`、`src/tools/mode-policy.ts`、`src/core/agent-loop.ts` | 未知工具返回独立 `unknown-tool` 结果并参与连续计数；模式拒绝返回 `permission-denied`，不计入未知。 |
| F15 | `src/models/openai-provider.ts`、`src/core/agent-loop.ts` | 不完整或不可信模型响应转为 provider 错误；Agent 停止且不调度该响应工具。 |
| F16 | `src/core/agent-loop.ts`、`src/web/chat-contract.ts`、客户端提交状态 | 核心保持 idle/running 互斥，Web 契约验证模式和历史，客户端生成期间禁用重复提交。 |

## 核心类型与接口

以下签名用于固定模块契约；字段可在实现中机械细化，但不得改变判别语义和依赖方向。

```ts
export type AgentMode = "plan" | "do";

export type AgentStopReason =
  | "final-response"
  | "max-iterations"
  | "cancelled"
  | "repeated-unknown-tool"
  | "model-error"
  | "agent-error";

export type AgentProgressPhase = "model" | "tools";

export type TokenUsage =
  | {
      readonly availability: "reported";
      readonly promptTokens: number;
      readonly completionTokens: number;
      readonly totalTokens: number;
    }
  | { readonly availability: "unavailable" };

export type AgentEvent =
  | {
      readonly type: "progress";
      readonly iteration: number;
      readonly maxIterations: number;
      readonly phase: AgentProgressPhase;
      readonly completedTools?: number;
      readonly totalTools?: number;
    }
  | {
      readonly type: "text-delta";
      readonly iteration: number;
      readonly text: string;
    }
  | {
      readonly type: "tool-call";
      readonly iteration: number;
      readonly call: ModelToolCall;
      readonly sequence: number;
    }
  | {
      readonly type: "tool-started";
      readonly iteration: number;
      readonly callId: string;
      readonly name: string;
      readonly sequence: number;
    }
  | {
      readonly type: "tool-result";
      readonly iteration: number;
      readonly callId: string;
      readonly name: string;
      readonly sequence: number;
      readonly result: ToolExecutionResult;
    }
  | {
      readonly type: "token-usage";
      readonly iteration: number;
      readonly usage: TokenUsage;
      readonly cumulative: TokenUsage;
    }
  | {
      readonly type: "stopped";
      readonly reason: AgentStopReason;
      readonly iterations: number;
      readonly sideEffect: SideEffectState;
      readonly finalMessage?: AssistantMessage;
      readonly detail?: string;
    };

export interface AgentSession {
  getHistory(): readonly PlainConversationMessage[];
  streamTurn(options: {
    readonly input: string;
    readonly mode: AgentMode;
    readonly signal: AbortSignal;
  }): AsyncIterable<AgentEvent>;
}

export type AgentLoopOptions = {
  readonly maxIterations: number;
  readonly unknownToolIterationLimit?: 2;
};
```

`stopped` 是唯一终端事件。只有 `reason: "final-response"` 时 `finalMessage` 必须存在并提交历史；其他原因不得提交本轮。`detail` 只允许安全、脱敏、面向用户的说明。调用者不得依赖生成器抛错来识别正常取消或受控停止。

模型层扩展为多调用和 Usage：

```ts
export type ModelTokenUsage = {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
};

export type ModelStreamEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "tool-call"; readonly call: ModelToolCall }
  | { readonly type: "usage"; readonly usage: ModelTokenUsage }
  | {
      readonly type: "done";
      readonly finishReason: "stop" | "tool-call";
    };

export type ConversationMessage =
  | { readonly role: "system"; readonly content: string }
  | PlainConversationMessage
  | {
      readonly role: "assistant";
      readonly content: string | null;
      readonly toolCalls: readonly ModelToolCall[];
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly content: string;
    };
```

Provider 每次响应最多接受 16 个工具调用。请求工具可用时发送 `parallel_tool_calls: true`，并请求流式 Usage；上游没有合法 Usage 事件时，Agent 为该迭代生成 `availability: "unavailable"`，不把缺失视为模型失败。

模式化工具访问与调度契约：

```ts
export type ToolAccessDecision =
  | { readonly kind: "allowed"; readonly mutability: ToolMutability }
  | { readonly kind: "denied" }
  | { readonly kind: "unknown" };

export interface ToolAccess {
  definitions(): readonly ModelToolDefinition[];
  classify(name: string): ToolAccessDecision;
  execute(
    name: string,
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}

export type ToolScheduleEvent =
  | { readonly type: "started"; /* call identity */ }
  | { readonly type: "result"; /* call identity + result */ }
  | {
      readonly type: "batch-completed";
      readonly orderedResults: readonly ToolCallResult[];
    };

export function scheduleToolCalls(options: {
  readonly calls: readonly ModelToolCall[];
  readonly access: ToolAccess;
  readonly context: ToolExecutionContext;
  readonly readOnlyConcurrency: number;
}): AsyncIterable<ToolScheduleEvent>;
```

`ModeToolPolicy` 包装完整 `ToolRegistry`：Plan 只允许 `read_file`、`find_files`、`search_code`；Do 允许全部已注册工具。`classify` 先检查底层注册中心是否存在，再检查模式允许集合，从而保证已注册但被模式禁止的工具不会被误记为未知。`execute` 必须重复相同判定，不能仅依赖 definitions 过滤。

## 状态与交互

```text
idle
  │ 用户输入 + mode + signal
  ▼
model(iteration n) ──流式转发文本/Usage并收集完整响应──┐
  │                                                    │
  ├─ 流/协议错误 ───────────────────────────────→ stopped(model-error)
  ├─ 无工具 + 非空最终文本 ─────────────────────→ stopped(final-response)
  ├─ 有工具 + n == max ─────────────────────────→ stopped(max-iterations)
  ├─ 连续未知工具达到 2 ─────────────────────────→ stopped(repeated-unknown-tool)
  └─ 有工具
       ▼
     tools（只读批次并发；其余单例串行）
       ├─ cancel ─────────────────────────────────→ stopped(cancelled)
       └─ 结果按原顺序追加 transcript
            └────────────────────────────────────→ model(iteration n + 1)
```

每次模型调用前发出 `progress(model)`；确认完整工具列表后按原顺序发出 `tool-call`；进入调度时发出 `progress(tools)`，并随结果更新完成数量。每个工具只发出至多一个 `tool-started` 和一个 `tool-result`。未知或模式拒绝不会真正启动工具，因此可以不发 `tool-started`，但必须发结构化 `tool-result`。

模型响应的收集规则：

1. Provider 流中的文本增量立即转换为 Agent 文本事件，同时追加到本迭代 assistant content。
2. 完整工具调用按 Provider 产出顺序收集；重复 callId、数量超限等由 Provider 在交给 Agent 前拒绝。
3. Usage 合法时记录本迭代值；重复或自相矛盾 Usage 是协议错误。没有 Usage 时生成 unavailable 事件。
4. 必须观察到且只观察到一个 `done`，并继续读取到传输结束，以接收位于 finish reason 之后、`[DONE]` 之前的 Usage。
5. 只有完整响应收集成功后才执行其中工具，避免流截断时根据半截参数产生副作用。

迭代上限按模型请求次数计数。第 `maxIterations` 次模型响应可以正常成为最终回复；若仍请求工具，发出调用确认和最大迭代停止事件，但不进入调度器。默认值为 8，核心硬上限为 32。Web 服务端从 `ORBITCODE_MAX_AGENT_ITERATIONS` 读取覆盖值；变量缺失使用默认值，空字符串、非十进制正整数、超过 32 均在发起模型请求前报错。客户端不能提交或覆盖此值。

连续未知工具按“请求工具的迭代”计数。完整响应中只要包含至少一个当前模式允许的已注册工具，本次计数归零；只有全部调用均为真正未知名称时才加一。达到二之前，未知调用生成 `unknown-tool` 结果并进入下一次模型请求；达到二时仍向 Web 发出对应安全结果，但不再调用模型。模式禁止的已注册工具生成 `permission-denied`，既不执行也不计入未知阈值，最终仍由模型纠正或最大迭代兜底。

副作用状态在所有工具结果之间按 `none < possible < applied` 聚合。模型错误、取消或其他停止事件携带当前聚合值，Web 据此决定是否追加“可能已产生本地变化”的提示。

## 模块设计

### Agent 事件与错误模型

- 职责：定义跨核心、Web 和测试使用的事件、进度、Usage、停止原因及不变量。
- 对外契约：`AgentEvent`、`AgentStopReason`、`AgentMode`、`TokenUsage`。
- 依赖：只依赖模型与工具领域类型，不依赖实现类。
- 错误处理：可控运行错误转成一次 `stopped`；输入为空或并发轮次等调用契约错误可在迭代开始前抛出 `ConversationStateError`，由入口转换为安全响应。

### Agent Loop

- 职责：维护公开历史、单轮内部 transcript、迭代计数、未知工具计数、副作用聚合和唯一终止事件。
- 对外契约：`AgentSession.streamTurn` 与 `getHistory`。
- 依赖：`ChatProvider`、`ToolAccess`、`scheduleToolCalls`、工作区和 Agent 类型。
- 错误处理：Provider 分类错误映射为 `model-error`；取消映射为 `cancelled`；不变量或未知异常映射为脱敏 `agent-error`。工具的结构化失败通常不终止循环。
- 模式提示：Plan 请求在内部 transcript 首部加入服务端固定 system 消息，要求只分析并输出计划；Do 使用执行型 system 消息。提示只改善模型行为，实际权限仍由 `ModeToolPolicy` 保证。

### 多工具 Provider

- 职责：发送 OpenAI 兼容 Chat Completions 请求，解析文本、多工具调用、finish reason、Usage 和 `[DONE]`。
- 对外契约：扩展后的 `ChatProvider`、`ConversationMessage`、`ModelStreamEvent`。
- 依赖：Fetch、现有 SSE 解析器和工具定义类型。
- 错误处理：网络、HTTP、取消、协议和流错误保持分类；不读取或透传不受限响应正文。多调用 accumulator 使用非负整数 index，最多 16 个，最终按 index 升序输出并要求 index 连续、callId 唯一、名称与标识完整。
- 兼容性：发送 `stream_options: { include_usage: true }`；兼容 Usage 缺失，但拒绝非法或重复 Usage。`choices: []` 仅在合法 Usage 事件或可忽略元数据中接受。

### 工具模式策略

- 职责：根据 Plan/Do 生成模型 definitions、分类调用并在执行入口二次强制权限。
- 对外契约：`ToolAccess` 和 `createModeToolPolicy(registry, mode)`。
- 依赖：完整 `ToolRegistry` 和工具 mutability/name 元数据。
- 错误处理：未知返回 `unknown-tool`；已注册但禁用返回 `permission-denied`；两者均为无副作用、可恢复结构化结果。

### 工具调度器

- 职责：在保留调用顺序语义的前提下执行多工具列表并流式报告生命周期。
- 对外契约：`scheduleToolCalls` 的异步事件流和有序最终结果。
- 依赖：`ToolAccess`、工具执行上下文和 AbortSignal。
- 调度：扫描原列表，最大连续只读段按最多 8 个一组并发；workspace-write、command、denied 和 unknown 各自作为单例边界顺序处理。并发结果事件可按实际完成顺序到达，但 `batch-completed.orderedResults` 必须恢复模型调用顺序。
- 错误处理：每个执行 Promise 都被收敛，避免 `Promise.all` 的早拒绝造成悬空任务；取消后等待运行中任务观察信号并收敛，不启动后续组。

### Web 契约与适配

- 职责：验证 `provider`、`mode`、普通历史和请求上限；把所有核心事件无损映射为运行时可验证的 SSE 数据。
- 对外契约：`WebChatRequest` 增加 `mode`；`WebChatEvent` 镜像安全的 Agent 事件字段。
- 依赖：核心事件和安全的工具结果类型。
- 错误处理：非法请求在创建 Agent 前返回 JSON 错误；流开始后的错误以唯一 `stopped(agent-error)` 收敛。连接断开时 abort 当前 Agent。

### Web 页面状态

- 职责：处理独立模式命令、发送请求、消费事件、按迭代/callId 更新助手过程卡片并只提交成功历史。
- 对外契约：`VisibleMessage` 扩展进度、Usage、stopReason；`VisibleToolExecution` 扩展 iteration、sequence 和 queued/skipped 状态。
- 依赖：Web 契约，不导入核心执行实现。
- 交互：输入严格等于 `/plan` 或 `/do` 时只切换本地模式并显示通知；模式切换在生成中不可用。清空会话和 Provider 切换同时恢复 Do。
- 错误处理：只有 `stopped(final-response)` 提交历史并标记完成；其他停止原因保留可见过程但不提交历史。客户端网络中断且未收到 stopped 时生成本地失败显示，不伪造核心停止原因。

## 文件组织

```text
src/
├── app/
│   ├── api/chat/route.ts                   # 改用 AgentLoop、模式策略和服务端迭代配置
│   └── globals.css                         # 模式、进度、Usage、多迭代工具视图样式
├── components/
│   ├── chat-workspace.tsx                  # 模式命令、事件归并、历史提交、停止展示
│   ├── chat-composer.tsx                   # 当前模式提示与命令可发现性
│   └── message-list.tsx                    # 多迭代工具、进度、Usage、停止原因视图
├── core/
│   ├── agent-events.ts                     # 新建：统一 Agent 事件与停止类型
│   ├── agent-loop.ts                       # 新建：ReAct 循环与公开历史
│   ├── agent-loop.test.ts                  # 新建：循环、停止、历史、取消测试
│   ├── tool-scheduler.ts                   # 新建：安全批次与并发调度
│   ├── tool-scheduler.test.ts              # 新建：时间重叠、顺序、取消测试
│   ├── single-tool-agent.ts                # 删除：由 AgentLoop 替代
│   ├── single-tool-agent.test.ts           # 删除：场景迁移到新测试
│   ├── conversation.ts                     # 适配扩展后的模型事件/消息类型
│   ├── conversation.test.ts                # 保证 CLI 纯文本路径兼容
│   └── errors.ts                           # Agent 停止所需安全错误映射
├── models/
│   ├── provider.ts                         # 多调用消息、Usage 与流事件契约
│   ├── openai-provider.ts                  # 多 accumulator、Usage、并行工具请求
│   └── openai-provider.test.ts             # 多工具、Usage、协议与兼容测试
├── tools/
│   ├── types.ts                            # unknown-tool 与共享 mutability 类型
│   ├── registry.ts                         # 安全查询工具元数据并保留统一执行
│   ├── registry.test.ts                    # 未知分类与元数据查询测试
│   ├── mode-policy.ts                      # 新建：Plan/Do 双重权限过滤
│   └── mode-policy.test.ts                 # 新建：定义与执行权限测试
└── web/
    ├── chat-contract.ts                    # mode 与完整 Agent SSE 契约
    ├── chat-contract.test.ts               # 请求/事件运行时校验
    ├── chat-handler.ts                     # AgentEvent 到 WebChatEvent 适配和取消
    ├── chat-handler.test.ts                # 全事件映射、唯一停止与断开测试
    ├── server-config.ts                    # 服务端最大迭代环境配置
    └── server-config.test.ts               # 默认、覆盖和非法配置测试
tests/
├── helpers/openai-mock.ts                  # 多工具与 Usage 流测试辅助
└── web-tool-agent.e2e.test.ts              # 升级为多迭代 Web Agent 集成场景
.env.example                                # 可选 ORBITCODE_MAX_AGENT_ITERATIONS 示例
README.md                                   # Agent Loop、Plan/Do、停止条件和配置说明
```

只在实际迁移完成后删除单次 Agent 文件，不提前留下兼容包装层；仓库内所有引用必须在同一任务中切换到 `AgentLoop`。

## 安全与权限边界

- 模式权限以服务端 `ModeToolPolicy` 为准。客户端 mode、模型提示和发送给模型的 definitions 都不能绕过执行时复核。
- Plan 固定只允许 `read_file`、`find_files`、`search_code`；底层存在但不允许的工具返回 `permission-denied`，不会调用其参数解析或 execute。
- 工具元数据只能由注册中心提供；模型给出的名称不能自行声明 mutability。未知工具永远按无副作用合成失败处理。
- 有副作用工具串行且与其他工具不重叠。取消后不启动剩余副作用调用；已运行工具沿用现有 `possible/applied` 状态，不宣称回滚。
- 最大迭代、工具调用数和只读并发数均有核心硬上限。客户端没有提高这些值的字段。
- 工具参数仍在注册中心执行前校验，路径、受保护文件、符号链接、命令沙箱、环境过滤、输出截断、超时和进程清理沿用现有实现。
- system 模式提示由服务端生成，不接受浏览器传入 system/tool/tool_calls 历史，防止客户端伪造内部 transcript。
- Provider 不在错误中包含响应正文、Authorization 或 API Key。Usage 只包含非负整数计数，不透传任意上游字段。
- Web 事件运行时解析采用精确字段白名单；工具名称在显示层允许安全字符串，但仍限制长度和字符集，避免未知名称破坏协议或界面。

## 依赖决策

- 不新增运行时或开发依赖。
- 多工具 accumulator 使用 `Map`，并发调度使用 `Promise` 与异步生成器，取消使用现有 `AbortController`，流传输继续使用 `ReadableStream` 与 SSE；标准库和现有代码足以完成。
- 不修改 YAML Provider schema，避免影响 CLI 配置兼容性。最大迭代作为 Web 服务端本地环境配置 `ORBITCODE_MAX_AGENT_ITERATIONS`，由现有 `.env` 加载机制读取。
- 不引入并发池库；固定上限 8 的只读分块足够简单，可直接实现并精确测试。

## 技术决策

| 决策点 | 选择 | 理由 | 被否决方案 |
| --- | --- | --- | --- |
| 终端语义 | 单一 `stopped` 事件 + 判别原因 | 防止 completed/failed/cancelled 多终端分支漂移，Web 可统一处理 | 保留多个终端事件，容易重复或遗漏停止原因 |
| 循环计数 | 每次完整模型请求算一次迭代 | 可直接限制最昂贵且决定行为的操作，边界可测试 | 按工具数计数，无法约束纯模型重试；按工具批次计数，语义含混 |
| 上限末次工具 | 确认调用但不执行 | 避免产生无法再由模型解释的新副作用 | 执行后直接停止，会留下缺少最终说明的副作用；静默忽略，页面不可解释 |
| 多工具调度 | 连续只读段并发，其他调用单例串行 | 保留模型顺序语义，避免读跨越写产生陈旧观察 | 收集所有只读先跑，会改变读写顺序；全部串行，不满足并发要求 |
| 并发结果 | 生命周期按实际完成流出，模型结果按调用顺序写回 | 兼顾实时性与协议确定性 | 强制结果事件顺序会隐藏真实完成状态；按完成顺序写回会改变调用对应关系 |
| Plan/Do | 客户端显式切换 + 服务端提示 + 服务端策略双检 | 用户可见、模型可理解、执行不可绕过 | 只靠提示词不安全；裸 `/do` 自动执行最近计划存在隐式副作用 |
| 未知与禁用 | 分开分类 | 连续未知停止不会误伤合法但当前模式禁用的工具 | 都映射 invalid-arguments，无法正确计数和解释权限 |
| Token Usage | 请求上游 Usage；缺失显式 unavailable | 不伪造数据，同时满足兼容服务缺失 usage 的情况 | 本地估算不准确；缺失即失败会降低兼容性 |
| 配置位置 | 环境变量覆盖，核心常量提供默认和硬上限 | 不改变现有 YAML/CLI 公共格式，客户端不能抬高上限 | Web 请求字段可被客户端任意调高；修改 Provider YAML 扩大配置迁移范围 |
| 单次 Agent 迁移 | 删除并由 AgentLoop 直接替换 | 避免两套编排状态机长期漂移 | 在 SingleToolAgent 外再套循环会重复历史和终止逻辑 |

## 验证策略

- 核心单元测试使用脚本化 Provider 与内存/临时工具，覆盖直接回复、多迭代、工具失败恢复、最终历史、所有停止原因、未知计数重置、最大迭代末批不执行、并发轮次拒绝和各阶段取消。
- 调度器测试记录每个工具的开始/结束时间与序列，证明只读重叠、有副作用不重叠、并发上限、原序结果、取消后不启动后续组。
- Provider 测试使用现有本地 HTTP/SSE mock，覆盖多 index 跨事件和跨网络块拼接、文本混合、Usage 位置与缺失、重复标识、稀疏索引、超量调用、错误 finish、完成后事件、截断和取消，并检查请求开启 `parallel_tool_calls` 与 Usage。
- 模式策略测试同时检查 definitions 与 execute，使用会记录副作用的假工具证明 Plan 禁止项没有进入参数解析或执行。
- Web 契约和 handler 测试验证 mode 精确字段、全事件 round-trip、未知安全工具名、请求取消、唯一 stopped 以及脱敏错误。
- Web 集成测试通过可控模型完成至少三次模型请求和混合工具批次，检查内部 transcript、SSE 顺序、历史提交与停止路径，不使用真实凭据。
- 页面完成后依次运行 `npm run lint`、`npm run typecheck`、`npm run build`，启动开发服务器并用 `agent-browser` 检查桌面/移动视图、模式切换、实时进度、工具卡、停止原因、错误覆盖层和控制台。
- Agent 主流程可运行后，在 tmux 中启动 Web 服务及安全的本地模拟模型，通过浏览器或 HTTP 客户端完成多迭代闭环和异常路径；真实模型场景仅在用户已有未入库配置可用时执行，且不记录凭据。CLI 原有端到端测试继续通过，但不把 CLI 当成本轮 Agent 入口。
