# 本地持久化对话历史 Tasks

状态：已批准
依据：已批准的 `spec.md` 与 `plan.md`

> 用户已授权连续完成四份规划文档；最终实现仍等待整套文档审核。

## 文件清单

| 操作 | 文件 | 职责 | 对应需求 |
| --- | --- | --- | --- |
| 新建 | `src/core/conversations/types.ts` | Conversation 摘要、checkpoint、显示消息、保存结果与错误类型 | F1、F4、F6、F12、F13 |
| 新建 | `src/core/conversations/repository.ts` | 持久仓库抽象和操作契约 | F2、F3、F9、F10、F12 |
| 新建 | `src/core/conversations/validation.ts` | checkpoint 严格校验和协议不变量 | F1、F7、F16 |
| 新建 | `src/core/conversations/display-timeline.ts` | 从 Agent 事件构建可持久的终态显示记录 | F4、F6 |
| 修改 | `src/core/context/context-manager.ts`、`src/core/context/types.ts` | 导出和恢复完整已提交 Context 状态 | F7、F8、F14 |
| 新建 | `src/lib/local-conversation-store.ts` | 版本化本地仓库、CAS、文件锁、删除和上下文对象 | F2、F8、F9、F10、F12、F14、F16 |
| 修改/删除 | `src/lib/local-context-store.ts` | 将临时 session 作用域迁移到稳定 Conversation 作用域 | F8 |
| 新建 | `src/web/conversation-runtime-manager.ts`、`src/web/conversation-runtime-store.ts` | Runtime 缓存、绑定恢复、互斥运行、提交与未保存重试 | F4、F5、F6、F11、F12、F13、F14 |
| 新建 | `src/web/conversation-http.ts` | Conversation 结构化 HTTP 错误映射 | F5、F9、F11、F16 |
| 修改 | `src/web/chat-contract.ts` | Conversation API、版本请求和保存状态事件协议 | F2–F6、F9–F16 |
| 修改 | `src/web/chat-handler.ts` | 缓冲终止事件并在持久提交后发送唯一 stopped | F6、F12、F13、F14 |
| 修改 | `src/app/api/chat/route.ts` | 以 conversationId 打开 Agent 轮次 | F4、F6、F7、F12、F16 |
| 新建 | `src/app/api/conversations/**/route.ts` | 列表、创建、详情、重命名、清空、删除、压缩和重试 | F2–F5、F8–F13、F15、F16 |
| 删除 | `src/app/api/context-sessions/**` | 移除由页面生命周期驱动的临时会话 API | F5、F8 |
| 修改 | `src/components/chat-session-state.ts` | hydrate、revision、保存状态和只读状态 | F1、F4、F5、F11、F13 |
| 新建 | `src/components/conversation-list.tsx` | 多对话列表及管理操作 | F2、F3、F4、F9、F15 |
| 修改 | `src/components/chat-workspace.tsx` | 启动恢复、切换、持久聊天请求和操作协调 | F3–F6、F9–F15 |
| 修改 | `src/components/message-list.tsx` | 恢复后的工具、终止、Token 和耗时展示 | F4、F6 |
| 修改 | `src/web/agent-run-log-store.ts`、`src/lib/local-agent-run-log.ts` | 日志关联稳定 conversationId，不改变脱敏策略 | F1、N10 |
| 新建/修改 | 相应 `*.test.ts(x)` 与 `tests/web-conversation-persistence.e2e.test.ts` | 各任务同行验证与跨重启闭环 | 全部 |

## T1：固定 Conversation 领域契约

- 对应：F1、F3、F4、F6、F7、F12、F16，`plan.md` 的「核心类型与接口」「Conversation 领域模型」
- 文件：`src/core/conversations/types.ts`、`repository.ts`、`validation.ts`、`display-timeline.ts` 及对应测试
- 依赖：无

步骤：

1. 定义 versioned checkpoint、轻量 summary、binding、持久显示消息、保存状态和结构化失败联合。
2. 定义 Repository 接口和 revision/CAS 语义，不引入 Node 或 Web 类型。
3. 实现严格 checkpoint 校验：字段集合、容量、时间、revision、终态消息、工具调用/结果配对和 offloaded 引用形状。
4. 实现默认标题派生与显示时间线构建；剔除进度、待授权、回调和完整工具参数等运行态数据。

验证：

- 运行：`npx tsx --test src/core/conversations/*.test.ts`
- 期望：合法成功/中断 checkpoint 可往返；非法版本、未知字段、孤立工具结果、运行中状态、越界标题和载荷全部失败关闭。

## T2：让 ContextManager 可安全持久恢复

- 对应：F7、F8、F14，`plan.md` 的「ContextManager 持久快照」
- 文件：`src/core/context/context-manager.ts`、`src/core/context/types.ts`、`src/core/context/context-manager.test.ts`
- 依赖：T1

步骤：

1. 增加仅包含已提交 managed messages 与摘要失败计数的持久状态。
2. 从经验证状态构造 ContextManager，恢复工具 transcript、摘要、边界、中断和 offloaded 引用。
3. 明确不恢复 active turn、PromptEnvelope、usage 锚点、AbortSignal 和临时压缩状态；恢复后估算标记为 approximation。
4. 增加导出时拒绝活动 turn、深拷贝不可变和引用一致性测试。

验证：

- 运行：`npx tsx --test src/core/context/context-manager.test.ts src/core/context/message-groups.test.ts`
- 期望：复杂 Context 状态重建后 Provider 消息协议一致；活动状态不能被持久化，恢复不伪造 usage 锚点。

## T3：实现版本化本地 Conversation Repository

- 对应：F2、F3、F8、F9、F10、F12、F14、F16，`plan.md` 的「本地 Conversation Repository」
- 文件：`src/lib/local-conversation-store.ts`、`src/lib/local-context-store.ts` 及对应测试
- 依赖：T1；可与 T2 并行

步骤：

1. 创建仅当前用户可访问的版本化根目录和 Conversation 子目录，实现 head、不可变 revision、context 对象和 active-run 标记。
2. 实现临时文件独占创建、完整写入、同步、rename 提交点和上一版本保留；列表只读取 head。
3. 实现 expectedRevision CAS、进程内串行队列和带 owner/PID/心跳的跨进程目录租约。
4. 实现损坏对话隔离、未知版本拒绝、符号链接/真实路径越界拒绝以及单项/总体容量限制。
5. 实现清空、删除状态机和失败恢复；删除清理完成前保持明确状态。
6. 让上下文对象使用稳定 conversationId 作用域，普通空闲清理不再删除被对话引用的对象。

验证：

- 运行：`npx tsx --test src/lib/local-conversation-store.test.ts src/lib/local-context-store.test.ts`
- 期望：原子失败保留旧 head；列表不读取 revision 正文；CAS、并发锁、陈旧租约、权限、损坏隔离、清空/删除失败和引用生命周期均有真实临时目录证据。

## T4：实现 Conversation Runtime Manager

- 对应：F4–F8、F11–F14，`plan.md` 的「Conversation Runtime Manager」「状态与交互」
- 文件：`src/web/conversation-runtime-manager.ts`、`src/web/conversation-runtime-store.ts` 及对应测试
- 依赖：T1、T2、T3

步骤：

1. 从 Repository checkpoint 与当前 Catalog 创建可执行 Runtime，或为不可用绑定返回只读快照。
2. 按 conversationId 管理单一活动 Agent/压缩/管理操作，校验 binding 和 expectedRevision。
3. Agent 开始前写 active-run 标记；终止后把显示时间线与 Context 持久状态组合成同一新 revision。
4. 保存失败时保留一个有界未保存 checkpoint，提供无浏览器正文参与的服务端重试；成功后清除状态和活动标记。
5. 将 TTL 改为只释放内存 Runtime；重新打开从磁盘恢复。
6. 检测异常退出标记，恢复最后 checkpoint 并暴露 `lastRunInterrupted`。

验证：

- 运行：`npx tsx --test src/web/conversation-runtime-manager.test.ts`
- 期望：打开/释放/重建、不可用绑定、互斥、版本冲突、保存失败重试和异常恢复行为通过。

## T5：建立严格 Conversation Web API

- 对应：F2–F5、F9–F13、F15、F16，`plan.md` 的「Web API 与流协调」
- 文件：`src/web/chat-contract.ts`、`src/web/conversation-http.ts`、`src/app/api/conversations/**/route.ts` 及对应测试
- 依赖：T4

步骤：

1. 定义并解析列表、创建、详情、重命名、清空、删除、压缩和重试保存合约。
2. 详情仅返回 display checkpoint、binding、revision 和能力状态，不返回 managed transcript、推理内容或完整工具参数。
3. 将聊天请求改为 conversationId + expectedRevision + 本轮输入；拒绝浏览器历史和路径字段。
4. 将绑定缺失、损坏、冲突、忙碌、容量和存储失败映射为稳定 HTTP code。
5. 实现同源、请求体上限、ID/标题/版本校验以及破坏性操作的服务端约束。

验证：

- 运行：`npx tsx --test src/web/chat-contract.test.ts src/web/conversation-routes.test.ts`
- 期望：所有正常 API 往返通过；未知字段、正文覆盖、伪造 ID、陈旧版本和非法操作被结构化拒绝。

## T6：把 Agent 流与持久提交组成一个终止闭环

- 对应：F6、F7、F12、F13、F14，`plan.md` 的「Agent 轮次与持久提交」
- 文件：`src/web/chat-handler.ts`、`src/app/api/chat/route.ts`、`src/core/agent-loop.ts`、日志关联代码及对应测试
- 依赖：T4、T5

步骤：

1. Chat Route 通过 Runtime Manager 获取 turn handle，不再接收临时 Context Session ID。
2. Chat Handler 流式转发非终止事件并构建显示时间线；捕获 stopped 后等待 Agent finally 完成。
3. 在发送唯一 Web stopped 前保存 checkpoint，并附带 `saved/revision` 或 `failed/retryable` 状态。
4. 消费者取消后仍等待底层 Agent 安全收敛和持久尝试；禁止第二个终止事件。
5. 本地运行日志改为关联稳定 conversationId，仍只记录脱敏指标；日志失败不改变 checkpoint 结果。

验证：

- 运行：`npx tsx --test src/web/chat-handler.test.ts src/core/agent-loop.test.ts tests/web-conversation-persistence.e2e.test.ts`
- 期望：成功、取消、最大迭代、模型错误和保存失败均只有一个终止事件；客户端收到 saved 时磁盘 checkpoint 已可重新加载。

## T7：实现多对话 Web 交互

- 对应：F2–F5、F9–F11、F13、F15，`plan.md` 的「Web UI」
- 文件：`src/components/conversation-list.tsx`、`chat-session-state.ts`、`chat-workspace.tsx`、`message-list.tsx`、`src/app/globals.css` 及对应测试
- 依赖：T5、T6

步骤：

1. 增加响应式对话列表，展示标题、绑定、更新时间和异常状态；支持新建、选择、重命名和删除确认。
2. 增加详情 hydrate action，一次恢复 revision、绑定、模式、消息、工具卡、Token、停止原因和运行时间。
3. 浏览器仅保存最近 conversationId；启动时在 catalog 就绪后恢复，有错误时保留列表供选择。
4. Workspace/Provider 变化改为创建新绑定对话，不清除旧记录；活动 Agent 时禁用切换和破坏操作。
5. 展示保存中、已保存、未保存可重试、上次运行中断和绑定不可用只读状态。
6. 清空/删除使用明确确认；失败不提前修改 UI 列表或消息。

验证：

- 运行：`npx tsx --test src/components/conversation-list.test.tsx src/components/chat-session-state.test.ts src/components/message-list.test.tsx`
- 期望：列表管理、hydrate、切换隔离、禁用条件、确认、保存状态和只读状态均按用户可观察行为通过。

## T8：完成旧临时会话迁移与清理

- 对应：F5、F8、F15，`plan.md` 的「架构概览」「Runtime TTL」
- 文件：旧 `context-sessions` API、`src/web/context-session-*`、README 中现状说明及相关测试
- 依赖：T4、T5、T6、T7

步骤：

1. 删除页面卸载关闭持久 Conversation 的逻辑和临时 Context Session 创建/关闭 API。
2. 移除仅服务临时会话的 Manager/Store 代码；保留仍被 Conversation Runtime 使用的通用能力。
3. 对功能启用前的 `context-v1` 孤儿只执行现有安全过期清理，不宣称可迁移旧内存会话。
4. 更新现有行为说明：刷新/重启恢复、TTL 只卸载 Runtime、切换绑定不删除旧对话。

验证：

- 运行：`rg -n "刷新页面会清空|closeContextSession|contextSessionId" README.md src`，随后运行相关 Route/组件测试。
- 期望：不存在旧生命周期语义和浏览器临时 Context Session 依赖；历史规格文档保持不改写。

## T9：执行跨重启验收与完整质量检查

- 对应：全部需求，`plan.md` 的「验证策略」
- 文件：`tests/web-conversation-persistence.e2e.test.ts`，必要的测试辅助代码
- 依赖：T1–T8

步骤：

1. 使用本地 mock Provider 和临时持久目录完成含工具调用、卸载结果、取消和错误的多轮对话。
2. 丢弃所有内存 Manager/Runtime 实例并重新创建，模拟 OrbitCode 进程重启；打开旧对话继续一轮。
3. 覆盖两条不同绑定对话切换、不可用绑定只读、并发 revision 冲突、保存失败重试、清空和删除。
4. 运行完整自动检查和真实浏览器交互；不使用真实凭据。

验证：

- 运行：`npm test`
- 运行：`npm run lint`
- 运行：`npm run typecheck`
- 运行：`npm run build`
- 运行：开发服务器 + `agent-browser` 对话管理检查
- 期望：全部命令退出 0；浏览器无错误覆盖层/控制台错误，刷新后恢复、切换和继续行为符合 Spec。

## 执行顺序

```text
T1 → T2 ─┐
  └→ T3 ─┴→ T4 → T5 → T6 → T7 → T8 → T9
```

T2 与 T3 可在 T1 完成后并行；其余任务按依赖顺序执行。实现期间不得把当前未提交的本地日志/耗时改动覆盖或拆除，应在 T6 中基于现状完成 conversationId 集成。
