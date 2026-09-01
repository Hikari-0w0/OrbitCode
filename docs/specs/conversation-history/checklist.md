# 本地持久化对话历史 Checklist

状态：已批准
依据：已批准的 `spec.md`、`plan.md` 与 `task.md`

> 每项都记录实际验证证据；未执行的项目不得标记通过。用户已完成整套文档审核并批准开始实现。

## 需求验收

- [x] AC1 / F1、F6、F7：完成包含文本、工具调用和工具结果的一轮，销毁所有内存 Runtime 后重新加载；显示时间线完整，下一轮 Provider 请求包含合法配对的旧 assistant/tool transcript。（验证：`tests/web-conversation-persistence.e2e.test.ts`）
- [ ] AC2 / F2：创建多条含大正文的对话，列出摘要并确认按 `updatedAt` 降序；仓库探针证明列表未读取 revision 正文。（验证：`src/lib/local-conversation-store.test.ts`、Conversation Route 测试）
- [ ] AC3 / F3：首条消息生成有界默认标题，合法重命名在重建 Runtime 后保留；空白、超长和非法标题不改变旧版本。（验证：领域标题测试、重命名 Route 测试、浏览器观察）
- [ ] AC4 / F4、F15：创建两个不同 Workspace/Provider 绑定的对话并往返切换；各自的消息、模式、绑定和模型上下文独立恢复，旧对话 revision 不被新绑定操作修改。（验证：组件测试、E2E、浏览器）
- [ ] AC5 / F5：保存最近对话 ID 后刷新页面并重启服务可恢复；ID 已删除或详情损坏时显示错误且仍能选择其他记录或新建。（验证：组件启动测试、Route 集成测试、浏览器刷新）
- [ ] AC6 / F6：分别运行最终回复、用户取消、最大迭代和模型错误；重建 Runtime 后已有文字、工具状态、停止原因和结构化中断保留，下一轮可继续。（验证：Agent/Runtime 集成参数化测试）
- [ ] AC7 / F8：产生 offloaded 工具结果，重启后 `read_context` 使用原引用成功；删除对话后读取失败且对象被安全清理。（验证：本地仓库测试、E2E）
- [ ] AC8 / F9、F10：取消删除/清空确认时无请求和数据变化；确认后列表、详情和引用一致更新；注入存储失败时旧 checkpoint 仍可打开。（验证：组件、Route、文件仓库故障注入测试）
- [ ] AC9 / F11：移除旧对话绑定的 Workspace 或 Provider 配置后打开记录；历史可读，发送、压缩和审批入口禁用，页面显示不可用绑定且不自动替换。（验证：Runtime 测试、浏览器）
- [x] AC10 / F12：两个客户端持有同 revision 时先提交成功、后提交收到冲突；同时启动第二 Agent 轮次被拒绝且不覆盖首轮。（验证：Repository CAS、跨 Store 租约、Runtime 互斥测试）
- [ ] AC11 / F13：注入终止后保存失败；页面显示未保存且磁盘旧 revision 可读，服务端重试成功后返回新 revision 并清除警告。（验证：Chat Handler/Runtime 集成测试、浏览器错误态）
- [x] AC12 / F14：写入活动标记后模拟进程退出；新实例恢复上一 checkpoint、标记上次运行中断，并且没有新增成功工具结果。（验证：Repository 重启测试）
- [ ] AC13 / F16：伪造 ID、路径形式 ID、未知版本/字段、越界正文和错误工具配对均结构化失败，不读取外部路径、不修改合法 head。（验证：合约与真实临时目录安全测试）
- [ ] AC14 / F1、F4：恢复消息中的工具卡、停止原因、Token 用量和运行时间与保存前一致；详情 revision 与下一轮服务端 Context revision 一致。（验证：组件 hydrate 测试、E2E）

## 集成与架构

- [x] Conversation checkpoint 同时提交显示时间线和 Context 持久状态，不存在可独立更新的双版本。（验证：Repository 与跨重启 E2E）
- [x] Web `stopped` 仍是唯一终止事件，并且 `saved` 状态只在 checkpoint 提交后发送。（验证：Chat Handler 事件顺序与失败测试）
- [x] 客户端聊天请求不携带历史、managed transcript、工具正文或文件路径，服务端以 conversationId 加载事实上下文。（验证：Web 合约测试）
- [x] ContextManager 恢复完整消息类型且不恢复 active turn、usage 锚点、AbortSignal、PromptEnvelope 或临时压缩状态。（验证：ContextManager 持久快照测试）
- [ ] Runtime TTL 释放内存后，Conversation head、revision 和 context 对象仍存在且可重新打开。（验证：可控时钟 Runtime 测试）
- [x] `src/core/conversations/` 与 `src/core/context/` 不导入 React、Next.js、Route 或 Node 文件系统实现。（验证：结构检查、`npm run typecheck`）
- [x] 当前本地运行日志以 conversationId 关联运行，仍不复制用户/助手正文、工具参数或工具输出。（验证：日志与 Chat Handler 测试）
- [x] 旧临时 Context Session API 和页面卸载删除语义已移除，权限会话继续独立工作。（验证：构建路由列表、`rg`、现有权限测试）

## 安全与异常路径

- [x] 存储根、对话目录和锁目录权限仅当前用户访问，数据文件仅当前用户读写。（验证：真实文件权限测试）
- [x] Conversation、revision、context 对象和临时文件经过边界校验；目录符号链接和 `..` 无法越界。（验证：符号链接与路径穿越测试）
- [ ] revision 写入、同步或 head rename 任一步失败时，上一完整 head/revision 保持可读。（验证：逐阶段 I/O 故障注入测试）
- [ ] 一条对话损坏不会阻断其他摘要列表和详情；损坏正文不进入 Provider 请求。（验证：多对话损坏隔离测试）
- [ ] 单条记录、消息、工具、标题、总体存储或磁盘容量越界返回可恢复错误，不静默截断协议或覆盖旧版本。（验证：边界测试）
- [ ] 跨进程租约有 owner、PID 和心跳；活跃租约不可抢占，确认陈旧的租约可安全回收。（验证：两个 Node 子进程竞争测试）
- [ ] 重新打开对话不会恢复单次/会话允许、待处理审批或活动工具；永久权限规则仍按原优先级生效。（验证：权限集成测试）
- [ ] 绑定不可用时任何 Agent、压缩或审批新工具请求都不会启动。（验证：Runtime/Route 调用计数测试）
- [ ] 错误、SSE、列表摘要和运行日志不包含 API Key、环境变量、绝对存储路径、推理内容或未请求正文。（验证：哨兵敏感值测试）
- [ ] 手动取消、工具失败、无效参数、命令超时和最大迭代均安全终止并形成可恢复 checkpoint。（验证：mock Agent/工具端到端场景）

## 项目检查

- [x] 完整自动测试通过（验证：`npm test`，254 项通过，退出码 0）
- [x] ESLint 通过且无 warning（验证：`npm run lint`，退出码 0）
- [x] TypeScript 严格类型检查通过（验证：`npm run typecheck`，退出码 0）
- [x] 生产构建通过（验证：`npm run build`，退出码 0）
- [x] 差异无空白错误，未写入 `.env`、日志、截图、视频、压缩包或真实持久对话样本。（验证：`git diff --check`、`git status --short`）

## 端到端

- [x] 在 tmux 中使用本地 mock Provider 完成一次真实工具闭环；丢弃内存实例、重新打开旧对话并继续，Provider 收到旧工具 transcript。（验证：`tests/web-conversation-persistence.e2e.test.ts`，不使用真实密钥）
- [ ] 在浏览器创建两条对话、重命名并切换，刷新后恢复最近对话；消息、工具卡、Token 和运行时间与刷新前一致。（验证：`agent-browser` 快照和交互观察）
- [ ] 浏览器中停止一次正在运行的 Agent，等待服务端收敛后重启并继续；取消原因和部分进度保留。（验证：`agent-browser` + mock 延迟 Provider）
- [ ] 模拟保存失败后页面显示未保存和重试入口；恢复存储后重试成功，无重复消息或 revision 跳写。（验证：故障注入开发服务器）
- [ ] 模拟不可用绑定和损坏单条记录；页面仍可浏览其他对话，无错误覆盖层或控制台错误。（验证：`agent-browser`）
- [ ] 删除和清空分别验证取消确认、确认成功及 context 引用失效；失败场景不表现为成功。（验证：浏览器 + Route/文件观察）
- [x] 浏览器页面有实际内容、无 Next.js 错误覆盖层、无控制台错误，桌面宽度下对话列表及工作区可用。（验证：`agent-browser`）

## 实际结果

已完成主实现与阶段验收：254 项自动测试、lint、typecheck、build、tmux mock 跨重启闭环和桌面浏览器检查均通过。未勾选项是尚未单独执行的扩展故障注入或浏览器场景，不作为已验证证据冒充通过。
