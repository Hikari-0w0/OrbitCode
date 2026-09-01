# Agent 运行可靠性、效率与对话并发安全 Checklist

状态：已批准
依据：已批准的 `spec.md`、`plan.md` 与 `task.md`

> 每项都记录实际验证证据；未执行的项目不得标记通过。

## 需求验收

- [ ] AC1 / F1：运行 Agent 时从第二客户端读取同一会话，只返回最后完整 checkpoint 和 active 状态；revision、marker 不变，原运行可成功保存且无伪中断。（验证：`npm run test -- src/lib/local-conversation-store.test.ts src/web/conversation-operation-guard.test.ts`，再以两个浏览器标签页观察）
- [ ] AC2 / F2：活动会话的重命名、清空、删除、压缩、恢复和第二次运行均收到一致 busy 响应，目录、租约、marker、历史和 context 引用保持完整。（验证：会话 Store/Guard 集成测试及浏览器双标签操作）
- [x] AC3 / F3：会话详情返回错误和请求被取消时，页面分别收敛到可重试错误态和原稳定态，没有永久 loading 或未处理 Promise rejection。（验证：全量组件测试通过；本地浏览器控制台无 warning/error）
- [x] AC4 / F4：注入包含用户目录绝对路径的 Node 错误后，API、页面、日志只含安全错误码和公开提示；README 对 Workspace/Provider 切换均说明创建隔离对话并保留旧记录。（验证：存储/API 脱敏测试通过；README 已统一为创建隔离对话并保留旧记录）
- [ ] AC5 / F5、F7：慢速大工具参数流依次显示等待首字节、生成参数和收尾阶段，参数规模与耗时递增；运行日志包含正确 trace/attempt 关联且不包含完整参数。（验证：`npm run test -- src/models/openai-provider.test.ts src/web/chat-handler.test.ts src/lib/local-agent-run-log.test.ts`，浏览器受控流观察）
- [x] AC6 / F6、F16：首字节超时、idle、连接中断、协议错误和取消均得到准确分类；只有安全暂时错误按预算重试，耗尽后持久化已有进度，继续时不重复已完成工具。（验证：Provider、Agent Loop、Web Handler 与持久化 E2E 全部通过）
- [x] AC7 / F8、F9：JSON-as-command、整串引号、重复 cwd、未知字段、缺失字段及连续同类错误均在副作用前失败；达到预算后熔断，合法替代调用仍可继续。（验证：命令预检、run-command、失败预算与 Agent Loop 测试通过）
- [x] AC8 / F10：受管测试服务能启动、等待 loopback 端口、按 cursor 读取日志、查询状态并停止；普通命令运行长驻服务仍返回 timeout，结束后无残留进程。（验证：受管进程、Seatbelt 与 run-command 全量测试通过）
- [x] AC9 / F11、N4：受控 Provider 的多只读调用正确并发、写操作正确串行，`write_files` 逐项授权并报告结果；约 30 文件参考场景不超过 30 次模型迭代。（验证：Scheduler/批量工具通过；30 文件 fixture 用 4 次迭代完成并 verified）
- [x] AC10 / F12、N5：长上下文效率压缩后估算输入显著降低，完整工具协议仍合法，当前目标、最近失败、待办和引用重读能力保留。（验证：OperationalCompaction 与 ContextManager 测试通过，压缩样例低于原估算一半）
- [x] AC11 / F13：统一上限内的最大工具参数可完成解析和执行，超过上限在副作用前收到容量错误，不产生截断文件、半调用或孤立结果。（验证：Provider、write-file/write-files 容量与临时 Workspace 测试通过）
- [x] AC12 / F14：测试数据使用实际响应中的运行期 ID；前置失败后依赖步骤被跳过并报告 blocker；缺少或伪造证据不能得到 verified。（验证：CompletionTracker、Agent Loop 与系统提示测试通过）
- [x] AC13 / F15：包含 3～13 个纯换行 part 的实时和历史消息不会产生空白正文块；语义多行文字、工具顺序、详情和 aria 标签保持。（验证：时间线测试通过；浏览器实测连续工具卡间距为 12px）
- [x] AC14 / F7、N8：成功、工具失败和模型重试的日志/导出可还原阶段耗时与终止分类，搜索不到伪 API Key、Authorization、完整环境变量、工具参数或临时绝对路径。（验证：运行日志、导出器与 Web Handler 测试通过）
- [ ] AC15 / F1～F16：全部聚焦测试、项目检查、浏览器验收和 tmux Agent 端到端均完成，无错误覆盖层、控制台错误、会话冲突、敏感输出或残留进程。（验证：本清单「项目检查」与「端到端」全部通过）

## 集成与架构

- [x] Provider progress/timeout → Agent progress/stop → Web SSE → reducer/UI 的阶段和分类逐层一致。（验证：组合测试及真实 Web SSE E2E 通过；修复了内部 `type` 字段跨层泄漏）
- [x] Agent 最终 stopped → 可见时间线、模型 Context、verification、运行日志和 conversation revision 一致提交；日志失败不改变对话保存结果。（验证：Web Handler、会话持久化与 E2E 测试通过）
- [x] Runtime Manager 与磁盘 lease 对 Agent、压缩、重命名、清空、删除、保存重试和恢复采用同一互斥顺序，失败均逆序释放。（验证：Operation Guard、Runtime Manager 与 Store 并发测试通过）
- [x] Tool Registry → Permission Gateway → Scheduler → Workspace/Sandbox 的调用链覆盖单目标、多目标和受管进程，任何新工具均不绕过权限。（验证：Registry、权限、Scheduler、批量写入和进程测试通过）
- [x] Operational compaction 只替换完整工具交换，Context Store 引用与 conversation 清空/删除/回滚具有一致生命周期。（验证：非法协议不压缩、写入失败和轮次回滚测试通过）
- [x] `src/core/` 未导入 React、Next.js 页面或 Web 路由代码，核心仍可独立执行。（验证：排除测试文件后架构搜索无输出；`npm run typecheck` 退出码 0）
- [x] 未新增运行时依赖或禁止的 Agent 框架。（验证：依赖文件无 diff；`npm ls --depth=0` 正常）

## 安全与异常路径

- [ ] GET 会话详情在 idle、active、interrupted 三种状态下均不写文件、不删 marker、不更新 mtime/revision。（验证：临时目录前后文件清单、hash、mtime 断言）
- [ ] 过期租约只能由持有新 lease 的显式恢复操作打破；活动心跳、token 不匹配和 revision 冲突均拒绝恢复。（验证：两个 Store 实例和伪时钟测试）
- [ ] 清空或删除在 busy、conflict、I/O 失败时不移除活动 lease、旧 revision 或 context 内容。（验证：故障注入测试）
- [x] 自动模型重试只发生在首个语义事件前，取消立即终止；有正文、推理、完整工具调用或副作用后不会自动重放。（验证：受控 SSE attempt 与取消测试通过）
- [x] `write_files` 的未知字段、重复路径、越界路径、符号链接、超项数、超单项/总容量和任一路径授权拒绝均在执行前失败。（验证：批量写入、Workspace 与逐目标授权测试通过）
- [x] 命令预检仅拒绝明确畸形，不重写语义；危险命令、敏感路径和 Seatbelt 不可用仍按原安全策略拒绝。（验证：预检、危险命令、run-command、Seatbelt 测试通过）
- [x] 受管进程只能使用当前 Workspace 和 loopback readiness；未知进程 ID、端口越界、日志超限、取消和强制清理均有界处理。（验证：ManagedProcess 与进程工具负向测试通过）
- [x] `report_completion` 不能引用其他运行或不存在的 call ID，写入前证据不能证明写入后的验证，文本字段不能超过边界。（验证：CompletionTracker 与 report tool 负向测试通过）
- [x] Context 压缩写引用失败、取消或产生非法协议时完整回滚，不丢失原始活动上下文。（验证：OperationalCompaction 故障注入与 ContextManager 回滚测试通过）
- [x] API、SSE、日志和导出中不出现测试凭据、Authorization、完整环境变量、完整工具参数、未请求正文、租约 token 和用户目录绝对路径。（验证：相关负向断言与脱敏测试通过）

## 项目检查

- [x] 全部自动化测试通过（验证：`npm run test`，292/292 通过）
- [x] ESLint 通过（验证：`npm run lint`，退出码 0）
- [x] TypeScript 严格类型检查通过（验证：`npm run typecheck`，退出码 0）
- [x] 生产构建通过（验证：`npm run build`，退出码 0）
- [x] Diff 无空白错误（验证：`git diff --check`，退出码 0）
- [x] 工作树中没有本轮生成的日志、测试截图、视频、压缩包、真实配置或凭据文件被纳入交付。（验证：`git status --short` 人工核对）

## 端到端

- [ ] 浏览器双标签页：标签 A 启动包含工具调用的 Agent，标签 B 打开同一会话并尝试重命名/清空/删除；B 只读显示 active 且修改被拒绝，A 正常完成保存，刷新后历史一致。（验证：开发服务器真实浏览器操作、Network/Console 检查）
- [x] 浏览器时间线：载入现有长会话；工具卡紧凑连续，展开结果、语义文字和导出按钮均正常。（验证：卡片间距实测 12px；切换会话后完整恢复；导出 POST 200；Console 0 warning/error）
- [ ] 浏览器异常恢复：中断一个有已完成工具的模型流，确认部分进度与准确原因被保存；重新打开并继续，不重复已完成副作用。（验证：受控 Provider 或安全可复现的连接中断）
- [ ] tmux 工具稳定性：提交包含多个文件、一个可识别畸形命令和重复失败替代方案的真实任务；观察批量/多调用、失败预算和最终验证报告形成闭环。（验证：tmux 运行记录与会话导出；不展示密钥）
- [ ] tmux 受管进程：Agent 启动测试服务、等待端口、读取日志、调用接口并停止；运行结束后端口关闭且进程不存在。（验证：tmux 运行记录、端口/PID 检查）
- [ ] tmux 长任务边界：在 `unlimited` 迭代下触发运行时限或可控停止，确认失败预算、总时长、停止持久化和后续继续仍生效。（验证：使用缩短的测试配置，不使用真实破坏性命令）
- [ ] 真实 Provider 验收仅在用户本地未入库配置可用时执行；若不可用，保持未勾选并记录环境限制，不以模拟结果冒充真实模型结果。（验证：tmux 中执行，输出与截图不包含密钥）

## 实际结果

2026-08-31：核心实现、292 项自动化测试、lint、typecheck、生产构建、diff 检查和单标签浏览器验收已完成。双标签活动运行冲突、浏览器真实中断恢复及真实 Provider/tmux 计费场景本轮未执行，保持未勾选，不以模拟测试替代。
