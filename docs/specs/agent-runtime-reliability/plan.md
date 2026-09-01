# Agent 运行可靠性、效率与对话并发安全 Plan

状态：已批准
依据：已批准的 `spec.md`

## 架构概览

本轮沿用现有“页面/入口调用核心，核心调用模型与工具抽象”的依赖方向，分成六个协作边界：

1. `src/models/` 负责单次模型请求的阶段事件、统一容量、Provider trace、分阶段超时和安全传输重试，不判断 Agent 是否应继续任务。
2. `src/core/` 负责 Agent 迭代、工具失败预算、验证证据、运行终止和模型活动上下文的效率压缩，不依赖 React 或 Next.js。
3. `src/tools/` 负责命令语义预检、批量文件写入、受管进程、完成报告、权限目标和本地执行；所有能力继续通过现有 Registry、Scheduler、Permission Gateway 与 Workspace Boundary。
4. `src/lib/` 负责本地会话租约、恢复标记和运行日志的原子存储，不向 API 暴露底层错误原因。
5. `src/web/` 与 `src/app/api/` 负责把会话写操作纳入统一操作守卫、显式恢复中断轮次、传递流式事件并持久化终止状态。
6. `src/components/` 只解释 Web 合约、收敛加载状态和渲染紧凑时间线，不承载重试、熔断、锁或进程生命周期规则。

核心依赖保持单向：

```text
React / API routes
        ↓
Web orchestration ──→ local persistence / run log
        ↓
AgentLoop ──→ ContextManager
    ↓              ↓
ChatProvider    ContextStore
    ↓
ToolScheduler ──→ ToolRegistry ──→ Workspace / sandbox / managed process
```

## 需求映射

| 需求 | 负责模块/交互 | 设计说明 |
| --- | --- | --- |
| F1 | 会话存储、操作守卫、详情/恢复 API | 详情读取只检查活动状态，不写修订；独立恢复写操作先取得会话租约并确认原所有者失效。 |
| F2 | 统一会话操作守卫、所有会话修改路由 | Agent、压缩、重命名、清空、删除和恢复使用相同进程内操作状态与跨进程写租约。 |
| F3 | `chat-workspace` 加载状态机 | 加载使用 `try/catch/finally` 收敛到 ready/error/cancelled，事件入口自行消费失败并保留旧快照。 |
| F4 | 存储错误归一化、API 错误映射、README | 内部 cause 与公开消息分离；对外只返回稳定错误码和安全提示，统一绑定切换说明。 |
| F5 | Provider 阶段事件、Agent/Web 合约、进度 UI | 流式解析报告首字节、文字、工具参数和收尾阶段；UI 只显示名称、规模与耗时。 |
| F6 | Provider transport policy、Agent 终止路径 | 首字节/空闲/总时长分别取消；仅首个语义增量前的暂时错误自动重试，其他失败持久化后交给用户继续。 |
| F7 | Agent 事件、运行追踪器、本地日志/导出 | 记录每次模型 attempt 的 trace、阶段耗时、参数规模、重试和结果分类，日志 schema 版本化。 |
| F8 | 命令预检、Schema/Registry 错误 | 精确 schema 继续拦截字段问题；命令预检在授权和执行前识别 JSON 命令、整串引号和重复 cwd。 |
| F9 | `ToolFailureBudget`、Agent Loop | 按精确错误、同工具同类错误和轮次总失败三层计数；到限后发出熔断终止或要求替代方案。 |
| F10 | `ManagedProcessController` 与三个进程工具 | 受管进程启动时可等待本机端口，之后可查状态/增量日志和停止；Agent 结束统一清理。 |
| F11 | 多调用 Scheduler、`write_files`、多目标权限 | 保留只读并发和副作用串行，增加有界批量写入与逐项结果；所有路径在执行前完成授权和校验。 |
| F12 | `operational-compaction`、Context Manager | 在阶段阈值到达时确定性折叠已完成工具交换和重复错误，原文卸载到会话引用，重量摘要仍作为容量兜底。 |
| F13 | 共享工具参数容量常量、Provider/Schema | Provider 累积器、工具 schema 和批量总量使用同一字节/字符边界，超限在工具执行前失败。 |
| F14 | 完成证据跟踪器、`report_completion`、系统提示与 UI | 模型提交结构化验证清单并引用本轮工具证据；运行时校验引用，最终事件携带 verified/partial/unverified/blocked。 |
| F15 | 时间线归一化、消息组件和 CSS | 实时及持久消息统一过滤纯空白 part，组件保留防御性过滤，连续工具卡使用单一小间距。 |
| F16 | Agent/Web 终止提交、对话持久化 | 所有停止原因经唯一 stopped 事件提交；恢复只基于最后完整版本，未完成工具统一归类而非伪成功。 |

## 核心类型与接口

```ts
export type ModelRequestStage =
  | "waiting-first-byte"
  | "streaming-text"
  | "streaming-tool-arguments"
  | "waiting-done";

export type ProviderTimeoutPhase = "first-byte" | "idle" | "total";

export type ProviderTransportPolicy = {
  readonly firstByteTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly maxRetries: number;
};

export type ModelStreamEvent =
  | { readonly type: "request-progress"; readonly stage: ModelRequestStage; readonly elapsedMs: number; readonly attempt: number; readonly traceId?: string; readonly toolName?: string; readonly toolArgumentsChars?: number }
  | { readonly type: "reasoning-delta"; readonly text: string }
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "tool-call"; readonly call: ModelToolCall }
  | { readonly type: "usage"; readonly usage: ModelTokenUsage }
  | { readonly type: "done"; readonly finishReason: "stop" | "tool-call" };

export class ProviderError extends Error {
  readonly kind: "network" | "http" | "protocol" | "stream" | "timeout" | "cancelled";
  readonly timeoutPhase?: ProviderTimeoutPhase;
  readonly traceId?: string;
  readonly retryable: boolean;
}
```

Provider 只报告经过清洗的 trace 标识和计数，不暴露 URL、Authorization 或工具参数。安全重试位于 Provider transport 边界：一次 attempt 在输出正文、推理或完整工具调用前失败才可重放；出现任何语义增量后错误直接上抛，由 Agent 持久化部分结果。

```ts
export type AgentModelProgress = {
  readonly stage: ModelRequestStage;
  readonly elapsedMs: number;
  readonly attempt: number;
  readonly traceId?: string;
  readonly toolName?: string;
  readonly toolArgumentsChars?: number;
};

export type VerificationStatus =
  | "verified"
  | "partial"
  | "unverified"
  | "blocked";

export type CompletionAssessment = {
  readonly status: VerificationStatus;
  readonly checks: readonly {
    readonly criterion: string;
    readonly status: "passed" | "failed" | "not-run";
    readonly evidenceCallIds: readonly string[];
  }[];
  readonly blockers: readonly string[];
};
```

现有 `progress` 事件保留 `phase: "model" | "tools"` 以减少 Web 合约迁移范围，并在模型阶段附带可选 `model` 字段。`stopped` 事件增加 `verification`；旧持久会话缺少该字段时按 `unverified` 展示，不修改磁盘旧版本。

```ts
export type ToolFailureFingerprint = {
  readonly toolName: string;
  readonly errorKind: ToolErrorKind;
  readonly issuePaths: readonly string[];
  readonly callFingerprint?: string;
};

export type ToolFailureDecision =
  | { readonly action: "continue" }
  | { readonly action: "change-strategy"; readonly detail: string }
  | { readonly action: "stop"; readonly detail: string };

export interface ToolFailureBudget {
  observe(result: ToolCallResult): ToolFailureDecision;
  resetForSuccessfulAlternative(result: ToolCallResult): void;
}
```

错误指纹不包含命令全文或文件内容。精确重试以工具名、错误种类、schema issue path 与已存在的参数哈希组合；工具级和轮次级统计不依赖原始参数，从而能识别模型稍改字符串但未改变策略的重复失败。

```ts
export type ConversationActivity =
  | { readonly status: "idle" }
  | { readonly status: "active" }
  | { readonly status: "interrupted"; readonly expectedRevision: number };

export interface ConversationWriteLease {
  readonly ownerToken: string;
  release(): Promise<void>;
}

export interface ConversationOperationGuard {
  inspect(conversationId: string): Promise<ConversationActivity>;
  runExclusive<T>(
    conversationId: string,
    kind: "agent" | "compress" | "rename" | "clear" | "delete" | "recover",
    operation: (lease: ConversationWriteLease, signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
}
```

`inspect` 不修改标记、租约或 revision。`runExclusive` 先登记进程内操作，再取得跨进程租约；失败按逆序清理。恢复操作只有在租约可安全取得且活动标记与当前 revision 匹配时才提交一次中断版本。

```ts
export type ManagedProcessId = string;

export interface ManagedProcessController {
  start(input: {
    readonly command: string;
    readonly cwd?: string;
    readonly readiness?: { readonly port: number; readonly timeoutMs: number };
    readonly signal: AbortSignal;
  }): Promise<ManagedProcessSnapshot>;
  status(input: { readonly processId: ManagedProcessId; readonly cursor?: number }): Promise<ManagedProcessSnapshot>;
  stop(processId: ManagedProcessId): Promise<ManagedProcessSnapshot>;
  close(): Promise<void>;
}
```

控制器只持有当前 Agent 运行创建的进程，ID 为不透明随机值；日志按字节上限保存环形缓冲并通过 cursor 增量读取。`start_process` 复用命令权限与 Seatbelt，readiness 只允许 loopback 端口；`process_status` 和 `stop_process` 只能访问本控制器已登记 ID。

```ts
export type ToolPermissionDescriptor<TInput> = {
  readonly targetKind: ToolPermissionTarget["kind"];
  resolve(input: TInput): ToolPermissionTarget | readonly ToolPermissionTarget[];
};

export type OperationalCompactionReport = {
  readonly before: TokenEstimate;
  readonly after: TokenEstimate;
  readonly compactedExchanges: number;
  readonly createdReferences: readonly string[];
};
```

多目标权限只供有界批量工具使用。Registry 在任何授权或执行前解析并冻结全部目标；Permission Gateway 对每个路径应用现有规则，任一路径拒绝则整批不启动。批量执行过程中发生 I/O 失败时保留已完成项的真实逐项结果，不宣称事务性回滚。

## 状态与交互

### 会话读取、运行与恢复

```text
GET detail
  → inspect activity（只读）
  → 返回最后完整 checkpoint + idle/active/interrupted

POST chat / mutation / recover
  → begin in-process operation
  → acquire cross-process lease
  → validate expected revision
  → perform atomic write or Agent run
  → persist terminal checkpoint
  → clear owned turn marker
  → release lease and operation
```

- 活动状态由进程内 Operation Manager 与磁盘租约共同判断；任一显示活动都不得恢复或修改。
- 客户端看到 `interrupted` 后调用显式同源恢复接口。恢复接口具有 expected revision，冲突或已有新提交时只返回最新状态。
- Agent 开始标记包含租约 owner token；只有持有同一租约的正常终止路径能清除。旧标记无 token 时按兼容的过期规则处理。
- 删除操作在持有自己的租约时删除对话内容；释放过程允许目标目录已不存在，不泄露内部路径。

### 模型请求、重试与终止

```text
prepare context
  → attempt 1 / waiting-first-byte
  → stream progress and semantic events
  ├─ safe transient failure before semantic output → bounded retry
  ├─ cancellation → cancelled stop
  ├─ timeout/protocol/network after semantic output → persist interruption
  └─ done → execute tools or validate final completion
```

- 三个超时共用一个父 AbortSignal，但保留触发阶段；每接收有效 SSE 数据刷新 idle timer，总时长不刷新。
- 重试 attempt 使用新的 HTTP 请求和 trace ID，延迟采用小型有界退避；用户取消立即跳过退避。
- 参数增量只产生节流后的计数事件，完整 JSON 仍仅在 Provider 完整校验后作为 `tool-call` 交给 Agent。
- Provider 错误进入 Agent 的结构化停止映射；Web handler 不再吞掉根分类后统一输出“请求失败”。

### 工具失败预算与完成证据

- Scheduler 完成每个结果后，Agent 将结果交给 `ToolFailureBudget`。首次失败仍反馈模型；达到策略切换阈值时额外加入明确约束；达到停止阈值时提交 `repeated-tool-failure`。
- `report_completion` 是无副作用的上下文工具。它只能引用本轮已出现的 call ID，`passed` 证据必须引用成功结果，发生写入后“完整验证”必须引用最后一次写入之后的验证结果。
- 未调用或未通过 `report_completion` 而直接结束的回复仍可显示，但 `stopped.verification` 为 `unverified`；部分通过或存在 blocker 分别为 `partial`/`blocked`。
- 系统提示要求测试从实际响应获取运行期标识，并把依赖步骤组织为前置成功后再执行；运行时通过失败预算和完成证据阻止失败级联被包装成成功。

### 上下文效率压缩

- 轻量工具结果卸载保持现状。
- 当累计输入达到效率阈值、完成一个工具密集阶段或重复错误组达到阈值时，确定性压缩器选择最近工作集之外的完整工具交换组。
- 选中交换组的原始协议消息作为一个有界对象写入 Context Store；活动上下文用包含工具名、路径摘要、成功/失败、引用和恢复说明的边界消息替代整组，因此不留下孤立 tool result。
- 未完成工具、最近失败、最近一次文件读写、用户消息和完成证据不进入确定性折叠。窗口临界时继续使用现有模型摘要兜底。

### 前端加载与时间线

- `loadConversation` 保存加载前快照，成功后一次性应用；失败转为 error，Abort 转回原状态。所有 `void` 事件入口调用一个消费错误的包装函数。
- reducer 和持久时间线构造不再创建纯空白 text part；渲染层再次过滤旧记录中的空白 part。
- `messageTimeline` 使用一个容器 gap 管理相邻元素，工具卡包装层不重复添加 margin；有意义文字仍使用 `white-space: pre-wrap`。

## 模块设计

### Provider 传输与观测

- 职责：解析 OpenAI 兼容 SSE，执行分阶段超时、安全重试、trace 提取和工具参数进度报告。
- 对外契约：扩展 `ChatProvider` 事件与 `ProviderError`，Provider 配置携带有界 transport policy。
- 依赖：Web Fetch、现有 SSE 解析器和模型类型；不依赖 Agent、工具或 UI。
- 错误处理：公开稳定分类、timeout phase 和 retryable；cause 只供内部诊断且不序列化。

### Agent 运行策略

- 职责：消费模型进度、应用失败预算、维护完成证据、决定继续或唯一终止。
- 对外契约：扩展 `AgentEvent`、`AgentStopReason` 和 `AgentLoop` 选项。
- 依赖：Provider、Context Manager、Tool Scheduler 抽象；不依赖 Web。
- 错误处理：所有可预期 Provider/工具/上下文失败映射到 stopped；未知异常仍为 agent-error。

### 工具与权限

- 职责：命令预检、批量写文件、进程生命周期与完成报告；在 Registry 准备阶段固定权限目标。受管进程必须通过扩展后的 `CommandSandbox` 启动，控制器不得直接启动未隔离 shell。
- 对外契约：新增 `write_files`、`start_process`、`process_status`、`stop_process`、`report_completion`，扩展多目标权限。
- 依赖：现有 Workspace Boundary、Seatbelt、Permission Gateway、Node `child_process`/`net`。
- 错误处理：参数和权限失败不产生副作用；批量返回逐项结果；进程未知/退出/未就绪使用稳定错误种类。

### 上下文管理

- 职责：根据运行阶段和估算体积折叠历史工具交换，同时保留引用与最近工作集。
- 对外契约：Context Policy 增加效率阈值，Context Manager 返回确定性压缩报告并持久化状态。
- 依赖：现有 Token Estimator、Context Store 和重量压缩器。
- 错误处理：卸载写入失败则保持原消息；压缩结果协议非法则回滚本次压缩，不影响已提交上下文。

### 会话操作与存储

- 职责：统一操作互斥、租约所有权、只读活动检查、显式恢复和公开错误脱敏。
- 对外契约：Conversation Detail 增加 activity；新增恢复端点；所有写路由通过 operation guard。
- 依赖：本地存储、Runtime Manager、API 安全校验。
- 错误处理：busy/conflict/not-found/invalid-data/storage 分离；storage 对外不拼接原始 cause。

### 运行日志

- 职责：把模型 attempt、阶段耗时和失败分类写入本地 JSONL，并由现有导出器带入完整会话导出。
- 对外契约：日志 schema 升级并兼容读取上一版本，参数只记规模和哈希化分类。
- 依赖：Agent 事件与 Node 文件 API。
- 错误处理：日志失败不改变 Agent 结果或持久化状态；读取损坏行返回安全错误。

### Web 状态与呈现

- 职责：解析扩展事件、收敛加载状态、展示模型阶段/验证状态、归一化时间线空白。
- 对外契约：扩展 Web chat/detail 合约与 `VisibleMessage`。
- 依赖：Web 合约和 React；不直接读取租约、日志或 Provider。
- 错误处理：无效事件拒绝进入 reducer；加载失败可重试且不产生未处理 rejection。

## 文件组织

```text
src/
├── app/
│   ├── api/conversations/[conversationId]/route.ts
│   ├── api/conversations/[conversationId]/clear/route.ts
│   ├── api/conversations/[conversationId]/recover/route.ts       # 新增
│   └── globals.css
├── components/
│   ├── chat-session-state.ts
│   ├── chat-session-state.test.ts
│   ├── chat-workspace.tsx
│   ├── chat-workspace.test.tsx
│   ├── message-list.tsx
│   └── message-list.test.tsx
├── core/
│   ├── agent-events.ts
│   ├── agent-loop.ts
│   ├── agent-loop.test.ts
│   ├── completion-tracker.ts                         # 新增
│   ├── completion-tracker.test.ts                    # 新增
│   ├── tool-failure-budget.ts                        # 新增
│   ├── tool-failure-budget.test.ts                   # 新增
│   ├── tool-scheduler.ts
│   ├── tool-scheduler.test.ts
│   ├── context/context-manager.ts
│   ├── context/context-manager.test.ts
│   ├── context/operational-compaction.ts             # 新增
│   ├── context/operational-compaction.test.ts        # 新增
│   ├── context/types.ts
│   ├── conversations/display-timeline.ts
│   ├── conversations/display-timeline.test.ts
│   ├── conversations/types.ts
│   ├── conversations/validation.ts
│   └── system-prompt/action-execution.ts
├── lib/
│   ├── local-agent-run-log.ts
│   ├── local-agent-run-log.test.ts
│   ├── local-agent-run-exporter.ts
│   ├── local-agent-run-exporter.test.ts
│   ├── local-conversation-store.ts
│   └── local-conversation-store.test.ts
├── models/
│   ├── config.ts
│   ├── config.test.ts
│   ├── openai-provider.ts
│   ├── openai-provider.test.ts
│   └── provider.ts
├── tools/
│   ├── command-preflight.ts                          # 新增
│   ├── command-preflight.test.ts                     # 新增
│   ├── command-sandbox.ts
│   ├── default-registry.ts
│   ├── macos-seatbelt-sandbox.ts
│   ├── macos-seatbelt-sandbox.test.ts
│   ├── managed-process.ts                            # 新增
│   ├── managed-process.test.ts                       # 新增
│   ├── mode-policy.ts
│   ├── permission-gateway.ts
│   ├── permission-gateway.test.ts
│   ├── permission-target.ts
│   ├── process-tools.ts                              # 新增
│   ├── registry.ts
│   ├── registry.test.ts
│   ├── report-completion.ts                          # 新增
│   ├── run-command.ts
│   ├── schema.ts
│   ├── types.ts
│   ├── write-files.ts                                # 新增
│   └── write-files.test.ts                           # 新增
└── web/
    ├── chat-contract.ts
    ├── chat-contract.test.ts
    ├── chat-handler.ts
    ├── chat-handler.test.ts
    ├── conversation-http.ts
    ├── conversation-operation-guard.ts               # 新增
    ├── conversation-operation-guard.test.ts          # 新增
    ├── conversation-runtime-manager.ts
    └── server-config.ts

README.md
orbitcode.example.yaml
```

已有 API Chat 路由及删除/压缩/重命名路由也会接入操作守卫；它们未在树中逐项展开，以免掩盖新增边界。实际实现若现有测试文件更适合承载相邻用例，可合并测试文件，但不得改变对应职责和覆盖。

## 安全与权限边界

- 所有会话写操作同时持有进程内 operation 和跨进程 lease；租约 token 只落在用户权限目录，不进入浏览器、模型或普通日志。
- GET 不删除标记、不打破租约、不提交 revision；恢复必须通过同源、非 GET、带 expected revision 的接口。
- Provider 自动重试只发生在没有语义输出的请求 attempt；任何可能已经对 Workspace 产生副作用的工具调用都不自动重放。
- 工具参数进度只记录字符/字节数量、工具名和耗时。日志不得保存 command、cwd、path、content、环境变量或响应正文。
- `write_files` 在授权前完成全部 schema、总项数、总字节和路径解析；任何预检失败整批不执行。执行期 I/O 失败返回真实部分结果和 sideEffect。
- 受管进程继续运行在 Seatbelt 中，只允许当前 Workspace cwd；readiness 只连接 loopback，不成为任意网络探测工具。停止使用进程组并设置升级终止时限。
- 完成报告只能引用当前运行已知 call ID，不能伪造成功证据；报告文本和 blocker 都应用长度边界。
- 上下文折叠只处理完整、已结束且位于最近工作集之外的工具交换；写入引用失败不删除原始消息。
- 错误响应对外采用稳定中文消息和错误码；绝对路径及原始 Node cause 只允许进入经过脱敏的内部诊断分类，默认不写文本。

## 依赖决策

- 保持零新增运行时依赖。
- SSE 超时使用 `AbortController`、Web Streams 和定时器；进程管理使用 Node.js `child_process`、`net` 与现有 macOS Seatbelt；日志和租约使用 Node.js 文件 API。
- 不引入 Agent 框架、进程管理守护库、数据库、遥测 SDK 或通用重试库，避免绕开现有协议、权限和本地存储边界。

## 技术决策

| 决策点 | 选择 | 理由 | 被否决方案 |
| --- | --- | --- | --- |
| 活动会话读取 | GET 只读返回 activity，显式 POST 恢复 | 避免浏览器刷新或第二标签页产生 revision 副作用 | GET 中继续自动恢复；仅依赖页面按钮禁用 |
| 写操作互斥 | 进程内 operation + 跨进程磁盘租约统一包装 | 同时覆盖同一 Next 进程、开发重载和多进程访问 | 只看 React requestState；每个路由自行判断 |
| SSE 重试 | 分阶段超时，首个语义增量前小预算重试 | 可恢复网络抖动且不会撤回/复制已展示输出 | 任意流中断都重连；完全不重试 |
| 工具参数进度 | Provider 发计数事件，完整参数只在校验完成后交付 | 解决长写入无反馈，同时控制敏感内容 | 把 arguments delta 直接发到浏览器 |
| 命令修复 | 只拒绝明确畸形并给建议 | 不猜测 shell 语义，维持权限请求与实际执行一致 | 自动删除引号、自动改 cwd 或重写命令 |
| 失败止损 | 精确错误、工具错误类、轮次总失败三级预算 | 同时阻断完全重复和轻微变体的无效重试 | 只限制未知工具；只靠 prompt |
| 长驻进程 | 当前 Agent 运行内的受管进程与三个工具 | 生命周期清楚、可清理，避免把 timeout 当成功 | 普通 run_command 延长 timeout；系统级守护进程 |
| 降低迭代 | 保留多调用调度并增加有界 `write_files` | 兼顾模型能力差异和权限可审计性 | 任意工具通用批处理；并发执行所有写操作 |
| 批量权限 | Registry 支持多路径目标，整批预授权 | 用户看到真实目标，任何拒绝都阻止启动 | 用虚构公共路径授权；在工具内部绕过 Gateway |
| 效率压缩 | 确定性折叠旧工具交换 + 现有模型摘要兜底 | 工具密集任务可提前减负且不依赖额外模型稳定性 | 只提高窗口；每轮都调用模型总结 |
| 完成判断 | 结构化完成报告引用实际工具证据 | 可观察、可持久化，避免仅解析自然语言成功声明 | 正则检查“完全正常”；只加提示词 |
| 空白时间线 | 数据构造与渲染双层忽略纯空白 part | 同时修复实时消息和无需迁移的旧记录 | 仅调小 CSS 行高；修改历史文件 |
| 日志版本 | 新版本增加 attempt 明细并兼容读旧版本 | 新导出可用且不要求迁移历史 JSONL | 直接记录完整请求/参数；删除全部兼容解析 |

## 验证策略

- Provider 单元测试使用可控 `fetch`、ReadableStream 和虚拟计时器，覆盖 trace header、首字节/idle/total 超时、重试预算、取消、参数进度与统一容量。
- 会话存储与 API 集成测试使用临时目录和两个 Store/Guard 实例，模拟活动读取、跨进程 busy、过期租约、显式恢复、删除竞争和带绝对路径的 Node 错误。
- Agent Loop 使用脚本 Provider 验证多调用、失败预算、完成报告、所有停止原因及“继续”后的上下文；基准 fixture 生成约 30 个独立文件变更，在 30 次迭代内完成。
- 工具层在临时 Workspace 中验证命令预检、批量预授权、逐项结果、容量边界和受管服务的启动/端口就绪/日志 cursor/停止/清理；不使用真实项目或真实密钥。
- Context Manager 构造大型写入参数、重复错误和最近待办，比较压缩前后估算、协议配对、引用可读性与失败回滚。
- React 静态渲染和 reducer 测试覆盖纯空白 part、语义多行文字、模型阶段、验证状态及加载失败收敛；开发服务器中使用浏览器验证截图场景、控制台和错误覆盖层。
- 日志/导出测试验证新旧 schema、阶段数据和敏感字段缺失；测试值包含伪密钥、Authorization 和临时绝对路径，断言均不可搜索。
- 聚焦测试通过后依次运行 `npm run lint`、`npm run typecheck`、`npm run build`；最后在 tmux 中用安全配置完成一次真实对话，并覆盖工具畸形参数、重复失败、命令超时、模型流中断和 unlimited 迭代受运行时限保护。
