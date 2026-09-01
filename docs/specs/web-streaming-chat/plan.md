# Web 流式对话 Plan

状态：已批准
依据：已批准的 `spec.md`

## 架构概览

Web 入口沿用现有依赖方向：React 页面只管理展示与浏览器交互，Next.js Route Handler 负责 HTTP 边界与本地配置装配，对话核心负责单轮事务和历史语义，Provider 负责 OpenAI 兼容请求与上游 SSE 解析。

浏览器维护两份状态：可见消息用于展示失败/取消片段，已提交历史只包含成功完成的用户/助手消息。每次提交将已提交历史和当前输入发送给服务端；服务端重新构造单轮会话，逐个把核心事件编码为 SSE 返回。这样不在服务端保存跨请求会话，也不会把凭据下发到浏览器。

```text
ChatWorkspace ──fetch/SSE──> Route Handler ──> Conversation core ──> ChatProvider
      │                           │                                      │
      ├─ 可见消息                 ├─ YAML/.env（仅服务端）               └─ OpenAI SSE
      └─ 已提交历史               └─ 请求校验与安全错误
```

## 需求映射

| 需求 | 负责模块/交互 | 设计说明 |
| --- | --- | --- |
| F1 | 首页、聊天工作区与全局样式 | 将静态落地页替换为响应式聊天外壳、空状态、状态栏和输入区 |
| F2 | Provider 元数据接口、配置加载器、Provider 选择器 | 服务端只返回名称、模型和可用状态，密钥与地址不出服务端 |
| F3 | 输入组件 | 受控多行输入，区分 Enter 与 Shift+Enter，提交前清理空白 |
| F4 | 聊天接口、Web SSE 契约、客户端流读取 | 服务端边生成边编码，客户端按事件逐段写入助手消息 |
| F5 | 对话核心、客户端已提交历史 | 仅 completed 事件后提交一对消息，下一轮发送成功历史 |
| F6 | AbortController、停止按钮、Route Handler | 浏览器取消传递到服务端和上游 Provider，取消轮次不提交 |
| F7 | 安全错误模型、聊天工作区 | 启动前错误使用 JSON，流中错误使用判别事件，均可恢复 |
| F8 | 清空控制 | 仅空闲时同时清空可见消息与已提交历史 |
| F9 | Provider 选择器 | 切换时清空状态，生成期间禁用 |
| F10 | 消息列表 | 跟随底部状态、滚动检测和回到底部按钮 |
| F11 | 工作区状态机 | idle/streaming/stopping/config-error 控制按钮和提示 |
| F12 | Web 请求校验 | 从 unknown 校验精确结构、角色、顺序、长度、数量和 Provider 名称 |
| F13 | Route Handler 与客户端清理 | 请求信号、流取消和组件卸载共同中止本轮资源 |

## 核心类型与接口

```ts
type WebChatRequest = {
  readonly provider: string;
  readonly messages: readonly ConversationMessage[];
};

type WebChatEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "completed" }
  | { readonly type: "failed"; readonly message: string };

type ProviderSummary = {
  readonly name: string;
  readonly model: string;
  readonly available: boolean;
};

type VisibleMessage = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly state: "complete" | "streaming" | "cancelled" | "failed";
};
```

请求中的消息必须从 user 开始、角色交替并以 user 结束。浏览器只在收到 `completed` 后将当前 user/assistant 对加入已提交历史；取消和失败只更新可见消息状态。服务端仍通过核心会话验证完成标记和原子提交语义。

## 状态与交互

1. 页面加载 Provider 安全元数据；选择首个可用配置，全部不可用时进入 `config-error`。
2. 用户提交后把输入追加为可见用户消息，创建 streaming 助手消息并进入 `streaming`。
3. 客户端提交“成功历史 + 当前用户消息”，逐个解析服务端 SSE：文本增量追加内容，completed 原子提交历史，failed 标记本轮失败。
4. 用户停止时进入 `stopping` 并 abort；响应结束后将助手消息标记 cancelled，恢复 idle。
5. 网络或解析异常将助手消息标记 failed，保留安全提示但不提交本轮历史。
6. 清空或切换 Provider 仅在 idle 执行，同时重置可见消息、成功历史和错误提示。

## 模块设计

### Provider 配置目录

- 职责：复用现有严格 YAML 校验，支持列举无密钥元数据与按名称解析凭据。
- 对外契约：返回只读配置列表；只有服务端解析函数返回包含 API Key 的配置。
- 依赖：Node 文件系统、现有 dotenv/yaml。
- 错误处理：沿用 `ConfigurationError`，不返回 YAML 正文或环境变量值。

### Web 协议与请求校验

- 职责：定义浏览器/服务端共享事件、限制和解析器；对请求体执行运行时校验。
- 对外契约：安全请求或结构化客户端错误；SSE 编码/解码只接受已验证事件。
- 依赖：Web 标准 API 和现有领域消息类型，不依赖 React。
- 错误处理：固定用户可读消息，不保留原始请求体、解析异常和秘密。

### Next.js Route Handlers

- 职责：`GET` 返回 Provider 摘要；`POST` 装配配置、Provider 和单轮会话并返回 SSE。
- 对外契约：配置接口返回 JSON；聊天成功返回 `text/event-stream`，启动前失败返回安全 JSON。
- 依赖：配置、核心、Provider 工厂和 Web 协议。
- 错误处理：未知输入为 400，配置不可用为 503，内部错误为 500；流开始后的错误转为 failed 事件。

### React 聊天工作区

- 职责：Provider 加载与切换、消息展示、输入、流式更新、取消、清空和滚动体验。
- 对外契约：无业务服务依赖，仅调用 Web API 和共享安全类型。
- 依赖：React、Fetch、AbortController；不直接导入 Node、配置或具体 Provider。
- 错误处理：任何失败都回到可再次输入状态，组件卸载时中止活动请求。

## 文件组织

```text
src/
├── app/
│   ├── api/
│   │   ├── chat/route.ts
│   │   └── providers/route.ts
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx
├── components/
│   ├── chat-composer.tsx
│   ├── chat-workspace.tsx
│   └── message-list.tsx
├── models/
│   ├── config.ts
│   └── config.test.ts
└── web/
    ├── chat-contract.ts
    └── chat-contract.test.ts
```

同时更新 `README.md`；如 Route Handler 的可测组合逻辑需要隔离，可在 `src/web/` 增加一个聚焦服务模块，不提前建立空目录。

## 安全与权限边界

- 固定读取项目工作目录 `.env` 与 `orbitcode.yaml`；路径不接受浏览器输入。
- Provider 名称必须来自已验证配置，API Key 只在创建 Provider 时存在于服务端内存。
- 浏览器只接收名称、模型、可用状态和脱敏错误，不接收 base URL、环境变量名或密钥。
- 请求体限制为 256 KiB、最多 50 条消息、单条最多 20,000 个字符；非法输入在调用 Provider 前拒绝。
- 模型内容以 React 文本节点与 `white-space: pre-wrap` 显示，不使用 `dangerouslySetInnerHTML`。
- 本阶段无认证，README 明确仅适合本机或可信网络使用，不作为公开代理部署。

## 依赖决策

- 不新增运行时或开发依赖。
- React 19、Next.js Route Handler、Fetch、ReadableStream、AbortController、TextDecoder 和现有 YAML/dotenv/SSE 模块足以完成实现。
- 不引入组件库、Markdown 渲染器、状态管理库、SSE 客户端或模型 SDK。

## 技术决策

| 决策点 | 选择 | 理由 | 被否决方案 |
| --- | --- | --- | --- |
| 会话归属 | 浏览器保存成功历史，服务端无状态处理每轮 | 不需要数据库或内存会话表，刷新语义清晰 | 服务端全局 Map 会泄漏且不适合多实例 |
| 浏览器流协议 | Next.js Route Handler 输出 SSE | 与既有流式语义一致，事件边界清晰 | 完整 JSON 会失去实时性；WebSocket 对单向流过重 |
| Provider 选择 | 安全元数据接口 + 页面选择器 | 支持既有多配置 YAML，且不暴露秘密 | 固定首项会让多配置行为含糊 |
| UI 状态 | React 本地状态与明确判别状态 | 本阶段规模足够，无需新增依赖 | 全局状态库增加不必要复杂度 |
| 富文本 | 纯文本与保留换行 | 避免 XSS 与新依赖，符合本阶段边界 | Markdown/HTML 渲染留待后续 |

## 验证策略

- 使用 `node:test` 为配置列举、请求校验和 Web SSE 契约补充聚焦测试。
- 保留并运行现有 CLI、Provider、SSE 和会话测试，防止共享核心回退。
- 运行 lint、严格类型检查和生产构建。
- 启动开发服务器，使用真实浏览器验证首页、发送/停止/清空、流式更新、控制台错误和移动视口；模型成功路径可使用用户本地真实配置，异常路径使用既有自动化替身，不扩大人工故障矩阵。
