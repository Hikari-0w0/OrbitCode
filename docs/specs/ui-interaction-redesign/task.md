# Web 人机交互与视觉重构 Tasks

状态：已批准
范围更新：2026-10-18 用户取消手机支持，历史任务中的手机抽屉与专用移动适配不再实施。
依据：同目录已批准的 spec.md、plan.md。

## 文件清单与执行原则

plan.md「模块与文件组织」为完整文件范围，下面逐任务指定文件和职责。同名样式模块与测试随所属组件任务创建，不生成空模块。使用现有 TypeScript、node:test、tsx、React 与 CSS，不增加运行时依赖。

只调整展示和客户端编排；若发现需要改变运行时协议或已批准范围，暂停并更新文档。用户已有改动必须保留。每项完成先验证再报告；测试失败不能进入“已完成”。本任务单不包含提交、推送或部署。

## T1：建立功能迁移与性能基线

- 对应：F1–F12、N1/N5/N7；计划「验证策略与性能口径」。
- 文件：新建 scripts/fixtures/ui-redesign-provider.ts、ui-redesign-scenarios.ts；更新 checklist.md 的逐操作证据记录。
- 依赖：四份文档批准。
- 步骤：
  1. 核对当前 Git 状态、AGENTS.md 和 B1–B13，逐个操作登记旧入口；新发现能力先补基线，不能漏掉后再以范围外处理。
  2. 制作隔离目录样本和确定性本地 OpenAI 兼容响应，涵盖正常文字、工具、审批、计划、失败、延迟、断流及固定长会话；复用既有测试模式，不读取真实配置。
  3. 固定夹具命令入口：`npx tsx scripts/fixtures/ui-redesign-scenarios.ts --data-dir <临时目录> --prepare` 初始化；`npx tsx scripts/fixtures/ui-redesign-provider.ts --port <空闲端口>` 启动本地替身。参数须显式指定，不使用真实默认目录。
  4. 以 agent-browser 记录旧界面核心状态和性能三次测量；截图与日志仅留本机非入库位置。
- 验证：夹具只访问 loopback 和临时目录；可重建同一长会话；正常/错误响应均可被现有客户端消费；记录性能基线及每个操作旧入口。运行 `npm test` 留基准退出状态，已有失败单独说明。

## T2：定义客户端视图与草稿契约

- 对应：F4/F5/F11/F12；计划「客户端类型与接口」「状态与错误处理」。
- 文件：新建 ui-state.ts、theme-preference.ts、draft-store.ts、navigation-guard.ts 及对应测试；按需调整 chat-session-state.ts 和测试。路径均位于 src/components/。
- 依赖：T1。
- 步骤：
  1. 落实主题、overlay、availability、operation 的判别联合；availability 从现有领域状态推导。
  2. 实现按会话隔离的 sessionStorage 草稿及内存降级；定义提交接受、失败、切换和删除时机。
  3. 定义内部导航和 beforeunload 的未保存保护规则，敏感表单仅内存。
- 验证：`npx tsx --test src/components/ui-state.test.ts src/components/theme-preference.test.ts src/components/draft-store.test.ts src/components/navigation-guard.test.ts src/components/chat-session-state.test.ts`；覆盖不同阻塞原因、会话隔离、存储抛错、未保存导航和 reducer 旧行为；`npm run typecheck`。

## T3：统一基础视觉、主题和弹层

- 对应：F2/F11；计划「视觉规范」「窄屏与交互层级」。
- 文件：src/app/layout.tsx、globals.css；新增 src/components/ui/{button,dialog,field,status-notice}.tsx、theme-control.tsx 及对应样式和语义测试。
- 依赖：T2。
- 步骤：
  1. 建立主题和语义色变量、字号、间距、圆角及焦点规则。
  2. 实现原生语义基础组件与 dialog 开关、焦点归还、背景不可操作。
  3. 接入主题偏好 cookie 和系统媒体查询；设置可用且首屏无 hydration 警告。
- 验证：`npm run typecheck`；真实浏览器切换主题、刷新、改变系统主题，检查两种配色对比度及减少动画；键盘打开/关闭弹层并验证焦点；以浏览器实际行为记录结果，不能仅靠静态测试判定通过。

## T4：拆分工作台编排并接入新布局

- 对应：F1/F4/F11/F12；计划「架构概览」「桌面工作台」。
- 文件：新增 src/components/use-chat-workspace.ts、workspace-shell.tsx、management-panel.tsx、environment-status.tsx；修改 chat-workspace.tsx、workspace-selector.tsx 及相关测试/样式；复用 conversation-binding.ts、cancelled-turn-recovery.ts。
- 依赖：T2、T3。
- 步骤：
  1. 将现有请求、事件订阅和恢复迁入稳定宿主 hook，保持事件和服务端契约。
  2. 接入固定桌面导航、消息主区和管理区域，保留所有入口。
  3. 增加首次配置引导、阻塞原因和可恢复操作；防止旧请求响应覆盖新会话。
  4. 确保打开管理区域不卸载对话、不重复请求，去设置前处理运行中状态。
- 验证：`npx tsx --test src/components/chat-workspace.test.tsx src/components/conversation-binding.test.ts src/components/cancelled-turn-recovery.test.ts src/components/chat-session-state.test.ts`；浏览器慢请求时切换视图，检查请求次数、当前会话和所有导航路径；`npm run typecheck`。

## T5：会话管理、输入与导航保护

- 对应：F3/F5/F12；计划「客户端类型与接口」「状态与错误处理」。
- 文件：src/components/conversation-list.tsx、chat-composer.tsx、chat-workspace.tsx、use-chat-workspace.ts、navigation-guard.ts、draft-store.ts 及对应测试/样式；对话框使用 T3 基础组件。
- 依赖：T4。
- 步骤：
  1. 用可浏览列表和搜索替换会话下拉框，接回新建/改名/删除/清空/导出及历史恢复。
  2. 原生 prompt/confirm 替换为应用内表单，说明删除和清空影响。
  3. 接入会话草稿、发送去重、IME 防误发送及停止中状态；保留 Plan/Do 与最新计划执行条件。
  4. 验证运行中导航和未保存退出的取消、停止等待、继续操作。
- 验证：`npx tsx --test src/components/conversation-list.test.tsx src/components/chat-composer.test.tsx src/components/draft-store.test.ts src/components/navigation-guard.test.ts src/components/chat-workspace.test.tsx`；真实浏览器完成 AC3/AC5，尤其切换后草稿、导出内容、中文候选确认和停止后记录；`npm run typecheck`。

## T6：安全消息排版与工具时间线

- 对应：F6/N2/N5；计划「Markdown 与依赖决策」。
- 文件：新增 src/components/markdown-content.ts、message-content.tsx、tool-execution-card.tsx；修改 message-list.tsx 与对应测试/样式。
- 依赖：T3、T4。
- 步骤：
  1. 实现受限分块解析与 React 安全文本渲染；未知、超限或未闭合结构可退回可读原文。
  2. 加入复制消息/代码与原文查看；复制失败显示反馈，不假装成功。
  3. 提取工具卡，保留顺序、参数安全摘要、输出、耗时、Token、验证证据及终止原因。
  4. 完成消息缓存、历史阅读不抢滚动、最新消息入口及长内容局部滚动。
- 验证：`npx tsx --test src/components/markdown-content.test.ts src/components/message-content.test.tsx src/components/message-list.test.tsx`；恶意标签、危险链接、嵌套和长输入测试；浏览器完成 AC6 并重测性能目标；`npm run typecheck`。

## T7：审批与上下文状态

- 对应：F7、F8 的 B6；计划「状态与错误处理」。
- 文件：src/components/permission-request-card.tsx、permission-mode-control.tsx、context-compression-control.tsx、workspace-shell.tsx、message-list.tsx 与测试/样式。
- 依赖：T4、T6。
- 步骤：
  1. 审批默认展开，顶部显示待审批数量与定位入口；较小桌面窗口不隐藏风险和作用范围。
  2. 保留三种权限模式和四种决定；明确提交后等待服务端复检，处理失败、过期和重复点击。
  3. 将压缩置于输入附近，保留估算来源、前后值、失败与熔断恢复。
- 验证：`npx tsx --test src/components/chat-workspace.test.tsx src/components/message-list.test.tsx src/components/context-compression-control.test.tsx src/web/permission-routes.test.ts`；浏览器逐项完成 AC7 与压缩成功/失败/熔断；`npm run typecheck`。

## T8：Skills、背景记忆和历史清理

- 对应：F8/F9；计划「桌面工作台」「安全与兼容」。
- 文件：src/components/skill-panel.tsx、conversation-background-panel.tsx、conversation-cleanup-panel.tsx、management-panel.tsx 与测试/样式。
- 依赖：T4、T5。
- 步骤：
  1. 迁入宽面板并清除无效工具类，统一加载/空态/错误/操作反馈。
  2. 保留 Skill 各状态、参数调用和停用，背景来源、提取状态及两种记忆作用域。
  3. 记忆编辑加脏表单保护、冲突保留和删除确认。
  4. 清理维持预览、资格、选择上限和服务端执行结果，处理当前会话被删除及部分失败。
- 验证：`npx tsx --test src/components/skill-panel.test.tsx src/components/conversation-background-panel.test.tsx src/components/conversation-cleanup-panel.test.tsx src/web/skill-http.test.ts src/web/background-http.test.ts src/web/conversation-cleanup-http.test.ts`；浏览器完成 AC8/AC9，记录查看与执行请求的区别；`npm run typecheck`。

## T9：分区设置与完整管理流程

- 对应：F4/F10/F12；计划「设置与首次使用」「安全与兼容」。
- 文件：src/components/settings/settings-panel.tsx、settings-operation.ts；新增 use-settings.ts、model-settings.tsx、workspace-settings.tsx、mcp-settings.tsx、runtime-settings.tsx、recovery-settings.tsx 及测试/样式；复用 theme-control.tsx 和导航守卫。
- 依赖：T3、T4、T5。
- 步骤：
  1. 按计划分类拆分现有表单，use-settings 保留共享 DTO、管理 token、revision 和操作取消机制。
  2. 模型/工作区/MCP 列表与编辑分离，原字段和操作逐项迁移；实现输入校验和提交状态。
  3. 保留配置导入、损坏备份恢复、轮数/时间/默认权限模式，接入外观设置。
  4. 内部分类切换、回到对话和浏览器退出均处理未保存编辑；凭据仅内存，不回显保存值。
  5. 连接测试和 MCP 连接独立可取消，页面离开清理控制器，不能因分类切换重复发起。
- 验证：`npx tsx --test src/components/settings/settings-panel.test.tsx src/components/settings/settings-operation.test.ts src/web/settings-contract.test.ts src/web/settings-operations.test.ts src/runtime/settings-service.test.ts`；浏览器完整执行 B10–B13，含默认权限模式、冲突、恢复、取消测试；`npm run typecheck`。

## T10：整体验收、回归与交付说明

- 对应：F1–F12/N1–N7；计划「验证策略与性能口径」。
- 文件：README.md、checklist.md；必要修复限定在前述文件范围。
- 依赖：T1–T9。
- 步骤：
  1. 逐操作回填 B1–B13 新入口及证据，完成规定尺寸、缩放、主题、焦点和全部异常检查。
  2. 用同一性能夹具与条件测量三次并对比基线；未达标定位后复验。
  3. 执行 `npm test`，再依次执行 `npm run lint`、`npm run typecheck`、`npm run build`，记录各自退出码。
  4. 在开发服务器中使用 agent-browser 检查真实交互、错误覆盖层及控制台；tmux 中用隔离配置完成 Agent 正常/失败/无效参数/超时/最大轮数闭环，验证 CLI 加载与续接历史。
  5. 更新入口说明；关闭浏览器与本轮服务器/替身/tmux 会话，核对没有关闭用户已有进程。
  6. 逐项记录通过/失败/未验证，输出数量、证据和环境限制。设计批准不代表产品验收。
- 验证：checklist.md 中每项有结果和证据；`git diff --check` 无格式错误；无凭据、截图、日志或生成测试数据进入待提交文件。未通过项修复并重测，环境缺失则明确未验证。

## 执行顺序与覆盖自检

按 T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 执行；依赖列表说明最小前置条件，不代表授权并行代理。

基础类型和契约先于 UI，既有共享运行时不重建；全部计划模块均有任务归属。每项验证关注行为和安全约束，涉及展示的任务均需浏览器观察，不能用静态标记测试替代交互验收。

## 执行进度（2026-10-18）

T1 已建立隔离夹具、基线和性能测量；T2–T9 的实现已接入并通过相关单元/组件测试及已执行的浏览器流程。T10 的工程回归通过，完整人工行为验收仍有未覆盖项，不能将实现状态当作全部验收完成。

实际测试文件以仓库为准：设置异步操作由 `settings-operation.test.ts` 验证，设置整页由 agent-browser 验证，未创建原计划的 `settings-panel.test.tsx`。主题、草稿、导航、可用性、Markdown 和 composer 均有新增测试。运行全量测试时显式包含 `.test.tsx`，因为 `npm test` 默认发现范围未包含所有 TSX 文件。

发现并修复的浏览器问题：未保存提示遮挡按钮、窄屏隐式网格最小宽度、首次配置提示优先级。修复后重新执行 lint → typecheck → build（均退出 0），全量显式测试 615/615；细项验收及剩余工作见 checklist.md。

## 本轮布局调整（2026-10-18）

根据用户反馈，在 T3/T4/T5 范围内调整 globals.css、workspace-shell.tsx、chat-workspace.tsx、chat-composer.tsx：合并头部、放宽消息区、可收起侧栏、输入自适应和工具栏展开。相关组件测试及显式全量 615/615 通过，按序 lint/typecheck/build 均退出 0；桌面、平板及 320px 窄屏均验证发送按钮可见。既有 35 项验收的未覆盖项继续保留，不因本轮布局调整视为通过。

## 桌面交互修复任务（2026-10-18）

修改 workspace-shell.tsx、chat-workspace.tsx、chat-composer.tsx、conversation-list.tsx、globals.css、next.config.ts，新增 ui/popover.tsx。移除含义不清的顶部按钮和移动导航分支；修复浮层互斥、Esc、点外部关闭及焦点归还；保持审批状态可见，关闭开发悬浮标识。验证采用真实浏览器事件复测已复现缺陷，并执行既有全量测试和规定工程检查。
