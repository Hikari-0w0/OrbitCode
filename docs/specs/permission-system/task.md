# 五层权限系统 Tasks

状态：已批准
依据：已批准的 `spec.md` 与 `plan.md`；用户已明确持续批准中间门禁，直至四份文档生成完毕

## 文件清单

| 操作 | 文件 | 职责 | 对应需求 |
| --- | --- | --- | --- |
| 新建 | `src/core/permissions/types.ts` | 权限模式、目标、规则、评估与授权领域类型 | F5、F7、F8、F10–F12 |
| 新建 | `src/core/permissions/rules.ts`、`rules.test.ts` | 规则语法、精确/Glob 匹配及决策合并 | F5–F7 |
| 新建 | `src/core/permissions/evaluator.ts`、`evaluator.test.ts` | 显式规则与权限模式的统一评估 | F7–F9 |
| 新建 | `src/core/permissions/approval.ts` | 可取消授权端口、句柄和决定类型 | F10–F13 |
| 修改 | `src/tools/types.ts`、`registry.ts`、`registry.test.ts` | 声明式权限目标、不可变准备调用与单次参数校验 | F1、F12、F15 |
| 修改 | `src/tools/read-file.ts`、`write-file.ts`、`edit-file.ts`、`find-files.ts`、`search-code.ts`、`run-command.ts` | 为六个工具补充强类型权限目标元数据 | F1、F3–F5 |
| 修改 | `src/tools/default-registry.ts` | 组装全部具备权限元数据的默认工具 | F1 |
| 修改 | `src/tools/workspace.ts`、`workspace.test.ts`、`protected-paths.ts` | 规范真实路径、内部/外部符号链接及权限配置保护 | F3、F4、F15、F16 |
| 修改 | `src/tools/macos-seatbelt-sandbox.ts`、`macos-seatbelt-sandbox.test.ts` | 命令沙箱拒绝权限配置并保留既有隔离 | F4、F16 |
| 新建 | `src/tools/dangerous-command.ts`、`dangerous-command.test.ts` | 不可配置的危险命令分析与规则 | F2、F15 |
| 新建 | `src/tools/permission-config.ts`、`permission-config.test.ts` | 三层 YAML 读取、校验、合并输入与本地原子写入 | F5–F7、F11、F16 |
| 新建 | `src/tools/permission-target.ts`、`permission-target.test.ts` | 工具目标预解析、规范化与安全摘要输入 | F3–F5、F10、F12 |
| 新建 | `src/tools/permission-gateway.ts`、`permission-gateway.test.ts` | 五层权限顺序、授权等待与恢复复检 | F1、F2、F7–F16 |
| 修改 | `src/tools/mode-policy.ts`、`mode-policy.test.ts` | 组合 Plan/Do、准备调用和统一权限网关 | F1、F8、F9、F15 |
| 新建 | `src/web/permission-session-manager.ts`、`permission-session-manager.test.ts` | 服务端权限会话、模式、会话授权、等待项和 TTL | F9–F13 |
| 修改 | `src/core/tool-scheduler.ts`、`tool-scheduler.test.ts` | ask 调度边界、权限事件、顺序和取消 | F10–F15 |
| 修改 | `src/core/agent-events.ts`、`agent-loop.ts`、`agent-loop.test.ts` | 权限事件转发、拒绝后继续和唯一停止语义 | F10、F13、F14 |
| 修改 | `src/core/system-prompt/tool-use.ts`、`system-prompt.test.ts` | 提醒模型根据权限失败调整方案 | F14 |
| 修改 | `src/web/chat-contract.ts`、`chat-contract.test.ts` | 权限会话、决定 API 与 SSE 事件运行时校验 | F9–F13、F17 |
| 新建 | `src/web/permission-presentation.ts`、`permission-presentation.test.ts` | 有界风险信息与工具参数脱敏摘要 | F10、F17 |
| 修改 | `src/app/api/chat/route.ts`、相关 Route 测试 | 绑定权限会话、加载规则并组装权限网关 | F1、F6、F9、F13–F16 |
| 新建 | `src/app/api/permission-sessions/route.ts`、`[sessionId]/route.ts`、`[sessionId]/decisions/route.ts` | 创建、更新、关闭会话及提交决定 | F9–F13、F16 |
| 修改 | `src/components/chat-session-state.ts`、`chat-session-state.test.ts` | 权限模式、等待/提交/终态的页面状态机 | F9–F13、F17 |
| 新建 | `src/components/permission-mode-selector.tsx`、相关测试 | 三档权限模式控件 | F9、F17 |
| 新建 | `src/components/permission-request-card.tsx`、相关测试 | 风险展示与四种授权决定 | F10–F12、F17 |
| 修改 | `src/components/chat-workspace.tsx`、`chat-workspace.test.tsx`、`message-list.tsx`、`message-list.test.tsx`、`src/app/globals.css` | Web 会话协调、工具卡集成与响应式样式 | F9–F13、F17 |
| 新建 | `tests/web-permission-agent.e2e.test.ts` | 原 SSE 暂停、独立决定恢复、拒绝后模型继续的闭环 | F1、F10–F17 |
| 新建/修改 | `orbitcode.permissions.example.yaml`、`.gitignore`、`README.md` | 配置示例、忽略本地规则和用户文档 | F5–F9、F11、F16 |

## T1：建立权限领域类型、规则语法与模式矩阵

- 对应：F5、F7、F8，`plan.md` 的「核心类型与接口」「权限领域模型」
- 文件：`src/core/permissions/types.ts`、`rules.ts`、`rules.test.ts`、`evaluator.ts`、`evaluator.test.ts`、`approval.ts`
- 依赖：无

步骤：

1. 定义 `PermissionMode`、`PermissionDecision`、`PermissionSubject`、`PermissionRule`、`PermissionEvaluation`、公开原因和授权端口等判别联合。
2. 实现 `工具名(模式)` 解析，校验注册工具名、括号、目标类型、长度和通配符；无通配符使用完整相等，命令与路径分别使用有界 Glob 语义。
3. 实现返回全部匹配规则的匹配器，以及与层级、顺序、具体度无关的 `deny > ask > allow` 合并器。
4. 实现无匹配时的严格/默认/放行矩阵，并将 Plan/Do 禁止保留为更上游的独立约束。
5. 用表驱动测试覆盖三层、三决策、三模式、三工具种类和非法输入，不依赖文件系统或 Web。

验证：

- 运行：`npm test -- src/core/permissions/rules.test.ts src/core/permissions/evaluator.test.ts`
- 期望：退出码 `0`；规则冲突全部遵守固定优先级，模式仅在无匹配时生效。

## T2：把 Tool Registry 改造成强类型准备—执行两阶段

- 对应：F1、F12、F15，`plan.md` 的「工具准备与权限网关」「核心类型与接口」
- 文件：`src/tools/types.ts`、`registry.ts`、`registry.test.ts`、`default-registry.ts`、六个现有工具文件
- 依赖：T1

步骤：

1. 为工具契约加入强类型、声明式权限目标元数据，区分现有文件、写入目标、搜索起点和命令/cwd。
2. 增加不可变 `PreparedToolCall`：注册中心完成一次 Schema 校验并闭包保存输入，执行调用不再重新接收可替换参数。
3. 六个现有工具仅声明权限目标字段和用途；规则、模式、危险判断或 UI 信息不得进入工具 execute。
4. 注册时强制每个工具具备权限元数据；重复工具、缺少元数据、未知名称和无效参数继续安全失败。
5. 更新注册中心测试，证明准备失败无副作用、准备结果不能被外部替换，既有模型定义保持一致。

验证：

- 运行：`npm test -- src/tools/registry.test.ts src/tools/schema.test.ts src/tools/file-tools.test.ts src/tools/run-command.test.ts`
- 期望：退出码 `0`；参数只校验一次，所有默认工具均能准备并沿用既有执行结果。

## T3：强化 Workspace 真实路径与权限配置保护

- 对应：F3、F4、F15、F16，`plan.md` 的「Workspace 路径预检」「安全与权限边界」
- 文件：`src/tools/workspace.ts`、`workspace.test.ts`、`protected-paths.ts`、`src/tools/macos-seatbelt-sandbox.ts`、`macos-seatbelt-sandbox.test.ts`
- 依赖：T1

步骤：

1. 将现有路径解析整理为请求路径标准化、真实路径解析、`path.relative` 根包含检查和规范 POSIX 相对路径输出。
2. 允许解析后仍在 Workspace 内的内部符号链接，拒绝外部链接；读取、搜索、编辑、覆盖和新建目标分别保留正确语义。
3. 新建目标解析最近现有父目录；写入执行前重新确认父目录、目标身份、保护状态和根边界，延续原子提交冲突检测。
4. 将 `.orbitcode/permissions.yaml` 与 `.orbitcode/permissions.local.yaml` 加入文件、遍历和 Seatbelt 保护，但不影响服务端配置仓储访问。
5. 增加同前缀相邻目录、符号链接链、链接替换、缺失目标和受保护配置的自动化场景。

验证：

- 运行：`npm test -- src/tools/workspace.test.ts src/tools/file-tools.test.ts src/tools/macos-seatbelt-sandbox.test.ts`
- 期望：退出码 `0`；内部真实目标可用，所有外部、竞态和权限配置访问均在副作用前拒绝。

## T4：实现不可配置的危险命令硬拦截

- 对应：F2、F15，`plan.md` 的「危险命令检测器」
- 文件：`src/tools/dangerous-command.ts`、`dangerous-command.test.ts`
- 依赖：T1

步骤：

1. 实现有 token、长度、嵌套和递归深度上限的 POSIX shell 词法扫描，不执行或展开命令。
2. 建立代码内固定危险类别：根/Workspace 根破坏、磁盘设备擦写、广域权限或所有权修改、关机重启、广域进程终止、进程耗尽和安全边界禁用。
3. 扫描 `;`、`&&`、`||`、管道、命令替换及可静态提取的 `sh -c` 包装；高风险位置出现无法安全分析的动态构造时保守拒绝。
4. 返回稳定规则代码、风险等级和无敏感内容说明；不读取 YAML，也不提供覆盖入口。
5. 用安全字符串夹具覆盖直接、变体、链式、引用、转义、包装、动态与超限输入，并证明检测期间没有进程启动。

验证：

- 运行：`npm test -- src/tools/dangerous-command.test.ts`
- 期望：退出码 `0`；硬规则变体全部拒绝，常见安全开发命令不被误判为危险硬拦截。

## T5：实现三层权限配置读取与本地原子写入

- 对应：F5–F7、F11、F16，`plan.md` 的「权限配置仓储」
- 文件：`src/tools/permission-config.ts`、`permission-config.test.ts`
- 依赖：T1、T3

步骤：

1. 定义用户级、项目级和本地级固定位置，以及只有 `rules` 映射的严格 YAML Schema。
2. 使用现有 YAML 包禁用 alias、拒绝重复键与未知字段，并限制单文件 256 KiB、每层 512 条、总计 1536 条。
3. 缺失文件返回空规则；读取、解析、规则和边界错误返回不含绝对路径的 `permission-config`，不生成部分规则快照。
4. 实现本地级精确 `allow` 的幂等新增：保护已有规则语义，检查目录/文件 symlink 与身份，临时文件 fsync 后原子替换。
5. 写入后重新读取完整三层快照；若更强 `ask/deny` 仍匹配，保留其结果并返回可展示说明。
6. 测试缺失、合法、三层冲突、超限、alias、重复、不可写、符号链接、并发修改和 rename 失败清理。

验证：

- 运行：`npm test -- src/tools/permission-config.test.ts src/core/permissions/rules.test.ts`
- 期望：退出码 `0`；配置失败关闭，成功写入可重载且不破坏已有规则。

## T6：建立服务端权限会话与可取消授权代理

- 对应：F9–F13，`plan.md` 的「授权代理与权限会话管理器」「权限会话生命周期」
- 文件：`src/web/permission-session-manager.ts`、`permission-session-manager.test.ts`
- 依赖：T1

步骤：

1. 用加密随机 ID 创建进程内权限会话，默认模式为 `default`，首次聊天绑定 Workspace 与 Provider。
2. 保存会话精确目标授权、单一活动 Agent 轮次、等待项状态和安全展示信息；不保存模型历史或完整敏感正文。
3. 实现一次性 resolve、AbortSignal 取消、5 分钟等待过期、30 分钟空闲回收和显式 close，所有路径释放 timer/listener。
4. 会话决定仅接收 request ID 与枚举选择；完整参数指纹和目标键均取自服务端等待项。
5. 使用可注入时钟与 ID 测试重复、迟到、跨会话、跨 Workspace、参数指纹变化、关闭和 TTL，不做真实等待。

验证：

- 运行：`npm test -- src/web/permission-session-manager.test.ts`
- 期望：退出码 `0`；每个等待项至多解析一次，关闭或取消后无法被迟到决定唤醒。

## T7：完成统一权限网关与 Plan/Do 组合

- 对应：F1、F2、F7–F16，`plan.md` 的「工具准备与权限网关」「单个工具调用」
- 文件：`src/tools/permission-target.ts`、`permission-target.test.ts`、`permission-gateway.ts`、`permission-gateway.test.ts`、`mode-policy.ts`、`mode-policy.test.ts`
- 依赖：T2、T3、T4、T5、T6

步骤：

1. 将准备调用转换为路径或命令 `PermissionSubject`；路径使用规范真实相对路径，命令使用 trim 后原文和规范 cwd。
2. 严格实现 Plan/Do → 危险命令 → Workspace 边界 → 显式规则 → 无匹配模式默认 → 会话/人工确认的收紧顺序。
3. 让会话授权只满足相同目标的 `ask`；硬拒绝与 `deny` 不创建请求，`allow` 不访问授权代理。
4. 人工允许后重新解析目标、运行硬规则、加载规则并检查取消；变化后的目标或新增 `deny` 使授权失效且不执行。
5. 产生可区分、`sideEffect: none` 的权限错误和有限公开原因；未知内部异常失败关闭。
6. 表驱动测试三模式、Plan/Do、三层冲突、四种决定、等待中规则/路径变化及永久写入失败。

验证：

- 运行：`npm test -- src/tools/permission-target.test.ts src/tools/permission-gateway.test.ts src/tools/mode-policy.test.ts`
- 期望：退出码 `0`；所有允许调用都经过网关，任何后层都不能放宽前层拒绝。

## T8：把权限等待接入工具调度器与 Agent Loop

- 对应：F10、F13、F14、F15，`plan.md` 的「多工具调度」「Agent Loop、调度器与事件」
- 文件：`src/core/tool-scheduler.ts`、`tool-scheduler.test.ts`、`agent-events.ts`、`agent-loop.ts`、`agent-loop.test.ts`、`src/core/system-prompt/tool-use.ts`、`system-prompt.test.ts`
- 依赖：T7

步骤：

1. 为调度事件和 AgentEvent 加入 permission-requested/resolved 判别分支，不改变唯一 stopped 事件规则。
2. 调度器按 sequence 处理 ask；连续立即允许只读仍并发，ask、写入和命令继续形成串行边界。
3. tool-started 只在授权与复检完成后发出；等待时间不消耗工具 deadline，拒绝/过期直接产生有序 tool-result。
4. Agent Loop 将权限失败写入内部 tool 消息并继续下一次模型迭代；只有 AbortSignal/会话关闭走既有 cancelled 终止。
5. 更新系统提示，要求模型根据权限失败调整命令、路径或方案，但不把提示当安全判断。
6. 覆盖多工具、拒绝后恢复、过期、等待取消、新增 deny、最大迭代和 sideEffect 聚合。

验证：

- 运行：`npm test -- src/core/tool-scheduler.test.ts src/core/agent-loop.test.ts src/core/system-prompt/system-prompt.test.ts`
- 期望：退出码 `0`；权限请求与结果顺序正确，拒绝不崩溃，取消只产生一个停止事件。

## T9：新增权限会话 Web API 与严格传输合约

- 对应：F6、F9–F13、F16、F17，`plan.md` 的「Web 合约、路由与页面」
- 文件：`src/web/chat-contract.ts`、`chat-contract.test.ts`、`src/web/permission-presentation.ts`、`permission-presentation.test.ts`、`src/app/api/permission-sessions/route.ts`、`src/app/api/permission-sessions/[sessionId]/route.ts`、`src/app/api/permission-sessions/[sessionId]/decisions/route.ts`、`src/app/api/chat/route.ts`、相关 Route 测试
- 依赖：T5、T6、T8

步骤：

1. 定义创建会话、更新模式、关闭会话和提交决定的精确 JSON 合约；限制 body、ID、字段和枚举，并校验同源状态变更。
2. 聊天请求增加服务端签发的权限会话 ID；路由验证 Workspace/Provider 绑定，加载规则并组装 Agent、网关和授权代理。
3. 严格编码/解析 permission SSE 事件和新增工具错误种类，不允许未知字段或超限摘要进入浏览器。
4. 实现按工具的服务端安全摘要：路径、操作、大小、cwd、timeout 和脱敏截断命令；不发送写入正文、替换正文、绝对路径或疑似凭据。
5. 路由测试正常、重复、过期、跨会话、跨 Workspace、非同源、畸形 JSON、配置失败和关闭等待项。

验证：

- 运行：`npm test -- src/web/chat-contract.test.ts src/web/permission-presentation.test.ts src/web/permission-session-manager.test.ts src/web/chat-handler.test.ts`
- 期望：退出码 `0`；服务端是权限模式与决定的唯一事实来源，API 错误安全且不唤醒错误等待项。

## T10：实现 Web 权限模式与人工确认界面

- 对应：F9–F13、F17，`plan.md` 的「Web 人在回路」「Web 合约、路由与页面」
- 文件：`src/components/chat-session-state.ts`、`chat-session-state.test.ts`、`permission-mode-selector.tsx`、相关测试、`permission-request-card.tsx`、相关测试、`chat-workspace.tsx`、`chat-workspace.test.tsx`、`message-list.tsx`、`message-list.test.tsx`、`src/app/globals.css`
- 依赖：T9

步骤：

1. 扩展 reducer 表达服务端权限模式、等待请求、决定提交中和 resolved/result 终态，并把工具卡增加 awaiting-approval 状态。
2. 页面启动时创建权限会话；模式切换以服务端响应为准；聊天只发送会话 ID。
3. 在对应工具卡中展示安全摘要、风险、来源、Workspace、本地持久层级、过期信息和四种决定，具备可访问名称与键盘焦点。
4. 决策按钮只提交 session/request ID 和枚举；等待 SSE 最终事件，不在客户端推断授权或执行。
5. 等待中支持停止；清空、Workspace/Provider 切换先取消活动请求并关闭旧会话，再创建新会话。页面卸载使用 keepalive 关闭并由服务端 TTL 兜底。
6. 增加桌面/窄屏样式、长命令折行/截断、提交错误重试和无敏感原始参数断言。

验证：

- 运行：`npm test -- src/components/chat-session-state.test.ts src/components/chat-workspace.test.tsx src/components/message-list.test.tsx src/components/permission-mode-selector.test.tsx src/components/permission-request-card.test.tsx`
- 期望：退出码 `0`；页面所有状态只由合法服务端事件推进，四种决定和会话结束路径可辨认、可操作。

## T11：完成端到端权限闭环与回归测试

- 对应：F1、F10–F17，`plan.md` 的「验证策略」
- 文件：`tests/web-permission-agent.e2e.test.ts`、必要的既有 E2E 夹具
- 依赖：T10

步骤：

1. 用本地假 Provider 驱动“模型请求写入 → SSE 等待 → 独立决定 → 原 Loop 写入 → 模型最终回复”。
2. 覆盖本次允许、会话允许复用、永久允许重载、用户拒绝后模型改用安全方案。
3. 覆盖硬危险、Workspace 越界、显式 deny、规则冲突、等待过期、等待中取消/关闭和恢复前新增 deny。
4. 组合多个允许只读和需确认副作用调用，验证并发边界、sequence、tool-started 时机、sideEffect 与唯一 stopped。
5. 检查上游模型请求、SSE、DOM 等可观察数据不包含哨兵凭据、完整写入正文、权限配置内容或 Workspace 绝对路径。

验证：

- 运行：`npm test -- tests/web-permission-agent.e2e.test.ts tests/web-tool-agent.e2e.test.ts`
- 期望：退出码 `0`；新旧 Web Agent 闭环都完成且没有残留等待项或文件/命令副作用。

## T12：补齐配置示例、忽略规则和使用文档

- 对应：F5–F9、F11、F16，`plan.md` 的「权限配置仓储」「依赖决策」
- 文件：`orbitcode.permissions.example.yaml`、`.gitignore`、`README.md`
- 依赖：T5、T9、T10

步骤：

1. 提供只含非敏感示例的三决策规则文件，解释精确与命令/路径 Glob 差异。
2. 文档说明三个固定配置位置、层级无优先级、`deny > ask > allow`、三档默认矩阵和 Plan/Do 的更高约束。
3. 说明四种人工决定的作用域、永久允许默认本地层、强 ask/deny 冲突、会话结束条件和配置文件保护。
4. 将 OrbitCode 自身的本地权限文件加入 `.gitignore`；说明外部 Workspace 需由用户自行加入忽略规则，服务端不会修改其 `.gitignore`。
5. 明确危险命令与路径边界不可覆盖，以及本阶段不含网络规则、配额、审计、CLI 工具和公网认证。

验证：

- 运行：`npm run lint && npm run typecheck`
- 期望：退出码 `0`；示例 YAML 可由真实配置解析器读取，文档无密钥、绝对私人路径或与规格冲突的承诺。

## T13：执行完整项目与真实交互验证

- 对应：全部需求，`plan.md` 的「验证策略」
- 文件：只修复本轮实现或测试暴露的相关文件；不创建提交、PR 或部署产物
- 依赖：T11、T12

步骤：

1. 依次运行完整测试、Lint、类型检查和生产构建；失败时只在既定权限系统范围内定位修复。
2. 启动开发服务器，使用浏览器完成三种权限模式、四种决定、桌面/窄屏、停止/清空/切换/关闭及控制台检查，结束后关闭浏览器和服务器。
3. 在 tmux 中用安全临时 Workspace 和未入库配置跑真实 Agent Loop，覆盖工具失败、无效参数、命令超时、拒绝后调整和最大迭代。
4. 检查无残留进程、等待项、临时权限文件、截图、日志或真实凭据；记录实际证据供 `checklist.md` 逐项勾选。

验证：

- 运行：`npm run test && npm run lint && npm run typecheck && npm run build`
- 期望：全部退出码 `0`；浏览器与 tmux 场景产生可记录证据且结束后资源清理完成。

## 执行顺序

```text
T1 ──→ T2 ───────────────┐
 ├──→ T3 ──→ T5 ────────┤
 ├──→ T4 ────────────────┤
 └──→ T6 ────────────────┤
                          ↓
                         T7 → T8 → T9 → T10 → T11 ──┐
                                     └──────→ T12 ──┴→ T13
```

T2、T3、T4、T6 在 T1 完成后可并行；T5 依赖 T3。T7 汇合所有安全基础能力，此后按服务端核心、Web 合约、UI、端到端顺序推进。每个任务先执行自己的验证，T13 只做完整回归和真实环境验收，不替代前述任务测试。
