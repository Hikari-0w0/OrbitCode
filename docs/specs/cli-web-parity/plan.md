# CLI 与 Web 功能对齐 Plan

状态：已批准
依据：已批准的 [spec.md](spec.md)
流程：按用户授权连续生成全部文档，技术设计、任务和验收清单等已批准。

## 架构概览

CLI 独立运行，Web 和 CLI 调用同一个应用运行时。新增 `src/runtime/` 负责组合已有核心、模型、工具与本地基础设施；它属于应用编排层，不是另一套 Agent 框架。`src/core/` 保持原有领域职责，不依赖 `runtime`、Web 或终端。

```text
Web 路由（HTTP 校验、SSE） ─┐
                           ├→ runtime（配置、会话操作、单轮编排、运行记录）
CLI（输入路由、文本展示） ──┘       ├→ core（AgentLoop、ContextManager、权限契约）
                                  ├→ models / tools
                                  └→ lib（存储、导出、环境变量）
```

不是直接在 CLI 内复制 `/api/chat` 的实现，也不通过 HTTP 调用本机 Web。现有 Web 导出路径可保留为轻量兼容包装，最终运行逻辑只有一份。HTTP 同源、请求体限制与状态码映射继续留在 Web。

实施前源代码依据：`src/cli/main.ts` 使用 `InMemoryConversationSession`；`src/app/api/chat/route.ts` 组装 Agent、权限、上下文并保存结果；`src/web/chat-handler.ts` 同时承载 SSE 和运行统计；`src/lib/local-conversation-store.ts` 已提供 revision、写租约与中断恢复。上述为重构前基线；2026-09-18 已完成共享 runtime 抽取、Web 迁移和 CLI 接入，验证结果见 checklist。

## 需求映射

| 需求 | 负责模块/交互 | 设计说明 |
| --- | --- | --- |
| F1 | runtime 配置、CLI 参数和命令 | 统一解析配置与限制，Provider/Workspace 切换新建会话 |
| F2 | runtime 单轮编排、现有 AgentLoop/工具注册表 | 使用完整注册表和现有模型工具协议 |
| F3 | core 计划执行规则、会话服务、CLI 模式命令 | 共享计划有效性判断，显式执行计划 |
| F4 | runtime 权限会话、PermissionGateway、CLI 审批 | 复用规则与授权生命周期 |
| F5 | CLI 输入状态机、runtime 取消 | 输入读取与生成并行推进，审批按 ID 关联 |
| F6 | CLI renderer、runtime 事件 | 完整呈现 AgentEvent 与保存、日志状态 |
| F7 | runtime 会话服务、ContextManager | 自动与手动压缩使用同一实现 |
| F8 | runtime 会话服务、CLI 命令、现有 exporters | CRUD、历史与导出不依赖 Web 启动 |
| F9 | runtime 操作守卫、LocalConversationStore | 租约、CAS、恢复及重试保存 |
| F10 | runtime 清理、AgentLoop、ManagedProcessController | 共享停止策略和幂等资源回收 |
| F11 | runtime AgentRunTracker、LocalAgentRunLog | 统一事件统计，扩展现有入口来源枚举 |

## 核心类型与接口

以下为拟新增契约；引用的 AgentEvent、ConversationCheckpoint、ConversationSaveInput、PermissionUserDecision 等沿用现有类型，不复制定义。

```ts
type RuntimeSource = "web" | "cli";

type PersistenceState =
  | { readonly status: "saved"; readonly revision: number }
  | { readonly status: "failed"; readonly detail: string };

type RuntimeTurnEvent =
  | { readonly type: "agent"; readonly event: Exclude<AgentEvent, { type: "stopped" }> }
  | { readonly type: "warning"; readonly kind: "run-log" | "cleanup"; readonly detail: string }
  | {
      readonly type: "finished";
      readonly stopped: Extract<AgentEvent, { type: "stopped" }>;
      readonly persistence: PersistenceState;
    };

type RunTurnInput = {
  readonly conversationId: string;
  readonly expectedRevision: number;
  readonly permissionSessionId: string;
  readonly input: string;
  readonly mode: AgentMode;
  readonly modeTurn: number;
  readonly source: RuntimeSource;
  readonly signal: AbortSignal;
};

interface AgentRuntime {
  streamTurn(input: RunTurnInput): AsyncIterable<RuntimeTurnEvent>;
}

type ConversationMutation = {
  readonly conversationId: string;
  readonly expectedRevision: number;
};

interface ConversationService {
  list(): Promise<readonly ConversationSummary[]>;
  create(input: ConversationCreateInput): Promise<ConversationCheckpoint>;
  load(conversationId: string): Promise<ConversationCheckpoint>;
  rename(input: ConversationMutation & { readonly title: string }): Promise<ConversationCheckpoint>;
  clear(input: ConversationMutation): Promise<ConversationCheckpoint>;
  delete(input: ConversationMutation): Promise<void>;
  setMode(input: ConversationMutation & { readonly mode: AgentMode }): Promise<ConversationCheckpoint>;
  compress(input: ConversationMutation & { readonly signal: AbortSignal }): Promise<ManualCompressionResult>;
  retrySave(input: ConversationMutation): Promise<ConversationCheckpoint>;
  recover(input: ConversationMutation): Promise<ConversationCheckpoint>;
}

type ManualCompressionResult = {
  readonly report: CompressionReport;
  readonly checkpoint: ConversationCheckpoint;
};
```

`CompressionReport` 在实施时使用现有 `ContextManager.compressManually` 的返回类型，不另立协议。`compress` 无论是否产生新 revision 都返回当前 checkpoint，CLI 不猜测 revision 增量。配置摘要和公共限制从 `web/chat-contract` 中抽到 `runtime/types.ts`，Web 保留兼容类型导出。运行时错误以 `configuration / unavailable / busy / conflict / storage / invalid-input` 判别分类，Web 映射 HTTP，CLI 映射可读错误；工具失败仍走现有结构化工具结果。

`PermissionSessionManager` 的 create/beginTurn/decide/finish/close 等现有方法继续作为审批入口，CLI 不实现另一套 Broker。新类型不能把批准请求 ID 与工具 ID 混用。

## 状态与交互

### 单轮执行与保存

1. 从权威存储加载会话并解析其 Provider/Workspace；取得进程内操作守卫和磁盘写租约后重新核对 revision，冲突时在模型调用前退出。
2. 创建 ContextManager、CompletionTracker、受管进程控制器、完整工具注册表、权限 turn 和 AgentLoop；系统提示环境两端共用。
3. 写 active-turn 标记后启动 Agent；流式转发非终止事件，同时积累展示记录和运行统计。
4. 取得唯一 stopped 后，构造完整 checkpoint，先缓存 pending save，再用 expectedRevision 保存；成功后清理 pending save 和本轮标记。冲突不覆盖磁盘；失败保留进程内待保存结果并显示“未保存”。
5. 所有路径在 finally 结束审批、关闭受管进程、释放租约；各项清理独立执行，单项失败不能阻断其余清理。日志记录 Agent 原始终止与保存结果，不把清理错误改成第二个 stopped。
6. 尝试写运行日志，失败转为独立 warning；最终向仍连接的消费者发出一个 finished。Web 将其编码为原有 stopped+persistence，CLI 显示同一结果。

输入取消只终止模型、工具及待审批，保存和清理仍尽力完成。Web 断连时仍驱动后台收尾；CLI 退出等待有界收尾。强制杀进程只能依赖已有检查点和 active-turn 标记，不能保证保存最后一个增量。迭代器提前关闭也必须触发取消与清理，不能仅靠正常消费到 finished 释放资源。

### 终端输入状态机

| 状态 | 可接受操作 | 行为 |
| --- | --- | --- |
| idle | 普通文本、管理命令、Ctrl-C、EOF | 发起任务、管理会话或退出 |
| running | `/cancel`、审批命令、`/status`、`/exit`、Ctrl-C | 输入监听不等待 Agent 结束；普通文本拒绝并提示稍后重发 |
| awaiting-approval | `/approve <id> <once\|session\|permanent\|deny>` | 与 running 共用活动轮次；请求可有多个，只响应匹配 ID |
| cancelling/saving | `/status`、退出意图 | 不允许启动新任务或修改绑定，等待收尾 |
| unsaved | 查看、导出、`/retry-save`、退出 | 阻止继续模型运行和破坏性管理操作，避免丢失 pending save |
| read-only | 历史查看、导出、选择可用会话 | 绑定配置不可用时仍允许读取 |

使用一个 readline 输入读取者，把输入分派给命令处理和审批；不能在 `for await` 行读取内部等待完整 Agent 轮次后才读取审批。TTY 需要 stdin 与 stdout 均为 TTY。非 TTY 按行串行执行普通请求，不把后续业务行当审批答案；需要 ask 时立即拒绝当前请求，模型仍可收到拒绝结果。EOF 在当前轮次结束后不启动新请求，并取消仍等待输入的操作；不得留下无限等待。非 TTY 管线预先排队的完整行依序处理，再完成收尾；交互式 EOF 立即进入退出流程。退出码：正常退出 0，启动/存储致命错误 1，参数错误 2，非交互轮次未正常完成 1，外部 SIGINT 导致整个进程退出 130；交互式取消一轮后继续不退出进程。

### 命令表

| 命令 | 行为 |
| --- | --- |
| `/help`、`/status`、`/exit`、`/cancel` | 帮助、当前绑定和状态、退出、取消 |
| `/providers`、`/provider <name>` | 列表；校验成功后新建该 Provider 的 Do 会话 |
| `/workspaces`、`/workspace <id>` | 列表；仅选择配置授权的 Workspace |
| `/plan`、`/do`、`/execute-plan` | 切换模式；显式执行最新有效计划 |
| `/permissions <strict\|default\|permissive>` | 修改当前权限会话默认模式，不绕过硬边界 |
| `/approve <request-id> <once\|session\|permanent\|deny>` | 提交匹配当前运行的授权决定 |
| `/new`、`/conversations`、`/resume <id>` | 新建、列表、继续；resume 创建全新的权限会话 |
| `/history`、`/rename <title>` | 查看当前历史、重命名当前会话 |
| `/clear`、`/delete <id>` | 显示目标后要求 `/confirm <token>`，`/cancel` 放弃；非 TTY 不接受交互确认 |
| `/compress`、`/retry-save`、`/recover` | 手动压缩、重试保存、显式恢复中断标记 |
| `/tool <call-id>` | 从当前会话记录查看完整结果；卸载内容按引用分块读取 |
| `/export <path>` | 使用现有完整会话导出器导出 |

保留 `export-run` 子命令，新增 `export-conversation <id> [--output <path>]`，两者不要求模型配置有效。启动支持 `--config`（默认 cwd/orbitcode.yaml）、`--provider`、`--workspace`、`--resume`。`--resume` 与覆盖绑定的参数组合直接报错；多 Provider 未指定时维持现有显式选择语义。标题和路径使用命令后的剩余文本，支持空格，不引入 Shell 求值。仅完整匹配 `/plan`、`/do` 才切换，带正文的版本继续作为普通消息；未知控制命令报错，`//` 前缀表示把一个 `/` 作为普通文本发送。

### Plan、会话和恢复

计划有效性判断放入 `src/core/conversations/plan-execution.ts`，由 Web 展示状态与 CLI 共同使用。计划只在本次已观察到的最新成功 Plan 回复上生效，后续请求、绑定变化和清空使其失效；恢复历史不从普通文本猜测有效计划。执行时验证当前会话与 revision，切到 Do 后追加与 Web 相同的可见执行请求。modeTurn 按现有规则在切换时归零、实际请求时递增。

CLI 空闲模式切换以受保护的会话元数据保存支持重启恢复；Web 保持原有请求协议和模式保存时机，不改变页面交互。用户选择其他会话、Provider、Workspace 时关闭旧权限会话；跨进程不共享内存授权。

`/retry-save` 仅重试当前进程持有的同 revision 待保存结果，不重新调用模型，不执行工具，也不能恢复另一进程的内存。进程重启后通过 `/recover` 使用最近磁盘 checkpoint 与 active-turn 标记生成中断记录。共享会话仍以现有配置标识绑定；跨入口同名配置的实际含义需要一致，不新增配置内容指纹迁移。文档明确从相同配置根启动互通的前提。

## 模块设计与文件组织

| 文件/模块 | 职责与迁移来源 |
| --- | --- |
| `src/runtime/types.ts` | 运行事件、持久化结果、配置摘要和公共限制 |
| `src/runtime/config.ts` | 抽取 web/server-config 的环境、Provider 和迭代/时长解析，支持显式配置路径 |
| `src/runtime/workspace-config.ts`、`prompt-environment.ts` | 从 Web 移出目录授权解析和提示环境，移除 web 类型依赖 |
| `src/runtime/permission-session-manager.ts` | 移出当前 Web 权限会话管理，保持 TTL 和授权匹配语义 |
| `src/runtime/conversation-runtime-manager.ts`、`conversation-operation-guard.ts` | 移出当前进程内协调和磁盘租约组合 |
| `src/runtime/conversation-service.ts` | 汇集会话 CRUD、模式保存、手动压缩、恢复和重试保存，共用守卫 |
| `src/runtime/agent-runtime.ts` | 从 chat 路由抽取组装、执行、检查点、清理；注入配置/存储/权限实例便于隔离测试 |
| `src/runtime/agent-run-tracker.ts` | 从 chat-handler 抽取运行统计，不依赖 SSE |
| `src/core/conversations/plan-execution.ts` | 纯计划资格与执行请求规则，不依赖组件 |
| `src/cli/arguments.ts`、`main.ts` | 参数兼容、独立依赖组装、退出码、两种导出子命令 |
| `src/cli/commands.ts`、`session-controller.ts` | 命令解析、终端状态及会话切换，调用运行时与权限管理 |
| `src/cli/terminal-chat.ts` | 单一输入监听、异步生成、信号与退出 |
| `src/cli/renderer.ts`、`terminal-text.ts` | 事件展示、长输出摘要/详情、不可信控制序列净化 |
| `src/web/chat-handler.ts`、`src/app/api/chat/route.ts` | 保留 HTTP/SSE，调用 runtime；现有 Web 单例仅负责组合 |
| `src/app/api/conversations/**/route.ts` | 改为调用会话服务，保留请求校验、返回形状和状态码 |
| `src/web/chat-contract.ts` 与原有被迁移模块 | 兼容导出与适配，避免一次性更改所有调用者 |
| `src/components/chat-session-state.ts`、`chat-workspace.tsx` | 仅替换共享计划规则的调用，保留显示和交互 |
| `src/lib/local-agent-run-log.ts` 及 exporter | 将既有 source: web 扩展为 web/cli，验证器与导出保留字段；原 Web 记录继续有效 |
| `README.md`、`docs/evals/README.md`、`AGENTS.md` | 更新 CLI 实际能力、命令、诊断和共享目录职责；保留现有文档结构 |

测试文件与负责模块同目录，跨入口及进程测试放 `tests/`，具体清单见 task。存储格式保持 conversations-v1；运行日志沿用当前 schemaVersion 4，source 扩展为 web/cli，继续读取既有版本 3/4 的 Web 记录，不改写历史。缺失必要 source 的损坏记录仍按校验规则报错，不猜测来源。

## 安全与权限边界

- 直接调用现有 PermissionGateway、PreparedToolCall、路径和沙箱实现，保留执行前重检；默认模式为 default。
- 权限答案绑定 permissionSessionId、turnId、requestId。取消、过期、切换后的决定失效；永久规则写入失败与当前调用是否已允许分别报告。
- 终端 renderer 逐块处理跨 chunk 的 ANSI/OSC/控制字符，换行和制表符按文本处理，过滤光标控制、标题/剪贴板序列及能伪装界面的控制内容；原始持久化内容不因展示净化被改写。
- 模型文本不经过命令解析器。确认/审批只来自真实输入通道，明确使用应用生成的提示前缀。
- 配置凭据不传给 renderer 和日志追踪器；保留现有错误脱敏。测试用合成凭据，并检查参数、stdout/stderr、日志和导出。
- 受保护配置、符号链接、沙箱不可用等拒绝保持两端一致，不引入“CLI 直接执行 Shell”的旁路。

## 依赖决策与技术取舍

| 决策 | 选择与原因 | 未采用方案 |
| --- | --- | --- |
| CLI 运行方式 | 共享本地运行时，独立启动 | HTTP 依赖 Web 服务；CLI 复制编排 |
| 终端 UI | Node readline/stream，零新增运行时依赖 | 本轮引入全屏 TUI 框架 |
| 共享存储 | 现有 checkpoint、磁盘租约、revision | 另建 CLI 会话格式或仅用进程内锁 |
| 执行中输入 | 输入派发与 Agent 消费分离 | 阻塞等待整轮后再读审批 |
| 安全策略 | 复用现有默认模式与审批四选项 | 为脚本输入自动批准 |
| 分层迁移 | runtime 抽取并保留 Web 适配器 | core 导入 Web 模块或 HTTP 类型 |

## 验证策略

先用现有 Web 行为测试约束抽取，再接 CLI；共享核心无需复制单元测试，但适配层必须覆盖同一工具/权限/停止结果在两个入口的表现。注入存储、时钟、沙箱和 Provider 的本地替身，使超时、失败、并发和取消可重现。磁盘互斥必须用独立子进程验证，不能只用两个对象代替。

最后执行全套测试与 lint → typecheck → build；tmux 验证真实 TTY 输入、审批与取消，agent-browser 验证 Web 对话和跨入口继续。模拟 Provider 只证明可控协议闭环；真实 Provider 测试独立记录，未配置安全运行环境时标为未验证，绝不以模拟结果冒充。所有临时服务、tmux 会话、浏览器和子进程由测试收尾清理。
