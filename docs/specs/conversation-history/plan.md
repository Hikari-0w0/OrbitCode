# 本地持久化对话历史 Plan

状态：已批准
依据：已批准的 `spec.md`

> 用户已授权连续完成四份规划文档；最终实现仍等待整套文档审核。

## 架构概览

本功能采用“持久 Conversation 是事实来源，内存 Runtime 是可回收缓存”的结构：

```text
React 对话列表/工作区
  → 严格 Web Conversation API
    → Conversation Runtime Manager（互斥运行、恢复、终止后提交）
      ├─ AgentLoop + ContextManager（完整模型上下文）
      ├─ Display Timeline Builder（可见消息时间线）
      └─ ConversationRepository（版本化原子检查点）
           → 本机应用私有文件存储
                ├─ 轻量 head/summary
                ├─ 不可变 revision checkpoint
                └─ 对话作用域的卸载工具结果
```

`ConversationRepository` 只暴露领域对象和结构化错误；Node 文件系统实现位于基础设施层。`src/core/` 不依赖 React、Next.js 或具体存储。浏览器只接收安全列表摘要和显示时间线，完整 managed transcript 始终留在服务端。

当前 Context Session 将从“会话本体”降级为以 `conversationId` 为键的运行时缓存。空闲 TTL 只释放 Provider、ContextManager、定时器和操作租约，不删除持久 Conversation 或其上下文对象。

## 需求映射

| 需求 | 负责模块/交互 | 设计说明 |
| --- | --- | --- |
| F1 | Conversation 领域记录、Repository | 一个版本化检查点同时包含元数据、显示时间线和可恢复 Context 状态。 |
| F2 | Repository 列表索引、对话列表 API/UI | 列表只读取每条对话的 head 摘要，不加载 checkpoint 正文。 |
| F3 | 创建/重命名 API、标题规则、列表 UI | 服务端生成 ID；首条消息本地派生默认标题，重命名使用版本检查。 |
| F4 | Runtime Manager、详情 API、客户端 hydrate | 打开时恢复绑定、模式、显示时间线和同版本 Context。 |
| F5 | 最近选择恢复、Repository 启动校验 | 浏览器仅保存最近 ID；服务端重新发现记录，失效时安全回退到列表/新建。 |
| F6 | Agent 运行协调器、终止提交 | 缓冲唯一终止事件，先形成并保存完整 checkpoint，再向页面确认保存结果。 |
| F7 | ContextManager 持久快照 | 保存/恢复 managed messages，而不是从纯文本 UI 历史反推。 |
| F8 | 对话作用域 ContextStore | 卸载对象改用稳定 conversationId 作用域，TTL 不再删除；删除/清空负责回收。 |
| F9 | 删除状态机、Repository、确认 UI | 对话先进入删除状态，清理全部数据成功后才从列表消失。 |
| F10 | 清空命令、Repository、确认 UI | 以新空 checkpoint 原子替换当前版本，随后回收旧引用。 |
| F11 | Catalog 绑定解析、只读详情 UI | 详情可读；运行、压缩和审批入口根据绑定可用性关闭。 |
| F12 | expectedRevision、单写者租约、文件锁 | 每次写入执行 CAS；同一对话只有一个活动 Agent/变更操作。 |
| F13 | 保存状态、内存未保存 checkpoint、重试 API/UI | 保存失败不覆盖旧 head，运行结果留在 Runtime，页面显示并允许无正文重传的服务端重试。 |
| F14 | 运行标记、最后完整 checkpoint | 开始前写入活动标记；异常重启检测陈旧标记并提示，不恢复未完成工具。 |
| F15 | Workspace/Provider 选择交互 | 改变绑定时新建空白对话；旧对话保持原绑定和版本。 |
| F16 | Web 合约与 Repository 校验 | 浏览器只提交不透明 ID、版本和本轮输入；服务端拒绝路径、正文覆盖和非法记录。 |

## 核心类型与接口

```ts
type ConversationBinding = {
  readonly workspace: { readonly id: string; readonly name: string };
  readonly providerId: string;
};

type ConversationSummary = {
  readonly id: string;
  readonly revision: number;
  readonly title: string;
  readonly binding: ConversationBinding;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lifecycle: "ready" | "deleting" | "damaged";
  readonly lastRunInterrupted: boolean;
};

type PersistedContextState = {
  readonly messages: readonly ManagedContextMessage[];
  readonly consecutiveSummaryFailures: number;
};

type ConversationCheckpoint = {
  readonly schemaVersion: 1;
  readonly summary: ConversationSummary;
  readonly mode: AgentMode;
  readonly modeTurn: number;
  readonly messages: readonly PersistedDisplayMessage[];
  readonly context: PersistedContextState;
};

type ConversationSaveResult =
  | { readonly status: "saved"; readonly checkpoint: ConversationCheckpoint }
  | { readonly status: "conflict"; readonly actualRevision: number }
  | { readonly status: "failed"; readonly failure: ConversationFailure };

interface ConversationRepository {
  list(): Promise<readonly ConversationSummary[]>;
  create(binding: ConversationBinding): Promise<ConversationCheckpoint>;
  load(id: string): Promise<ConversationCheckpoint>;
  save(input: {
    readonly expectedRevision: number;
    readonly checkpoint: ConversationCheckpoint;
  }): Promise<ConversationSaveResult>;
  rename(input: { readonly id: string; readonly expectedRevision: number; readonly title: string }): Promise<ConversationSaveResult>;
  clear(input: { readonly id: string; readonly expectedRevision: number }): Promise<ConversationSaveResult>;
  delete(input: { readonly id: string; readonly expectedRevision: number }): Promise<void>;
}

interface ConversationRuntimeManager {
  open(id: string): Promise<ConversationRuntimeSnapshot>;
  beginAgentTurn(input: {
    readonly id: string;
    readonly expectedRevision: number;
    readonly binding: ConversationBinding;
  }): Promise<ConversationTurnHandle>;
  persistTurn(handle: ConversationTurnHandle, terminal: AgentEvent): Promise<ConversationSaveResult>;
  retryUnsaved(id: string): Promise<ConversationSaveResult>;
  releaseIdle(id: string): Promise<void>;
}
```

### 判别字段和不变量

- `schemaVersion` 固定描述磁盘格式；读取只接受当前已知版本和精确字段集合。
- `revision` 从 0 单调增加。任何重命名、清空、压缩或 Agent 终止提交都必须携带 `expectedRevision`。
- `ConversationCheckpoint.summary.revision`、显示时间线版本和 Context 版本始终相同，不存在独立提交。
- `PersistedDisplayMessage` 只允许终态消息和已收敛工具状态；不得保存 `streaming`、`awaiting-approval`、待提交授权或客户端回调。
- `PersistedContextState` 保存完整 managed messages 和摘要失败计数；活动 turn、AbortSignal、Provider 实例、PromptEnvelope 和计时器不持久化。
- 恢复后 TokenEstimator 放弃旧进程 usage 锚点并从当前消息进行明确的近似估算；下一次普通模型 usage 再建立新锚点。
- Provider、Workspace 和权限配置仍以当前服务端配置为准；持久记录只保存绑定标识和展示名称，不保存路径、API Key 或权限会话。

## 状态与交互

### 创建与打开

```text
加载 catalog + GET conversation summaries
  → 读取浏览器最近 conversationId
      ├─ ID 有效：GET detail → 校验绑定 → hydrate UI + runtime
      ├─ ID 无效/损坏：显示错误 → 选择其他记录
      └─ 无记录：POST create(default binding) → 打开空白对话
```

打开动作不改变对话 `updatedAt`；列表仍按内容或标题最后修改时间排序。浏览器本地只保存最近 ID，不保存正文。若绑定不可用，详情返回 `read-only` 能力状态，UI 恢复记录但不创建可执行 Runtime。

### Agent 轮次与持久提交

```text
POST chat(conversationId, expectedRevision, input, mode)
  → Repository/Runtime 获取单写者租约并写 active-run marker
  → ContextManager 从同 revision checkpoint 开始事务
  → AgentLoop 流式产生文本/工具/usage 事件
  → 服务端构建 Display Timeline，正文事件继续实时发送
  → 捕获 stopped（暂不发送）并等待 Agent finally/Context commit 完成
  → 组合 display + context + title/mode 为 revision + 1 checkpoint
      ├─ 原子保存成功：清 active marker → 发送带 saved/revision 的 stopped
      └─ 保存失败：保留 Runtime 未保存快照 → 发送带 failed 的 stopped
  → 释放单写者租约
```

Web 层将不再直接令 `WebChatEvent` 等同于 `AgentEvent`。Web `stopped` 在保留 Agent 停止原因、迭代和耗时的同时增加：

```ts
type ConversationPersistenceStatus =
  | { readonly status: "saved"; readonly revision: number }
  | { readonly status: "failed"; readonly retryable: true; readonly message: string };
```

该状态是终止事件的一部分，保证 `stopped` 仍是唯一终止事件。对话保存失败不伪装成 Agent 模型失败，也不被本地运行日志失败覆盖。

### 手动停止与进程异常

- 浏览器取消会触发服务端 AbortSignal；即使响应消费者已经关闭，服务端仍等待 Agent/工具安全收敛并尝试保存取消轮次。
- Agent 开始前写入不含输入正文的活动标记。正常保存后删除标记。
- 进程异常退出会留下标记但不会移动 head。下次打开时，Repository 回收已过期且无活跃持有者的租约，加载 head 指向的最后完整 checkpoint，并设置 `lastRunInterrupted`。
- 不把未完成工具调用补写为成功；未进入 checkpoint 的流式片段不用于模型继续。

### 重命名、清空与删除

- 三类操作仅允许 Agent 空闲且使用 `expectedRevision`。
- 重命名产生新 revision，不修改正文与 Context。
- 清空产生绑定不变的空 checkpoint；提交点成功后旧 checkpoint 不再可打开，旧引用进入受控清理。
- 删除先把 head 标记为 `deleting`，拒绝打开和新运行；只有正文、索引和上下文对象全部清理成功后才从列表移除。清理失败保留可见的失败状态并允许重试，不能表现为已成功删除。

### Runtime TTL

Runtime Manager 继续使用空闲 TTL，但动作改为：停止定时器、释放 Provider/ContextManager/内存显示状态和文件租约。下一次打开从 checkpoint 重建。TTL 不调用对话或上下文对象的删除。

## 模块设计

### Conversation 领域模型

- 职责：定义摘要、显示消息、持久 Context、checkpoint、版本冲突和存储失败等判别联合；校验跨字段不变量。
- 对外契约：Repository 接口、checkpoint 克隆/验证、默认标题派生和终态显示消息构建。
- 依赖：可依赖 Agent 事件、Context 消息、工具结果和 Provider 通用类型；不得依赖 React、Next.js 或 Node 文件系统。
- 错误处理：所有预期问题归类为 `not-found`、`damaged`、`conflict`、`busy`、`capacity`、`storage`、`binding-unavailable`。

### 本地 Conversation Repository

- 职责：本机目录初始化、列表摘要、原子 revision/head 提交、CAS、跨进程租约、删除状态和残留清理。
- 对外契约：实现 ConversationRepository，并为 ContextStore 提供稳定的 conversationId 对象作用域。
- 依赖：只使用 Node 标准库。
- 错误处理：底层错误映射为不含真实路径的领域失败；损坏对话隔离，不阻断其他列表项。

存储布局采用版本化目录而不是单个持续覆盖的大 JSON：

```text
~/.orbitcode/conversations-v1/
└── <conversation-id>/
    ├── head.json                    # 小型摘要、当前 revision 指针、生命周期
    ├── revisions/<revision>.json    # 原子写入的不可变完整 checkpoint
    ├── context/<opaque-id>.txt      # 对话作用域的大工具结果
    ├── active-run.json              # 不含正文的崩溃检测标记
    └── lock/                        # 跨进程单写者租约
```

保存先以 `wx` 创建临时 revision、完整写入并同步，再原子替换 head；head 是唯一提交点。head 更新前失败时旧 revision 仍有效。列表只读 head。每个对话保留当前和上一完整 revision用于崩溃恢复，其余 revision及无引用对象在提交后清理。

跨进程互斥使用原子目录租约、随机 owner、PID 和心跳时间。持有者存活时拒绝第二写者；租约过期且持有者不可确认存活时才允许回收。所有真实路径解析后必须仍位于存储根目录，拒绝符号链接和外部路径。

### ContextManager 持久快照

- 职责：从 `PersistedContextState` 初始化并导出已提交状态；运行中状态不导出。
- 对外契约：显式 `persistentSnapshot`，区别当前用于 UI 的压缩快照。
- 依赖：保持现有 ContextStore 和 ChatProvider 抽象。
- 错误处理：恢复时先验证所有消息组和 offloaded 引用形状；失败则拒绝创建可执行 Runtime。

### Conversation Runtime Manager

- 职责：按 conversationId 缓存 Provider、ContextManager 和显示状态；管理打开、互斥 turn、终止提交、未保存重试和空闲释放。
- 对外契约：任何 Agent、压缩、重命名、清空、删除都先通过 manager 获取操作句柄。
- 依赖：Repository、Provider 工厂、ContextManager、Workspace 解析和通用时钟/ID；不依赖 React。
- 错误处理：绑定不可用返回只读详情；版本冲突不替换内存或磁盘；保存失败保留一个有界未保存 checkpoint。

### Web API 与流协调

- 职责：严格解析列表、创建、详情、重命名、清空、删除、重试保存和聊天请求；把 Agent 终止与持久提交组合成唯一 Web 终止事件。
- 对外契约：浏览器永远不能上传 managed transcript 或完整显示历史，只能提交 conversationId、expectedRevision、本轮输入和用户操作参数。
- 依赖：Runtime Manager、Catalog 和权限会话。
- 错误处理：HTTP 400/404/409/413/500 按结构化 code 区分；错误正文不包含磁盘路径或存储内容。

### Web UI

- 职责：呈现对话列表、当前标题/保存状态、创建/切换/重命名/清空/删除；按详情 hydrate reducer；持久保存最近 ID。
- 对外契约：列表项展示标题、Workspace、Provider、更新时间和异常状态。消息区域只使用服务端详情中的 display checkpoint。
- 依赖：严格 Web 合约，不接触本地文件系统和 managed transcript。
- 错误处理：活动 Agent 时禁用破坏性切换；保存失败显示持续状态与重试；绑定不可用进入只读模式。

## 文件组织

```text
src/
├── app/api/
│   ├── chat/route.ts
│   └── conversations/
│       ├── route.ts
│       └── [conversationId]/
│           ├── route.ts
│           ├── clear/route.ts
│           ├── compress/route.ts
│           └── retry-save/route.ts
├── components/
│   ├── chat-session-state.ts
│   ├── chat-workspace.tsx
│   ├── conversation-list.tsx
│   └── message-list.tsx
├── core/
│   ├── agent-loop.ts
│   ├── context/context-manager.ts
│   └── conversations/
│       ├── display-timeline.ts
│       ├── repository.ts
│       ├── types.ts
│       └── validation.ts
├── lib/
│   └── local-conversation-store.ts
└── web/
    ├── chat-contract.ts
    ├── chat-handler.ts
    ├── conversation-http.ts
    ├── conversation-runtime-manager.ts
    └── conversation-runtime-store.ts

tests/
└── web-conversation-persistence.e2e.test.ts
```

相应模块测试与源文件同目录增加或扩展。现有临时 `context-sessions` API 在迁移完成后删除；权限会话 API 保留。

## 安全与权限边界

- 存储根目录、对话目录和锁目录权限为仅当前用户访问，数据文件为仅当前用户读写；每次加载和删除都拒绝符号链接及越界真实路径。
- 对话 ID、revision、标题、消息数量、消息正文、工具数量、工具载荷和卸载对象均设运行时上限；超过上限拒绝保存或加载，不做协议破坏性截断。
- 完整对话内容只在详情请求明确加载，并只返回显示 checkpoint；managed transcript、推理内容和真实工具参数不发送浏览器。
- 持久 checkpoint 可能包含用户项目内容，但禁止保存 API Key、完整环境变量、权限 token、待处理审批和进程状态。工具层已有敏感文件与环境过滤继续生效。
- 恢复历史不会恢复 `allow-once`/`allow-session`；所有新工具执行重新通过模式、规则、Workspace 边界、危险命令和人工审批。
- 本地运行日志仅记录 conversationId 和脱敏指标，不复制 checkpoint 正文。
- 对话保存、日志保存和上下文对象清理分别报告，任何一个失败不能伪造另一个成功。

## 依赖决策

- 不新增运行时或开发依赖。
- Node 20 不提供适合当前约束且无需新依赖的稳定内置关系数据库接口；本功能使用标准库实现版本化文件仓库、原子 rename 和目录租约。
- 不引入 SQLite 包、ORM、浏览器 IndexedDB 事实源或第三方锁库。浏览器存储仅用于最近 conversationId。

## 技术决策

| 决策点 | 选择 | 理由 | 被否决方案 |
| --- | --- | --- | --- |
| 对话模型 | 多条独立 Conversation | 支持切换任务并保持绑定隔离 | 每 Workspace 单一历史会覆盖不同开发任务 |
| 事实来源 | 服务端本地 Repository | 可保存完整工具协议并防止浏览器篡改模型历史 | localStorage/IndexedDB 无法安全成为模型事实源 |
| 存储格式 | head 指针 + 不可变 revision checkpoint | 列表轻量、提交原子、可保留上一完整版本 | 单大 JSON 列表慢且覆盖失败易损坏 |
| 上下文对象作用域 | 稳定 conversationId | 重启后引用继续有效且可随对话清理 | 临时 sessionId 会在卸载/TTL 后失效 |
| 运行终止顺序 | 保存后发送 Web stopped | 页面收到终止时能知道确切保存状态 | 先 stopped 后异步保存会造成假成功 |
| 版本冲突 | expectedRevision CAS + 单写者租约 | 防止多页面和多进程静默覆盖 | 最后写入获胜会丢历史 |
| 崩溃恢复 | 最后完整 checkpoint + 活动标记 | 不伪造未完成工具结果，复杂度可控 | 逐事件 WAL 恢复进行中工具风险高 |
| 临时权限 | 不持久化 | 权限能力应与运行会话绑定 | 恢复 session allow 会扩大授权时长 |
| 不可用绑定 | 只读打开 | 用户仍可查看记录且不发生隐式替换 | 自动换 Provider/Workspace 会改变执行语义 |
| 数据保护 | OS 用户权限，暂不加密 | 与现有本地上下文一致且无需密钥管理 | 自制加密或明文云同步都不合适 |

## 验证策略

- 领域单元测试：checkpoint 严格校验、工具协议配对、标题、显示终态归一、Context 持久快照恢复。
- 文件仓库测试：真实临时目录验证权限、原子提交、旧版本保留、列表不读正文、CAS、锁回收、符号链接拒绝、损坏隔离、清空和删除失败。
- Web 合约/路由测试：列表、创建、打开、重命名、清空、删除、保存重试、不可用绑定和错误 code。
- Agent 集成测试：成功、取消、最大迭代、模型错误均在 stopped 前提交；保存失败产生未保存状态并能重试。
- 端到端测试：本地 mock Provider 完成含工具结果的对话，重新创建 Runtime Manager 模拟进程重启，再打开并继续；覆盖 offloaded 引用和并发 revision 冲突。
- 浏览器验证：新建两条对话、切换、刷新恢复、重命名/删除确认、只读绑定状态、保存失败提示、运行时间/工具卡恢复，以及控制台和错误覆盖层。
- 完成后运行 `npm test`、`npm run lint`、`npm run typecheck`、`npm run build`；不使用真实 API Key。
