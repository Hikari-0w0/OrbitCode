# Workspace 选择与 Plan 执行工作流 Plan

状态：已批准
依据：已批准的 `spec.md`

## 架构概览

本轮在现有 Web 入口前增加一层服务端 Workspace Catalog，并保留 `WorkspaceBoundary` 作为工具层的唯一路径授权抽象。浏览器先从独立 API 获取不含真实路径的 workspace 摘要，聊天时只提交 `workspaceId`；Route Handler 在构造 `AgentLoop` 前重新加载清单、解析 ID、验证目录，再创建请求专属的 `WorkspaceBoundary`。

Workspace 配置使用独立、未入库的 `orbitcode.workspaces.yaml`，不把 Web 特有的本地目录概念塞入模型 Provider 配置解析器。文件不存在时由服务端生成仅含启动目录的兼容清单；文件存在却非法时则整体拒绝，不做宽松回退。

Plan/Do 工作流不修改 Agent Loop。页面以可测试的会话 reducer 统一管理 workspace、Provider、模式、历史、请求和“可执行计划”状态；模式仍由每次请求携带，服务端 `ModeToolPolicy` 继续作为真实权限边界。点击“按此计划执行”会在同一 workspace 和已完成历史后追加一条可见的执行用户消息，并以显式 `do` 快照启动新请求，避免 React 异步状态导致误用旧模式。

```text
orbitcode.workspaces.yaml
          |
          v
Workspace Catalog ----> GET /api/workspaces ----> Workspace 选择器
          |                                           |
          | resolve(workspaceId)                      | 会话 reducer
          v                                           v
POST /api/chat ----> WorkspaceBoundary ----> AgentLoop + ModeToolPolicy
                                                    |
                   Plan 最终回复 <---- SSE 事件
                          |
                          v 用户明确点击
                 新的 Do 模式请求
```

## 需求映射

| 需求 | 负责模块/交互 | 设计说明 |
| --- | --- | --- |
| F1 | `src/web/workspace-config.ts`、`GET /api/workspaces` | 加载、校验和摘要化授权目录，对客户端只公开 ID、名称、可用性和默认项。 |
| F2 | `src/web/workspace-config.ts` | 区分“配置缺失”与“配置非法”，前者使用启动目录，后者结构化失败。 |
| F3 | `ChatWorkspace`、`WorkspaceSelector` | 侧栏展示当前 workspace 并在请求期间禁用选择。 |
| F4 | `chat-session-state.ts` | `workspace-selected` 事件仅在 ID 真实改变时原子清空会话、草稿和计划并回到 Do。 |
| F5 | `chat-contract.ts`、`POST /api/chat`、`workspace-config.ts` | 严格接受 `workspaceId`，请求级重新解析并在 Agent 创建前拒绝失效选择。 |
| F6 | `POST /api/chat`、`WorkspaceBoundary`、现有工具与命令沙箱 | 把解析完成的请求专属边界注入 Agent Loop，工具安全逻辑不变。 |
| F7 | `ModeSwitch`、`ChatComposer`、`ChatWorkspace` | 提供持续可见的分段控件，复用同一模式转换函数处理按钮和独立斜杠命令。 |
| F8 | 现有 `ModeToolPolicy` 及其集成测试 | 保持 Plan 定义过滤和执行级拒绝两道校验，增加 Web 选定 workspace 后的集成覆盖。 |
| F9 | `ChatWorkspace`、现有公开历史 | Plan 最终回复正常加入历史，后续用户回复继续以 Plan 模式提交。 |
| F10 | `chat-session-state.ts`、`MessageList`、`ChatWorkspace` | reducer 只保留最新成功 Plan 助手消息 ID；操作追加透明的执行指令并以 Do 快照发起请求。 |
| F11 | `chat-session-state.ts`、`ModeToolPolicy` | 仅 UI 显式事件或 Do 普通提交可发起 Do 请求，模型文本不被解析为控制信号。 |
| F12 | `chat-session-state.ts` | 用显式 action 固定 Provider 切换、清空、取消和失败后的状态不变量。 |
| F13 | `workspace-config.ts`、`/api/workspaces`、`/api/chat`、`ChatWorkspace` | 按配置、选择失效和网络失败分类显示，提供重新加载且不携带规范路径。 |

## 核心类型与接口

```ts
export type WorkspaceConfig = {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
};

export type WorkspaceSummary = {
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly isDefault: boolean;
};

export type WorkspaceCatalog = {
  readonly entries: readonly WorkspaceConfig[];
  readonly summaries: readonly WorkspaceSummary[];
  readonly defaultWorkspaceId: string;
};

export type WorkspaceResolution =
  | { readonly ok: true; readonly workspace: WorkspaceBoundary }
  | {
      readonly ok: false;
      readonly kind: "unknown-workspace" | "workspace-unavailable";
      readonly message: string;
    };

export type WebChatRequest = {
  readonly provider: string;
  readonly workspaceId: string;
  readonly mode: AgentMode;
  readonly messages: readonly PlainConversationMessage[];
};

export type WorkspaceCatalogResponse = {
  readonly workspaces: readonly WorkspaceSummary[];
  readonly defaultWorkspaceId: string;
};

export type ChatSessionState = {
  readonly selectedWorkspaceId: string;
  readonly selectedProvider: string;
  readonly mode: AgentMode;
  readonly messages: readonly VisibleMessage[];
  readonly history: readonly PlainConversationMessage[];
  readonly draft: string;
  readonly requestState: "idle" | "streaming" | "stopping";
  readonly executablePlanMessageId?: string;
};

export type ChatSessionAction =
  | { readonly type: "workspace-selected"; readonly workspaceId: string }
  | { readonly type: "provider-selected"; readonly provider: string }
  | { readonly type: "mode-selected"; readonly mode: AgentMode }
  | { readonly type: "conversation-cleared" }
  | { readonly type: "request-started"; readonly mode: AgentMode }
  | { readonly type: "request-finished"; readonly assistantId: string; readonly mode: AgentMode }
  | { readonly type: "request-failed" }
  | { readonly type: "request-cancelled" };
```

`WorkspaceConfig.rootPath` 仅存在服务端内存中，不进入 Web 合约。`WorkspaceSummary.available` 是列表加载时快照，不取代聊天请求前的再验证。`ChatSessionAction` 是 UI 会话状态的判别联合，不会进入 `src/core/`。

Workspace ID 仅允许受限 ASCII 字符集且有固定长度上限；显示名称与清单数量同样有上限。对外错误使用安全的用户消息，原始 `cause` 不进入 API 响应。

## 状态与交互

1. 页面启动时并行加载 Provider Catalog 和 Workspace Catalog。两者均成功且各有可用项时进入可发送状态；其中一项失败时保留已成功的选择，禁止发送并允许重试加载。
2. 选择另一 workspace 只在空闲时生效。reducer 一次性更新 ID，清空消息、历史、草稿、错误和计划候选，并将模式设为 Do。
3. 用户通过分段控件或严格独立斜杠命令切换模式。转换仅修改本地状态，清除已有的计划执行候选，不生成对话消息。
4. 普通提交在开始时捕获 `workspaceId`、Provider、Mode 和 History 的不可变快照。开始任何新 Plan 请求时立即清除上一个可执行计划，防止旧回复在新澄清期间被执行。
5. Plan 请求若以 `final-response` 成功停止，最终用户/助手消息加入历史，对应助手消息成为唯一可执行候选。失败、取消或其他停止原因都不创建候选。
6. 点击“按此计划执行”时先验证消息 ID、当前 workspace、空闲状态和最新历史。然后原子清除候选、将模式设为 Do，并用固定且可见的“请按照上述计划开始执行。”作为新用户消息。提交函数显式接收 `mode: "do"` 快照，不等待 `setState` 生效。
7. 请求期间禁用 workspace、Provider 和模式控件，但保留 Abort 操作。取消或 SSE 失败后不更改 workspace，不把未完成回复加入历史。
8. 聊天时 workspace 失效会在 SSE 创建前返回安全 API 错误。页面保留当前对话供检查，但禁止后续发送；用户修复配置并重载清单后，若原 ID 仍可用则继续，否则选择默认项并按 workspace 切换规则清空会话。

## 模块设计

### Workspace 本地配置与目录

- 职责：读取 `orbitcode.workspaces.yaml`，限制根字段、数量、ID、名称和路径，区分缺失配置和非法配置，并通过 `createWorkspaceBoundary` 对每项进行可用性检查。
- 对外契约：提供不含路径的摘要列表、默认 ID 和按 ID 产生请求专属 `WorkspaceBoundary` 的解析函数。
- 依赖：Node `fs/path`、现有 `yaml`、`createWorkspaceBoundary`；不依赖 React、Next Request 或 Agent Loop。
- 错误处理：配置读取/格式错误与请求级未知/不可用错误分类；公开消息仅引用 workspace 名称或 ID，不引用规范路径。

### Workspace Web API 与聊天组装

- 职责：独立列举 workspace，严格解析对话 `workspaceId`，并在构造 Agent 前完成服务端解析。
- 对外契约：`GET /api/workspaces` 返回 `WorkspaceCatalogResponse`；`POST /api/chat` 仅接受精确字段集合的 `WebChatRequest`。
- 依赖：Route Handler 依赖 Web 配置、工作区目录、Provider Factory、Tool Registry 和 Agent Loop；不把 Next.js 对象传给 core。
- 错误处理：合约错误为 400，未知 workspace 为 400，配置或目录当前不可用为 503，所有响应 `no-store`。

### Web 会话状态

- 职责：用纯 reducer 表达选择、模式、请求和计划执行候选的转换与不变量。
- 对外契约：接收判别联合 action，返回新状态；不执行 fetch、Abort 或 DOM 操作。
- 依赖：只依赖 Web 合约和可见消息类型，不依赖 React 运行时。
- 错误处理：对流程上不可达的 action 保持原状态；UI 在调度前仍做可用性校验。

### Workspace、模式与计划控件

- 职责：显示 workspace 与模式、空闲/禁用状态、Plan 只读说明和最新计划的执行操作。
- 对外契约：所有控件由 props 接收类型化状态与回调，不自行构造 Agent 请求。
- 依赖：React 和 Web 合约；不依赖 workspace 真实路径或工具执行器。
- 错误处理：不可用 workspace 选项、进行中请求和过期计划操作使用原生 `disabled`；加载错误通过现有 notice 区域提供重试。

## 文件组织

```text
orbitcode.workspaces.example.yaml          # 可提交的 Workspace 配置示例
.gitignore                                 # 忽略本地 orbitcode.workspaces.yaml
README.md                                  # 配置和 Plan 执行使用说明
src/
├── app/
│   ├── api/chat/route.ts               # 解析 workspace ID 后组装 Agent
│   ├── api/workspaces/route.ts         # 输出安全 Workspace Catalog
│   └── globals.css                     # Workspace、模式和计划控件样式
├── components/
│   ├── chat-session-state.ts           # 纯会话 reducer 及不变量
│   ├── chat-workspace.tsx              # 加载目录、调度请求和组装页面
│   ├── chat-composer.tsx               # 可见 Plan/Do 切换与模式说明
│   ├── message-list.tsx                # 最新 Plan 回复的执行动作
│   └── workspace-selector.tsx          # 授权 Workspace 选择器
└── web/
    ├── chat-contract.ts                 # Workspace 目录与聊天合约验证
    └── workspace-config.ts              # 本地 Workspace 配置、摘要与解析
```

相应测试与源文件就近放置，并扩展 `tests/web-tool-agent.e2e.test.ts` 覆盖双 workspace 的 Agent 集成链路。不修改 `src/core/agent-loop.ts`、模型流解析器或 CLI 入口。

## 安全与权限边界

- `workspaceId` 是选择键，不是路径；请求体采用精确字段校验，任何额外 `path`、`cwd` 或过长 ID 都会被拒绝。
- 配置路径在服务端使用 `path.resolve` 与 `realpath` 规范化，每次聊天都通过 `createWorkspaceBoundary` 重新验证。目录列表 API 不返回 `rootPath`。
- 相对路径、符号链接、敏感文件、二进制/大文件、原子写与冲突检查继续由 `WorkspaceBoundary` 和现有工具负责。
- macOS Seatbelt 继续以 `workspace.root` 构造 profile 和缓存探测；双 workspace 测试必须证明 profile 与 runtime 目录不串用。
- Plan 权限由 `ModeToolPolicy.definitions()` 和 `execute()` 双重执行，UI 提示与 Agent system prompt 仅是用户/模型引导，不是授权来源。
- “按此计划执行”不会直接调用工具，只创建一次受现有 Agent Loop、迭代上限、AbortController、参数校验和沙箱约束的 Do 请求。
- 配置错误和请求错误不输出原始 I/O 错误、规范路径、环境变量或密钥。
- Web 仍仅面向本机信任用户；新增目录清单不被宣称为身份认证或完整权限系统。

## 依赖决策

- 零新增运行时依赖。YAML 继续使用已存在的 `yaml`，目录验证使用 Node.js `fs/path`，UI 使用 React 原生状态和 HTML 控件。
- 不引入 Agent 框架、全局状态库、文件选择器依赖、数据库、Markdown 渲染器或桌面壳。

## 技术决策

| 决策点 | 选择 | 理由 | 被否决方案 |
| --- | --- | --- | --- |
| Workspace 授权来源 | 服务端 YAML 允许清单 + 客户端不透明 ID | 真实本地路径始终由服务端授权，可预测且易测试 | 浏览器上传目录；客户端提交任意绝对路径；macOS 专用选择器 |
| 配置文件 | 独立 `orbitcode.workspaces.yaml` | 不污染 `src/models/` 的 Provider 配置边界，也能单独重载和报错 | 扩展 Provider YAML 的根结构；用环境变量承载 JSON |
| 配置缺失 | 回退到启动目录的单项目录 | 保持现有开发和部署行为 | 首次启动强制创建配置；自动扫描父目录 |
| 会话一致性 | 纯 reducer + 请求快照 | 集中表达跨 workspace/Provider/Mode 的清理规则，并避免状态竞态 | 继续分散多个 `useState`；引入全局状态库 |
| Plan 需求澄清 | 普通多轮对话 | 复用已有历史和 SSE，不为暂停 Agent 新增协议 | 结构化 `AskUserQuestion` 工具与请求挂起/恢复 |
| Plan 保存 | 当前会话中的最终回复 | 严格保持 Plan 只读，不引入特殊写权限或持久化 | 写入 workspace 的 plans 目录；单独数据库 |
| Plan 转 Do | 用户点击后追加可见执行消息 | 授权明确、历史透明、符合现有交替消息合约 | 模型自动触发；隐藏 system 消息；丢弃计划后重新描述 |
| 核心改动 | Agent Loop 和 Provider 流保持不变 | 本轮是组装和 UI 工作流，现有核心已接受 workspace 与 mode 抽象 | 把 workspace 选择或 Plan 点击状态写入 `src/core/` |

## 验证策略

- 单元测试 Workspace YAML 缺失回退、严格字段、数量/长度上限、重复 ID、非目录、不可读目录、安全摘要和请求级重新解析。
- 合约测试 Workspace Catalog 响应与扩展后的 `WebChatRequest`，覆盖未知字段、原始路径字段、过长 ID、未知 ID 和安全错误。
- reducer 单元测试 workspace/Provider/清空/模式转换，Plan 候选的创建与失效，以及取消、失败和执行点击的竞态。
- Route 与 Agent 集成测试用两个临时 workspace 和本地模型替身验证 ID 解析、目录隔离、Plan 工具集、Do 写入和命令沙箱边界。
- React 组件测试覆盖 Workspace 选择器、Plan/Do 控件、禁用状态、可执行计划按钮和安全文案。
- 完整回归依次执行 `npm run test`、`npm run lint`、`npm run typecheck`、`npm run build`。
- 启动开发服务后用真实浏览器检查桌面和窄屏布局、键盘操作、请求与 DOM 不泄漏路径、错误覆盖层和控制台。
- 在 tmux 中使用本地安全配置进行真实 Agent 闭环：选择 workspace A 做 Plan 澄清，点击执行后写入并读回，切换 B 证明会话与工具边界隔离；另覆盖 workspace 失效、取消和原有 Agent 停止路径。仅使用用户本地未入库环境中的模型凭据，不记录或输出密钥。
