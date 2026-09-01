# 上下文管理 Plan

状态：已批准
依据：已批准的同目录 `spec.md`

## 架构概览

采用独立 Context Session 作为模型内部历史的事实来源。Web UI 仍维护可见消息，但聊天请求只提交本轮用户输入和 `contextSessionId`；服务端 Context Session 保存完整的用户、助手、工具调用和工具结果 transcript。权限会话保持原职责，Context Session 不复用或修改其授权状态。

`src/core/context/` 负责消息分组、Token 估算、轻量卸载决策、重量摘要、状态机和熔断；它只依赖通用 `ChatProvider` 契约与 `ContextStore` 接口。`src/lib/` 提供 Node 本地文件存储实现。`src/tools/` 提供只读 `read_context` 能力。`src/web/` 和 Route Handler 负责会话生命周期、严格 HTTP 合约与核心装配；React 只展示状态并发起操作。

```text
Web UI ── input/contextSessionId ──> Route Handler
  │                                      │
  │                                      ├── Permission Session（现有授权）
  │                                      └── Context Session Manager
  │                                                │
  │                                      Agent Loop + Context Manager
  │                                        │                 │
  │                              workspace tools      ContextStore 接口
  │                                        │                 │
  │                                权限系统（现有）    本地文件实现
  │
  └── manual compress/status <──────── Context API

Context Manager ──普通/摘要请求──> ChatProvider 抽象 ──> OpenAI 兼容实现
```

依赖方向固定为：`app/components → web → core → models/tools 抽象`，`lib` 实现核心定义的存储端口。`src/core/context/` 不导入 React、Next.js、具体 Route 或 `OpenAICompatibleProvider`。

## 需求映射

| 需求 | 负责模块/交互 | 设计说明 |
| --- | --- | --- |
| F1 | `src/core/context/token-estimator.ts`、Agent usage 回写 | 保存普通 Agent prompt usage 锚点及对应 revision，对变更账本做增量估算；摘要 usage 独立记录。 |
| F2 | `lightweight-compaction.ts`、`ContextStore` | 单结果超阈值即保存完整序列化内容，并把 payload 转为有界预览与引用。 |
| F3 | `lightweight-compaction.ts` | 对一个 assistant tool-call group 的内联结果按估算体积稳定降序处理，保持消息位置和 toolCallId。 |
| F4 | `context-manager.ts`、`agent-loop.ts` | 每次普通模型调用前严格执行 light → estimate → optional heavy；单调用点只允许一次 heavy。 |
| F5 | `message-groups.ts`、`heavy-compaction.ts` | 从尾部选择合法消息组，满足 10K 目标和最少 5 条；早期用户原文旁路保留，非用户内容被摘要替换。 |
| F6 | `summary-prompt.ts`、`summary-parser.ts` | 固定七节 JSON 结构包含临时 `analysisDraft` 与正式 `summary`；提交时丢弃草稿。 |
| F7 | `tool-free-summary-generator.ts` | 核心直接以 `toolChoice: "none"` 且无 tools 调通用 Provider，拒绝任何 tool-call 事件。 |
| F8 | `heavy-compaction.ts` | 成功提交固定 system boundary，并保证最多一条当前边界消息。 |
| F9 | `context-manager.ts`、`context-errors.ts` | 连续失败计数、三次熔断、自动禁试、手动恢复；历史以事务快照提交。 |
| F10 | `src/tools/read-context.ts`、本地 store | 会话能力引用 + offset/limit 分块读取；独立于 Workspace 文件权限，不能读取任意路径。 |
| F11 | Context API、Web contract、React 控件 | 手动压缩 POST 返回状态与前后估算，客户端 reducer 呈现并发/错误状态。 |
| F12 | `models/config.ts`、示例配置、`server-config.ts` | Provider 级严格解析上下文窗口和阈值，检查全部数值关系。 |
| F13 | `context-session-manager.ts`、聊天/上下文 routes | 独立会话绑定、互斥 lease、成功提交/失败回滚、TTL 与关闭清理。 |

## 核心类型与接口

```ts
export type ManagedContextMessage =
  | { readonly kind: "system"; readonly id: string; readonly content: string }
  | { readonly kind: "user"; readonly id: string; readonly content: string }
  | { readonly kind: "assistant"; readonly id: string; readonly content: string }
  | {
      readonly kind: "assistant-tool-call";
      readonly id: string;
      readonly content: string | null;
      readonly toolCalls: readonly ModelToolCall[];
    }
  | {
      readonly kind: "tool-result";
      readonly id: string;
      readonly toolCallId: string;
      readonly payload: ContextPayload;
    }
  | { readonly kind: "summary"; readonly id: string; readonly summary: ContextSummary }
  | { readonly kind: "boundary"; readonly id: string; readonly content: string };

export type ContextPayload =
  | { readonly storage: "inline"; readonly content: string }
  | {
      readonly storage: "offloaded";
      readonly reference: string;
      readonly preview: string;
      readonly originalBytes: number;
      readonly estimatedTokens: number;
    };

export type TokenEstimate =
  | {
      readonly source: "usage-anchor";
      readonly tokens: number;
      readonly anchorPromptTokens: number;
      readonly estimatedDeltaTokens: number;
    }
  | { readonly source: "approximation"; readonly tokens: number };

export type ContextCompressionState =
  | { readonly status: "idle" }
  | { readonly status: "running-agent" }
  | { readonly status: "compressing"; readonly trigger: "automatic" | "manual"; readonly before: TokenEstimate }
  | { readonly status: "succeeded"; readonly trigger: "automatic" | "manual"; readonly before: TokenEstimate; readonly after: TokenEstimate }
  | { readonly status: "failed"; readonly trigger: "automatic" | "manual"; readonly before: TokenEstimate; readonly failure: ContextFailure; readonly consecutiveSummaryFailures: number }
  | { readonly status: "circuit-open"; readonly failure: ContextFailure; readonly consecutiveSummaryFailures: 3 };

export type ContextFailure =
  | { readonly kind: "summary-network" | "summary-protocol" | "summary-format"; readonly message: string }
  | { readonly kind: "storage" | "capacity" | "concurrent" | "session" | "cancelled"; readonly message: string };

export interface ContextStore {
  write(input: { readonly sessionId: string; readonly content: string }): Promise<StoredContextReference>;
  read(input: { readonly sessionId: string; readonly reference: string; readonly offset: number; readonly limit: number }): Promise<ContextChunk>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface ContextController {
  prepareForModel(input: { readonly signal: AbortSignal }): Promise<PreparedModelContext>;
  recordAgentUsage(input: { readonly promptTokens: number; readonly revision: number }): void;
  compressManually(signal: AbortSignal): Promise<CompressionReport>;
  beginTurn(userContent: string): ContextTurnTransaction;
  snapshot(): ContextSnapshot;
}
```

### 关键不变量

- `revision` 每次消息添加、删除、替换或卸载递增；usage 锚点只对应产生该 usage 的普通 Agent 请求 revision。
- `analysisDraft` 只存在于摘要响应解析的局部对象，不能进入 `ManagedContextMessage`。
- 一个 `assistant-tool-call` 与其后相同 `toolCallId` 集合的 `tool-result` 构成原子组；压缩选择不能拆组。
- 用户消息 content 永不由压缩器修改。旧用户消息可位于摘要之前，但不会被摘要节点替换。
- `ContextTurnTransaction` 只有最终回复成功时才提交本轮新增 transcript、自动卸载、自动摘要与新 usage 锚点；失败、取消和安全停止恢复轮次开始时的历史与锚点，并清理本轮产生但未提交的存储引用。连续摘要失败计数属于会话控制状态，不随历史事务回滚。手动压缩不属于 Agent turn，成功后直接原子提交。
- 普通 Agent usage 与摘要 usage 分账；只有前者能成为下一次整体估算锚点。

## Token 估算与预算

`TokenEstimator` 维护最近一次普通 Agent 请求的 `promptTokens`、请求 revision 与当时参与请求的可估算字节基线。之后的消息账本变更记录正负字节差，使用 `max(codePointCount / 4, utf8ByteLength / 4)` 向上取整作为默认近似；固定系统提示和工具定义变化同样进入 delta。配置可覆盖近似比例，但估算结果始终标注来源。

触发规则：

```text
每次普通模型调用前
  → 卸载单个超限结果
  → 检查每个工具组总量并继续按体积卸载
  → 重新估算整体输入
  → estimate >= window - 13K（默认）？自动重量压缩 : 直接调用模型
```

自动摘要输入必须控制在 `contextWindow - automaticReserveTokens` 内；手动摘要输入控制在 `contextWindow - manualReserveTokens` 内。手动操作无须先达到自动触发线。重量压缩完成后按“移除内容估算 - 新摘要与边界估算”更新 delta，下一次普通 Agent usage 再校准锚点。

若 Provider 不返回 usage，则每次全量近似；UI 和事件中不得使用 `reported` 字样。若估算已越过安全线而摘要失败或不可执行，普通模型调用不发生。

## 轻量压缩

1. 把工具执行结果按发送给模型的规范 JSON 序列化，先检查单结果阈值。
2. 超阈值时将完整字符串写入 `ContextStore`；写入成功后才原子替换为 offloaded payload。写入失败保持原内容并返回存储错误。
3. 对每个工具组计算仍内联的结果总量。超限时按“估算 Token 降序、原序号升序”选择，逐个卸载至阈值内。
4. 模型可见占位内容包含：`offloaded` 标志、工具名、原始字节数、估算 Token、有界头尾预览、`context://<opaque>` 引用和 `read_context` 分块读取提示。
5. 已卸载 payload 幂等跳过，不重复写文件；用户、普通助手和系统消息不参与轻量卸载。

## 重量压缩与摘要协议

### 近期尾部选择

- 从尾部按原子消息组向前累计，先满足至少 5 条原始消息，再尽量接近 `recentMessagesTargetTokens`。
- 一个工具组跨过预算边界时保留整个组；因此实际尾部可略高于目标。
- 旧区域的完整消息都会作为摘要证据输入，使摘要能准确提取任务目标；提交候选时，用户消息仍按原顺序逐字保留，只有旧区域的助手、工具、既有摘要和边界由新摘要替换。
- 若没有可替换的非用户旧内容，或替换后仍无法低于安全预算，返回 `capacity`，不提交无收益压缩。

### 摘要请求与解析

摘要 Prompt 要求返回单个严格 JSON 对象：

```ts
type SummaryEnvelope = {
  readonly analysisDraft: string;
  readonly summary: {
    readonly taskGoals: readonly string[];
    readonly completedWork: readonly string[];
    readonly keyDecisions: readonly string[];
    readonly fileChanges: readonly string[];
    readonly toolResults: readonly string[];
    readonly errors: readonly string[];
    readonly nextSteps: readonly string[];
  };
};
```

七个正式字段必须全部存在、为有界字符串数组且无未知字段；允许以空数组表达“无”。核心生成器调用 `ChatProvider.stream` 时不传 `tools` 并固定 `toolChoice: "none"`，只接受文本、usage 和 `finishReason: stop`。任何工具事件、多次 usage、非 stop、空文本、非法 JSON、未知字段或超长章节都归类为一次摘要失败。解析后立即丢弃 `analysisDraft`，只把渲染后的固定七节摘要写入 managed history。

成功后的模型顺序为：较早用户原文、新结构化摘要、系统边界、近期原始组。已有旧摘要被合并进新摘要，不无限堆叠；边界消息保持唯一。

## 状态与交互

### 自动模型调用

```text
idle context session
  → acquire agent lease
  → begin transactional turn
  → before each model call: prepareForModel
       ├─ light/store failure → stop context-error
       ├─ below trigger → provider.stream(auto tools)
       ├─ heavy success → provider.stream(auto tools)
       ├─ heavy failure #1/#2 → stop context-error
       ├─ heavy failure #3 → circuit-open + stop
       └─ circuit already open and heavy required → stop without summary request
  → final-response: commit turn history/compaction/anchor + release lease
  → other stop/cancel/error: rollback turn history/compaction/anchor, cleanup provisional refs, release lease
```

### 手动压缩

```text
idle → acquire manual lease → status compressing
  ├─ success → status succeeded(before, after), failures=0
  ├─ failure → status failed/circuit-open, history unchanged
  └─ abort → status failed(cancelled)
release lease → session remains usable
```

手动操作在熔断后仍允许一次显式尝试；不会在一次点击内重试。Agent 活跃、另一压缩活跃、绑定不符或会话关闭时均返回 409 类结构化错误。

## 模块设计

### `src/core/context/`

- 职责：纯领域类型、消息合法分组、估算、两层压缩、摘要生成协议、状态机、事务与熔断。
- 对外契约：`ContextController`、`ContextStore`、`ContextSnapshot`、`CompressionReport`。
- 依赖：通用 `ChatProvider` 和 Provider 消息/usage 类型；不得依赖 OpenAI 实现、Web 或 React。
- 错误处理：所有预期失败转为 `ContextFailure`；历史修改采用先构造候选、校验、再提交。

### `src/lib/local-context-store.ts`

- 职责：以 Node 标准库在 `os.homedir()/.orbitcode/context-v1` 应用私有根目录下原子写入、分块读取、会话删除和过期目录清理。
- 对外契约：实现 `ContextStore`；真实路径只在此模块内存在。
- 安全：根目录/会话目录使用仅当前用户可访问权限，内容文件使用仅当前用户可读写权限；会话目录和文件名由服务端 UUID/随机字节生成；解析引用后再次校验所属会话和真实路径；拒绝符号链接、`..`、绝对路径与超限读取。
- 错误处理：底层错误映射为不含绝对路径的存储错误。

### Agent Loop 集成

- 职责：把系统提示、会话历史和本轮工作 transcript 交给 Context Controller；在每个 `collectModelResponse` 前 prepare；把 usage 回写；成功提交事务。
- 依赖：Context Controller 接口，不感知本地文件路径和 Web 状态。
- 错误处理：新增上下文专用停止原因，保持 `stopped` 仍是唯一终止事件。

### `read_context` 工具

- 职责：校验 `{ reference, offset, limit }` 并读取当前 Context Session 的内容块，返回 chunk、范围和是否还有后续。
- 安全边界：它是会话能力读取，不是 Workspace 文件读取；仅允许当前 Agent 绑定的 Context Reader，Plan/Do 均可用，不触发或修改现有路径/命令权限规则。工具调度层对这类内部只读能力作显式分流，其他工具仍全部走现有权限网关。
- 错误处理：非法/跨会话/过期引用返回新的结构化 `context-reference` 错误，不暴露存在性差异或真实路径。

### Web Context Session 与 API

- 职责：按创建请求中的 Workspace/Provider 完成首次绑定，再提供互斥、快照、手动压缩、关闭和 TTL；Route 只装配 Provider、Workspace、Context Store 和 Agent。
- 对外契约：创建/查看/关闭 Context Session；手动压缩 endpoint；聊天请求携带 `contextSessionId` 与单条用户输入。
- 依赖：`src/web/` 调用核心，不把 Request/Response 传入核心。
- 错误处理：严格 body、ID、Origin、大小和 exact-fields 校验；409 表示并发/绑定冲突，404 表示失效会话，422/503 表示配置或压缩失败。

### React 状态与展示

- 职责：并行创建权限会话和上下文会话；在切换/清空/卸载时关闭二者；展示手动压缩按钮、状态、前后 Token 与错误。
- 依赖：只依赖 Web contract；不包含压缩算法或文件逻辑。
- 错误处理：请求中止不伪装成功；会话失效时提示清空并重新创建，保留当前可见消息直到用户确认重置动作。

## 文件组织

```text
src/
├── app/api/
│   ├── chat/route.ts
│   └── context-sessions/
│       ├── route.ts
│       └── [sessionId]/
│           ├── route.ts
│           └── compress/route.ts
├── components/
│   ├── chat-session-state.ts
│   ├── chat-session-state.test.ts
│   ├── chat-workspace.tsx
│   ├── chat-workspace.test.tsx
│   └── context-compression-control.tsx
├── core/
│   ├── agent-events.ts
│   ├── agent-loop.ts
│   ├── agent-loop.test.ts
│   └── context/
│       ├── types.ts
│       ├── context-errors.ts
│       ├── message-groups.ts
│       ├── token-estimator.ts
│       ├── lightweight-compaction.ts
│       ├── heavy-compaction.ts
│       ├── summary-prompt.ts
│       ├── summary-parser.ts
│       ├── tool-free-summary-generator.ts
│       ├── context-manager.ts
│       └── *.test.ts
├── lib/
│   ├── local-context-store.ts
│   └── local-context-store.test.ts
├── models/
│   ├── config.ts
│   └── config.test.ts
├── tools/
│   ├── default-registry.ts
│   ├── mode-policy.ts
│   ├── read-context.ts
│   ├── read-context.test.ts
│   ├── tool-scheduler.ts
│   └── types.ts
└── web/
    ├── chat-contract.ts
    ├── chat-contract.test.ts
    ├── context-session-manager.ts
    ├── context-session-manager.test.ts
    ├── context-session-store.ts
    ├── server-config.ts
    └── server-config.test.ts

orbitcode.example.yaml
README.md
tests/web-context-management.e2e.test.ts
```

实际实现时允许把高度内聚的小文件合并，但不得改变上述职责和依赖方向；不创建空模块。

## 安全与权限边界

- Context Store 根目录位于应用私有、仓库外位置；引用只含版本、会话作用域和随机对象 ID，不含绝对路径。
- 写入使用临时文件 + 原子 rename，权限尽可能限制为当前用户；读取拒绝符号链接并校验 realpath 仍在会话目录内。
- `read_context` 只接受当前 Context Session 注入的 reader，最大单次读取量有硬上限；返回内容仍会在下一次模型调用前接受轻量阈值检查。
- 摘要请求不公开工具定义，核心固定 `toolChoice: "none"` 并拒绝工具事件。
- UI 与 SSE 只展示摘要状态、估算和安全错误；不展示本地路径、完整卸载内容或未脱敏工具参数。
- 上下文会话绑定 Workspace/Provider，独立 ID 不接受路径；聊天 Route 同时取得 Context 与 Permission turn lease，任一失败时释放已取得 lease。
- 现有危险命令、路径解析、敏感文件和权限规则代码不因 Context Session 而放宽；内部读取能力采用单独的会话 capability 校验。

## 配置设计

在每个 Provider 增加严格的 `context` 对象：

```yaml
providers:
  - name: primary
    protocol: openai
    model: your-model
    base_url: https://api.openai.com/v1
    api_key: MODEL_API_KEY
    context:
      window_tokens: 128000
      single_tool_result_tokens: 8000
      tool_result_group_tokens: 12000
      recent_messages_tokens: 10000
      automatic_reserve_tokens: 13000
      manual_reserve_tokens: 3000
      preview_chars: 2000
```

`window_tokens` 必填，避免把某个模型窗口写成全局事实；其余字段可省略并使用模型无关策略默认值。校验至少满足：全部为安全正整数、group ≥ single、automatic reserve > manual reserve、window > automatic reserve + recent target，并为预览和各阈值设置合理硬上限以防配置导致内存滥用。

## 依赖决策

- 零新增运行时依赖。
- Token 估算使用 `TextEncoder`/Node Buffer 与标准数学运算；本地存储使用 `node:fs/promises`、`node:path`、`node:crypto`。
- 严格 JSON 解析沿用项目现有手写运行时校验风格，不引入 schema 库。
- 不使用 LangChain、Agents SDK、托管 Files API 或 Code Interpreter。

## 技术决策

| 决策点 | 选择 | 理由 | 被否决方案 |
| --- | --- | --- | --- |
| 历史事实来源 | 独立服务端 Context Session | 能一致保存工具 transcript、usage 锚点、熔断和引用作用域 | 浏览器回传完整历史无法可信维护内部消息和熔断；复用权限会话会耦合状态机 |
| 用户消息处理 | 永不摘要改写 | 满足原文保护，避免摘要扭曲需求 | 对全部旧历史整体摘要会丢失用户措辞和约束 |
| 大结果存储 | 仓库外应用私有文件 + opaque reference | 天然未入库，不污染任意 Workspace，路径不暴露 | 写入 Workspace 需改外部 `.gitignore`；直接暴露绝对路径破坏边界 |
| 重新读取 | `read_context` 分块能力 | 可控、可审计，不授予任意文件权限 | 复用 `read_file` 无法安全读取 Workspace 外存储 |
| 摘要调用 | 核心通过通用 Provider 硬编码禁用工具 | 与 OpenAI 实现解耦且约束可测试 | 只在 Prompt 说“不用工具”不能强制；单独 SDK 会引入耦合 |
| 压缩提交 | 候选历史校验后原子替换 | 失败保留原历史，便于重试 | 边生成边删除会在错误时损坏会话 |
| 熔断恢复 | 自动三次熔断，手动单次可探测恢复 | 避免 Agent Loop 死循环，同时给用户显式恢复入口 | 永久封死需新会话；自动后台探测会继续消耗 Token |
| 模型窗口 | Provider 配置必填 | 多 Provider 窗口不同，不能从模型名猜测 | 固定 128K 或在线查询都不可靠且增加耦合 |

## 验证策略

- 核心单元测试：估算锚点、稳定卸载顺序、工具组原子性、近期尾部选择、用户原文、摘要解析、工具禁用、历史原子提交、三次熔断与手动恢复。
- 存储/工具测试：临时目录内原子写读、分块、会话隔离、伪造/路径穿越/符号链接、清理和取消。
- Agent 集成测试：每次 provider 调用前的处理顺序、usage 回写、工具 transcript 跨迭代/跨成功轮次、失败回滚和专用停止原因。
- Web 合约/会话测试：创建、绑定、互斥、手动压缩响应、严格字段/大小/Origin、上下文与权限 lease 的清理。
- React 测试：按钮禁用矩阵、状态文案、前后 Token、错误与会话重建。
- 浏览器验证：真实页面手动压缩成功/失败、控制台和 Next 错误覆盖层。
- tmux 端到端：使用不含真实凭据的本地 OpenAI 兼容替身覆盖大工具结果、自动摘要、手动摘要、三次失败熔断和继续工作。

## 草案自检

- F1–F13 均在需求映射中有明确模块。
- 核心层不依赖 React、Next.js 或 OpenAI 具体实现；摘要禁用工具由核心调用路径保证。
- 上下文与权限会话分离，现有权限规则语义保持不变。
- 所有失败、取消、容量和熔断路径均有终止行为，且零新增依赖。
