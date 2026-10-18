# Web 人机交互与视觉重构 Plan

状态：已批准
范围更新：按 2026-10-18 用户明确指示，仅维护桌面浏览器。
依据：同目录已批准的 spec.md；用户已统一批准四份文档并授权开发。

## 架构概览

本轮重组 Web 展示与交互，不迁移服务端数据格式或改变共享运行时协议。现有 HTTP/SSE、版本校验、权限请求及终态仍是事实来源。

依赖方向：页面入口 → 工作台/设置编排 → 展示组件与客户端状态 → 现有 Web API → 共享运行时 → Agent 核心和模型/工具。核心不导入 React。客户端只使用安全公共 DTO，不能导入服务端存储或执行器。

保留 chat-session-state 的事件归并、conversation-binding 的绑定规则及 cancelled-turn-recovery 的恢复流程；将 chat-workspace 内请求及订阅编排提取到专用 hook，以稳定宿主承载。打开管理面板不得卸载运行中的对话宿主。设置操作继续复用 settings-operation 的订阅与取消流程。

## 页面与视觉方案

### 桌面工作台

- 左侧约 232px，较小桌面窗口使用 216px，固定显示：品牌、新建、标题搜索、会话列表；底部放 Skills、背景与记忆、历史清理、设置入口。取消阶段卡片和重复状态列表。
- 主区顶部合并为约 64–72px 的紧凑标题栏：当前会话标题、工作区与模型摘要、真实运行状态；导出、清空等低频操作放会话菜单。工作区、模型与权限设置保留明确可达入口。
- 主区中间：消息区使用主区可用宽度，容器上限 1520px；工具先呈现名称、状态和摘要，展开显示安全详情。待审批卡片默认展开，顶部保留可定位到审批的提示。
- 底部：输入框、Plan/Do、发送或停止；压缩和上下文信息放输入附近的可展开区域。模式与权限分别标注，不合并成一个选择器。
- Skills、背景与记忆使用右侧面板，宽度约 420px；对话列空间不足时改为覆盖式面板。清理使用宽对话框。管理面板不接管工具执行。

### 设置与首次使用

- 保留 /settings 入口，以“模型、工作区、MCP、运行偏好、配置恢复、外观”分类导航；列表与编辑区分开，避免全部表单同时展开。
- 工作台“设置”菜单可直接选择分类，一次展开、一次进入；Skills、背景、清理为直接入口，满足两次导航上限。
- 首次空态显示模型、工作区配置就绪状态及对应操作；连接测试由用户显式启动，不自动消费模型或连接 MCP。
- 新增与编辑标题明确；必填、格式错误、提交错误贴近字段或表单。默认权限模式纳入运行偏好。
- 已有 /settings 直接访问继续有效，使用查询参数记录分类；切换分类和返回对话先处理未保存编辑。

### 桌面窗口与交互层级

- 会话侧栏在桌面保持可见，移除顶部书页图标和移动抽屉；桌面窗口以 1024–1920px 范围为本轮验证样本。主区保留标题、环境、权限、状态、审批提示和输入。
- 一次仅一个模态层；打开新层先处理旧层未保存内容。Escape 关闭可关闭层；有脏表单时进入保存/放弃/继续编辑选择，不静默丢失。
- 原生 dialog 配合显式初始焦点、关闭归还及背景不可交互；不靠 CSS 隐藏后仍可 Tab 进入。
- 运行期间前往独立设置页先提示需要停止当前轮次；选择停止后等待既有停止恢复完成才导航。关闭管理面板本身不停止 Agent。

### 视觉规范

- 深色采用中性炭灰，浅色采用暖白；品牌绿色只用于重点操作或选中状态，风险采用独立语义色。具体颜色须通过对比度验证后固定。
- 字号层级：正文 15px、输入 16px、辅助 12–13px、小标题 16px、页面标题 24px；代码至少 13px。间距以 4/8/12/16/24/32px 为主，控件圆角 8px、面板 12px。
- 普通文本 4.5:1，焦点及必要控件边界 3:1；主要触控目标 44px。状态同时有文字，不依赖颜色或动画。
- CSS 语义变量覆盖所有页面；采用全局基础样式加组件样式模块，移除无效工具类。无远程字体请求。
- 主题偏好仅保存 light/dark/system；服务端可读取偏好 cookie，system 由媒体查询处理，避免首屏先展示另一主题和 hydration 不匹配。cookie 不承载任何凭据或业务内容。

## 需求映射

| 需求 | 模块/交互 | 保留基线 |
| --- | --- | --- |
| F1 | workspace-shell、management-panel、settings-panel | B1–B13 全入口 |
| F2 | ui 基础组件、theme-control、样式变量 | 全界面 |
| F3 | conversation-list、会话操作对话框、use-chat-workspace | B1 |
| F4 | workspace-selector、environment-status、首次空态 | B2 |
| F5 | chat-composer、draft-store、navigation-guard | B3 |
| F6 | message-list、message-content、tool-execution-card | B4 |
| F7 | permission-request-card、permission-mode-control、顶部审批提示 | B5 |
| F8 | context-compression-control、skill-panel、conversation-background-panel | B6–B8 |
| F9 | conversation-cleanup-panel | B9 |
| F10 | 设置分类、资源表单、use-settings | B10–B13 |
| F11 | workspace-shell、dialog、导航和主题 | 全界面 |
| F12 | chat-session-state、use-chat-workspace、操作状态与错误提示 | 全异常与恢复 |

## 客户端类型与接口

以下是计划中的契约，不是已实现代码。继续复用现有 ChatSessionState、WebChatEvent、PublicSettings 和 SettingsAction；不另造一套服务端状态。

```ts
type ThemePreference = "light" | "dark" | "system";
type ManagementView = "skills" | "background" | "cleanup";
type SettingsSection = "models" | "workspaces" | "mcp" | "runtime" | "recovery" | "appearance";
type WorkspaceOverlay =
  | { kind: "closed" }
  | { kind: "navigation" }
  | { kind: "management"; view: ManagementView }
  | { kind: "rename"; conversationId: string }
  | { kind: "confirm"; action: "delete" | "clear"; conversationId: string };
type ComposerAvailability =
  | { kind: "ready" }
  | { kind: "busy"; phase: "streaming" | "stopping" }
  | { kind: "blocked"; reason: "loading" | "unconfigured" | "invalid-config"
      | "resource-disabled" | "read-only" | "permission-unavailable" | "save-failed";
      message: string; recovery: "settings" | "reload" | "retry-save" | "none" };
type OperationState<T> =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "succeeded"; value: T }
  | { kind: "failed"; message: string; retryable: boolean };
interface DraftStore {
  read(conversationId: string): string;
  write(conversationId: string, text: string): void;
  remove(conversationId: string): void;
}
```

- availability 从既有状态推导，优先展示运行/停止中，再显示实际阻塞项；多个阻塞项可列出，不能用模型错误覆盖会话错误。
- UI overlay 只决定展示，不决定授权。保存/重试接口携带现有 revision；处理异步回包时校验会话标识和请求序号，旧响应不得覆盖新视图。
- 草稿按会话标识保存在 sessionStorage，未创建会话使用独立临时标识；提交被接受后才清除，失败保留。存储被禁用时退化为内存并提示离开风险。删除会话后删除其草稿。
- 设置和笔记编辑保留在内存；凭据绝不写入浏览器存储。内部导航使用离开守卫；刷新/关闭标签采用 beforeunload 的浏览器标准提示，不承诺系统强制退出后的恢复。

## 状态与错误处理

| 场景 | 展示与动作 | 不变量 |
| --- | --- | --- |
| 发送→流式→完成 | 防重复提交，追加消息，展示真实终止原因 | 仅一个活动请求，不在重渲染时再次发送 |
| 停止→停止中→同步检查点 | 等待恢复后回到可操作；同步失败提供重试 | 不能把 abort 当作服务端任务已完成 |
| 审批→提交→服务端复检 | 显示提交状态；终态后禁用；失败允许重试 | 请求 ID、有效期及四种授权含义不变 |
| 配置/会话加载失败 | 就地错误与加载重试 | 保留原可见信息，不自动重跑任务 |
| revision 冲突 | 保留表单，提示刷新最新版本再重试 | 不无条件覆盖、不自动重复提交 |
| 未保存轮次 | 提供既有重试保存入口 | 不替换成重新调用模型 |
| 工具失败/超时/取消/轮数上限 | 工具卡和终止摘要分别展示 | 保留现有退出码、超时和失败证据 |
| 管理操作取消/断流 | 保留服务端返回结果；无终态显示未知/失败并刷新 | 复用 operationId 和 finally 清理，不制造成功 |

客户端操作不增加自动重试；现有超时和取消由原协议负责。页面层清理订阅、事件监听和 AbortController，不改变运行时安全上限。不可恢复错误保持阻塞并给出配置或历史查看入口。

## 模块与文件组织

以下路径是本轮计划范围；各组件对应样式采用同名 .module.css，需要时才创建。

| 文件/目录 | 操作与职责 |
| --- | --- |
| src/app/layout.tsx、globals.css | 修改：主题首屏、基础样式和变量 |
| src/components/ui/{button,dialog,field,status-notice}.tsx | 新增：基础交互与可访问语义，无领域请求 |
| src/components/{ui-state,theme-preference,draft-store,navigation-guard}.ts | 新增：视图类型、主题值校验、草稿与离开规则 |
| src/components/theme-control.tsx | 新增：主题选择 |
| src/components/use-chat-workspace.ts | 新增：迁移现有客户端请求、取消与恢复编排 |
| src/components/{workspace-shell,management-panel,environment-status}.tsx | 新增：布局、管理区域、阻塞与初始引导 |
| src/components/chat-workspace.tsx | 修改：组合工作台，不再堆积全部管理界面 |
| src/components/chat-session-state.ts、conversation-binding.ts、cancelled-turn-recovery.ts | 按需调整客户端整合，保留既有行为及测试 |
| src/components/{conversation-list,workspace-selector,chat-composer}.tsx | 修改：会话浏览、环境选择和输入操作 |
| src/components/{message-list,permission-request-card,permission-mode-control,context-compression-control}.tsx | 修改：输出、审批、上下文呈现 |
| src/components/{message-content,tool-execution-card}.tsx、markdown-content.ts | 新增：安全消息排版、工具详情及受限解析 |
| src/components/{skill-panel,conversation-background-panel,conversation-cleanup-panel}.tsx | 修改：宽面板和管理反馈 |
| src/components/settings/settings-panel.tsx、settings-operation.ts | 修改：设置导航与操作复用 |
| src/components/settings/use-settings.ts | 新增：公共设置状态与操作协调 |
| src/components/settings/{model-settings,workspace-settings,mcp-settings,runtime-settings,recovery-settings}.tsx | 新增：分区表单，不复制请求协议 |
| src/components 下对应 .test.ts/.test.tsx | 新增或调整：状态、安全和用户行为回归 |
| scripts/fixtures/ui-redesign-provider.ts、ui-redesign-scenarios.ts | 新增：确定性本地响应及隔离验收样本 |
| README.md | 修改：新入口说明；不写入截图、密钥或本机配置 |
| docs/specs/ui-interaction-redesign/checklist.md | 执行阶段回填证据与逐操作迁移记录 |

不计划改动 core、models、tools、runtime 或 API 的公开行为。如果 UI 无法通过现有安全接口实现已批准需求，先记录冲突并重新审批，不能在界面层绕过限制。

## Markdown 与依赖决策

保持零新增运行时依赖。需求是有限排版能力，不要求完整 CommonMark、语法高亮或插件生态：采用受限分块解析，生成判别联合节点，再由 React 以文本节点渲染。支持标题、段落、列表、引用、围栏代码、普通链接及管道表格；不支持结构回退为原文，保留“查看原文”和复制原文。

不使用 dangerouslySetInnerHTML，不解析原始 HTML；链接仅允许 http/https，外链带安全 rel；不自动加载远程图片，不把模型输出当作本地文件操作。未闭合代码围栏按代码文本呈现。解析缓存已完成消息，仅更新活动片段；限制嵌套深度和单次解析体积，超限回退可复制原文。使用线性扫描避免灾难性正则回溯。若完整排版兼容性成为必要需求，应重新评估依赖并审批。

## 安全与兼容

- UI 只渲染已有安全摘要，不回显原始敏感工具参数、环境变量或已保存密钥。
- 工作区移除仍不删除目录；清理、记忆删除和配置替换展示明确影响；服务端资格和版本判断是最终依据。
- 模型测试与 MCP 连接由显式操作触发，授权与保存分离；关闭页面时取消管理操作，不将保存解释为连接成功。
- 不修改导出格式及历史消息；Markdown 仅影响展示。CLI 与 Web 使用原共享运行时，验证中覆盖旧数据加载和 CLI 续接。

## 验证策略与性能口径

1. 单元/静态渲染：状态推导、草稿隔离、过期响应过滤、Markdown 恶意输入、授权和证据文案；使用现有 node:test/tsx，不以 CSS 类名作为主要验收目标。
2. 集成：保留 Web 会话、权限、设置、背景、清理和 Skills HTTP 测试，以及共享运行时和 CLI 回归。
3. 浏览器：agent-browser 在隔离数据下完成所有 AC。静态渲染测试不能替代焦点、滚动、输入法和请求次数验证。工具不支持某项时记录限制，并以实际手工观察补证；未执行不标通过。
4. 性能：同一机器、浏览器版本、生产模式、无 CPU/网络节流，记录设备与版本。样本固定 200 条消息、其中 50 条工具记录、每条正文 1KiB、一个 100KiB 工具输出，每 50ms 追加 20 字符共 10 秒。优化前后各预热一次、测量三次；记录输入至下一绘制和展开详情至下一绘制的 p95、超过 50ms 的长任务数量及最长耗时。目标交互 p95 ≤100ms，单次长任务不超过 200ms，已有历史不被滚动抢占；失败需定位和复验，不以肉眼“流畅”替代。基线在实现前采集；指标是待验证目标。
5. 安全夹具：ORBITCODE_DATA_DIR 指向临时目录，使用本地假凭据、loopback 模型和 MCP 替身；不能连接真实模型/外部 MCP。CLI 使用同一隔离目录。启动前确认环境及配置没有回落到真实资源。
6. 最终执行 npm test；随后依次 lint、typecheck、build，开发服务器浏览器检查与 tmux Agent 闭环，记录退出码、运行 ID 和清理结果。

## 关键取舍

| 决策 | 选择及理由 | 未采用 |
| --- | --- | --- |
| 布局 | 会话主导、管理按需打开，降低信息密度 | 继续在侧栏叠加面板 |
| 组件 | 原生语义控件和本地组件，避免新依赖 | 引入整套 UI 框架 |
| 状态 | 保留原 reducer/协议，只拆编排 | 同时重写运行时或持久化 |
| 消息 | 受限安全 Markdown，可退回原文 | 任意 HTML 或完整编辑器 |
| 草稿 | 会话草稿按标签页保存；敏感表单仅内存 | 把凭据持久化至浏览器 |

## 自检

F1–F12 均有模块映射；服务端语义、权限边界和 CLI 兼容未改变；文件范围、性能条件与异常恢复有明确归属。四份文档已由用户批准，后续范围调整以文首用户指示和最新实施记录为准。

## 历史实施记录（2026-10-18，手机布局及侧栏折叠部分已被后续桌面范围调整替代）

- 管理区域采用宽模态面板，桌面与窄屏共用原生 dialog；对话宿主持续挂载。该布局细化不改变管理入口、运行状态或服务端协议。
- 模型选择器独立为 `provider-selector.tsx`；设置路由读取分类参数。原 workspace selector、权限控件与上下文控件复用，未为拆分而复制代码。
- 设置保存期间禁用整个表单和内部导航，版本冲突保留输入并刷新 revision；重命名失败保留重试标题。初次设置加载在卸载时取消。
- 空模型/空工作区使用明确配置提示；工作台网格使用可收缩列，避免长内容将窄屏发送按钮挤出视口。未保存提示采用正常文档流，避免遮挡保存按钮。
- 未增加依赖，未修改 core/runtime/models/tools 或 HTTP/SSE 契约。详细验证与未覆盖场景以 checklist.md 为准。

## 阅读空间调整（2026-10-18 用户反馈）

用户明确反馈“显示内容的区域太小”，并授权必要时重新规划页面。本次在原功能范围内调整空间分配：

- 去掉窄屏独占一行的导航栏，将导航按钮放入同一个标题栏；桌面增加侧栏收起/展开按钮，展开 232px，收起后消息使用完整主区。
- 消息列由固定 880px 改为占满主区、上限 1520px，左右内边距随屏幕调整；保持原字号与代码、表格的局部滚动。
- 标题、环境选择和运行状态合并；审批、配置错误等重要提示仍位于消息区上方。
- 输入框从固定三行改为一行起步，自动随草稿增高，最多 min(180px,25dvh)，清空后收回；上下文压缩放入输入工具栏的展开菜单，状态异常在菜单标题提示；本地工具与凭据说明仍可展开查看。
- 本次没有更改 Agent、工具、权限、持久化协议或验收标准。空间测量及本次回归见 checklist.md 的追加记录。

## 桌面交互修复（2026-10-18）

- 用户明确取消手机支持，删除顶部导航按钮、桌面折叠状态、手机导航抽屉及专用手机断点；会话、管理、设置等桌面入口固定可见。
- 会话菜单、上下文和隐私说明共用 Popover：原生 details 分组互斥，点外部或焦点离开关闭；Esc 关闭并归还触发器焦点。
- 默认/严格/放行权限以紧凑标记保持可见，放行使用警示色；Next.js 开发悬浮入口通过 devIndicators: false 关闭，避免挡住输入操作。
- 浏览器复测和工程结果见 checklist.md 最新追加记录；历史测试结果不扩展为未执行场景通过。
