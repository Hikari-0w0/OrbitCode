# 项目指令、会话接续与长期记忆 Tasks

状态：已批准
依据：已批准的同目录 spec.md、plan.md。

## 文件清单与执行规则

每个任务的“文件”即本轮创建/修改清单；新增文件明确标注，既有文件只修改相关职责。所有路径相对仓库根目录；测试文件随所属模块交付。命令在仓库根目录执行，以下新测试与替身均属于待创建产物，当前不能据此声称验证通过。

四份文档批准后按 T1 至 T11 顺序执行，不包含提交、推送或 PR。每项完成后先验证，再更新进度；变更范围或公开行为时修订受影响文档并重新审批。

## T1：背景与笔记领域契约

- 对应：F1–F12；Plan 核心类型与接口、P2、P4
- 依赖：无
- 文件：新增 src/runtime/background-types.ts、memory-types.ts、memory-validation.ts；修改 src/core/conversations/types.ts、validation.ts；新增 src/runtime/memory-validation.test.ts，修改 src/core/conversations/validation.test.ts。

步骤：

1. 定义来源、作用域、证据、候选、任务状态和结果判别联合；所有外部输入从 unknown 校验。
2. 为检查点增加可选 lastTurn 与 lifecycleEpoch，保持旧记录兼容；验证资格不能由任意前端提交。
3. 实现 frontmatter 字段、长度、来源引用、类别、敏感哨兵和证据性质校验；使用已有 yaml。

验证：

- 运行：`npm test -- src/runtime/memory-validation.test.ts src/core/conversations/validation.test.ts`
- 期望：旧检查点可读；非法类型、伪造来源、超长及虚构凭据候选被拒绝。

## T2：有界文件访问与指令展开

- 对应：F1–F3；Plan P1、资源与失败边界
- 依赖：T1
- 文件：新增 src/lib/bounded-files.ts、bounded-files.test.ts、src/runtime/instruction-loader.ts、instruction-loader.test.ts。

步骤：

1. 实现基于真实路径、文件身份复核的有界读取和原子提交辅助能力；不复用不适合配置根的 Workspace 文件授权。
2. 加载三种来源，按独立行语法展开 include；维护每根 visited、深度和累计限额。
3. 根文件缺失可空，其他读取或边界错误整体阻止；诊断不包含被拒绝文件内容。

验证：

- 运行：`npm test -- src/lib/bounded-files.test.ts src/runtime/instruction-loader.test.ts`
- 期望：覆盖相对引用、重复、循环、深度 5/6、数量/体积、链接越界与文件身份变化；失败时模型调用计数为零。

## T3：恢复检查与轮次元信息

- 对应：F4–F6；Plan P2
- 依赖：T1
- 文件：新增 src/runtime/conversation-recovery.ts、conversation-recovery.test.ts；修改 src/lib/local-conversation-store.ts、local-conversation-store.test.ts、src/runtime/conversation-service.ts、conversation-service.test.ts、agent-runtime.ts。

步骤：

1. 在原保存中保存 turnId、结束时间、资格与 epoch；重命名/压缩保留轮次时间，清空更新 epoch。
2. 在显式恢复路径内检查工具配对，对唯一缺结果调用记录未知中断；歧义损坏阻止恢复。
3. 在现有租约和 revision 下提交修复；运行入口不得跳过待恢复状态；旧会话不臆造时间或资格。

验证：

- 运行：`npm test -- src/runtime/conversation-recovery.test.ts src/lib/local-conversation-store.test.ts src/runtime/conversation-service.test.ts`
- 期望：中断恢复不重放工具、不改变绑定；并发旧 revision 不覆盖，轮次时间不受重命名影响。

## T4：索引与分级笔记存储

- 对应：F8–F10、F12；Plan P4
- 依赖：T1、T2
- 文件：新增 src/runtime/memory-index.ts、memory-index.test.ts、memory-store.ts、memory-store.test.ts。

步骤：

1. 实现用户及项目独立根目录、frontmatter 笔记、规范化 hash、索引生成与双重限额。
2. 实现作用域锁、版本代、原子 HEAD、失败保留旧代；锁复用基础设施，增加跨进程竞争测试。
3. 实现 expectedRevision、来源去重、删除墓碑、人工变更检查与冲突保留；不自动清理旧代。
4. 模拟正文写入、索引写入、HEAD 切换前后崩溃；多作用域部分成功明确报告。

验证：

- 运行：`npm test -- src/runtime/memory-index.test.ts src/runtime/memory-store.test.ts`
- 期望：索引边界及多字节正确；失败后加载完整旧代或新代，无丢失更新、路径越界和删除复活。

## T5：只读记忆工具

- 对应：F3、F11；Plan P5
- 依赖：T4
- 文件：新增 src/tools/read-memory.ts、read-memory.test.ts；修改 src/tools/types.ts、default-registry.ts、permission-target.ts、mode-policy.ts 及对应测试；修改 src/web/chat-contract.ts、chat-contract.test.ts。

步骤：

1. 实现宿主签发的 memory 引用及分页读取接口，绑定当前会话/轮次/作用域/hash。
2. 通过现有只读 context 权限目标接入网关，保持 read_context 的引用规则；Plan/Do 都能读取被签发的笔记。
3. 补齐工具名称和返回协议解析，不允许任意路径、猜测其他项目引用或过期引用。

验证：

- 运行：`npm test -- src/tools/read-memory.test.ts src/tools/registry.test.ts src/tools/permission-target.test.ts src/tools/permission-gateway.test.ts src/web/chat-contract.test.ts`
- 期望：当前引用按页返回；伪造、跨作用域、已删除与内容变化均拒绝，现有工具权限回归通过。

## T6：背景组装与上下文预算

- 对应：F1、F3、F5、F11；Plan P1、P2
- 依赖：T2、T3、T5
- 文件：新增 src/runtime/background-service.ts、background-service.test.ts；修改 src/runtime/agent-runtime.ts、agent-runtime.test.ts、types.ts；修改 src/core/system-prompt/types.ts、dynamic-context.ts、assemble.ts、system-constraints.ts、system-prompt.test.ts；必要的上下文集成用例加入 src/core/context/context-manager.test.ts。

步骤：

1. 每轮准备来源指令、有效索引、引用映射和可选 24 小时提醒；不在每次迭代刷新磁盘。
2. 接入具名背景字段，明确优先级与不可信记忆性质；调整新增字段限额，保留其他可选字段保护。
3. 捕获真实模型请求验证每次迭代携带快照；所有背景参与现有预算、压缩和熔断。
4. 将加载失败与记忆降级诊断交给统一 runtime 状态，不将恢复提醒持久化成重复历史。

验证：

- 运行：`npm test -- src/runtime/background-service.test.ts src/runtime/agent-runtime.test.ts src/core/system-prompt/system-prompt.test.ts src/core/context/context-manager.test.ts`
- 期望：新增/恢复会话、下一轮刷新、24 小时边界、容量和压缩失败符合要求；无额外模型窗口扩大。

## T7：无工具候选提取与后台任务

- 对应：F6–F8、F10；Plan P3、P4
- 依赖：T4
- 文件：新增 src/runtime/memory-extractor.ts、memory-extractor.test.ts、memory-jobs.ts、memory-jobs.test.ts、memory-service.ts、memory-service.test.ts。

步骤：

1. 构建最小已保存输入与可核对证据集合，过滤已知凭据；复用 ChatProvider 禁用工具并严格解析响应。
2. 实现单并发、8 队列、30 秒超时、0 重试和有界响应；队满/超限明确 skipped。
3. 接入持久幂等状态、scope 独立提交、来源存活复检、关闭取消和删除墓碑。
4. 使用确定性去重；模型合并建议必须符合现有 noteId、版本和来源规则。

验证：

- 运行：`npm test -- src/runtime/memory-extractor.test.ts src/runtime/memory-jobs.test.ts src/runtime/memory-service.test.ts`
- 期望：非法/慢响应、工具调用、取消与崩溃有安全状态；重复来源不重复写，原始敏感输入不落盘。

## T8：保存触发与生命周期竞态

- 对应：F6、F7、F12、F14；Plan P3、P4、P6
- 依赖：T3、T7
- 文件：修改 src/runtime/run-agent-turn.ts、agent-runtime.ts、conversation-service.ts、conversation-runtime-manager.ts、types.ts；新增 src/runtime/run-agent-turn.test.ts、memory-lifecycle.test.ts；扩展现有 runtime/service 测试。

步骤：

1. 统一正常回复保存钩子及 retry-save 触发；最终回复、保存状态与工具完整性共同决定资格。
2. 资源清理及释放会话租约后启动模型任务；最终流不等待提取完成。
3. 实现来源提交守卫和固定锁顺序；清空、删除、关闭后迟到任务不得提交。
4. 安排账本/提交状态崩溃对账，刷新和恢复不重新提取；CLI 退出可取消未完成任务。

验证：

- 运行：`npm test -- src/runtime/run-agent-turn.test.ts src/runtime/memory-lifecycle.test.ts src/runtime/agent-runtime.test.ts src/runtime/conversation-service.test.ts`
- 期望：正常失败重试只触发一次；所有异常终止零提取；并发关闭/删除/提交无死锁及迟到写入。

## T9：两端背景与记忆管理

- 对应：F1、F11、F12；Plan P5
- 依赖：T6、T8
- 文件：新增 src/web/background-http.ts、background-http.test.ts、src/app/api/conversations/[conversationId]/background/route.ts、src/app/api/memory/route.ts、src/components/conversation-background-panel.tsx、conversation-background-panel.test.tsx；修改 src/web/agent-runtime.ts、storage-paths.ts、src/components/chat-workspace.tsx、src/cli/main.ts、run-once.ts、session-controller.ts、commands.ts、renderer.ts 及对应测试。

步骤：

1. 集中注入共享 background/memory 服务，Web 和两种 CLI 入口使用一致配置根；隔离目录不回退。
2. 实现薄管理 API、本地请求保护、expectedRevision 与会话绑定解析。
3. 提供来源、状态、笔记查看/更新/删除和开关；CLI 实现计划中的命令与 Markdown 导入。
4. 验证用户打开管理界面不调用模型，修改从下一轮生效；异步任务状态不依赖仍存活的 SSE。

验证：

- 运行：`npm test -- src/web/background-http.test.ts src/components/conversation-background-panel.test.tsx src/cli/commands.test.ts src/cli/terminal-chat.test.ts src/web/chat-contract.test.ts`
- 期望：两端同等行为；非法管理来源/任意路径拒绝，隔离运行无日常用户配置访问。

## T10：30 天清理预览与执行

- 对应：F13、F14；Plan P6
- 依赖：T8、T9
- 文件：新增 src/runtime/conversation-cleanup.ts、conversation-cleanup.test.ts、src/web/conversation-cleanup-http.ts、conversation-cleanup-http.test.ts、src/app/api/conversations/cleanup/route.ts、src/components/conversation-cleanup-panel.tsx、conversation-cleanup-panel.test.tsx；修改 src/runtime/conversation-service.ts、src/components/conversation-list.tsx、src/cli/session-controller.ts、commands.ts 及对应测试。

步骤：

1. 按持久化更新时间生成候选及跳过原因；所有预览只读。
2. 实现显式选定集合、守卫内复检和逐条删除报告，复用持锁删除路径避免重复申请锁。
3. 接入 Web 确认操作与 CLI preview/delete 确认；单批最多 100 条，取消不继续后续项。
4. 验证新 revision、待保存、待恢复、活动租约、未来时间和部分失败。

验证：

- 运行：`npm test -- src/runtime/conversation-cleanup.test.ts src/web/conversation-cleanup-http.test.ts src/components/conversation-cleanup-panel.test.tsx src/runtime/conversation-service.test.ts src/cli/commands.test.ts`
- 期望：边界时间正确，启动与预览不删数据；删除范围仅限合格且选定会话及既有上下文引用。

## T11：端到端与说明文档

- 对应：F1–F14；Plan 验证策略
- 依赖：T10
- 文件：新增 scripts/fixtures/project-memory-provider.ts、src/runtime/project-memory.integration.test.ts；更新 README.md 与本目录 checklist.md 的实际结果。

步骤：

1. 提供只监听 loopback 的 OpenAI 兼容模型替身，按确定性脚本返回文本、工具调用、错误与超时，记录脱敏请求证据。
2. 集成验证 Web/CLI 共享会话与记忆、隔离根、正常提取和清理完整链路。
3. 依次执行 lint、typecheck、build；启动隔离开发服务器，用 agent-browser 检查页面和控制台，结束关闭。
4. 在 tmux 中运行交互 CLI，通过替身完成真实进程端到端与异常场景；停止所有测试进程。
5. 更新 README 的 include 语法、优先级、路径、开关、命令、退出放弃语义与清理规则；记录实际证据，不用模型最终回复代替验收。

验证：

- 运行：`npm test -- src/runtime/project-memory.integration.test.ts；随后依次 npm run lint、npm run typecheck、npm run build`
- 期望：集成与项目检查退出码 0；浏览器/tmux 实际观察符合 checklist；受限项保持未验证。

## 执行顺序

```text
T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11
```

此为保守的串行交付顺序，具体前置依赖见各任务。第一部分在 T6 后具备背景闭环；长期记忆在 T9 后具备两端闭环；清理在 T10 后闭环；统一验收由 T11 收口。


## 实施结果（2026-10-15）

T1–T11 已实施，验证结果见 checklist.md。实现过程中同步了以下小型机械细节，需求范围和公开行为保持已批准基线：

- T2/T4：有界文件访问与跨进程锁拆为共享基础设施；设置锁保留原领域错误与等待上限。记忆的来源提交守卫只用于短提交，前台最多等待 2 秒。
- T8：retry-save 使用原轮次模型快照；空候选不获取来源提交守卫。后台 close 等待取消后的状态落盘，以避免退出与临时目录清理竞争。
- T9/T10：当前会话被清理时复用既有删除流程重置前端会话状态。
- T11：增加隔离目录/历史构造 fixture，并为旧 Web/CLI 测试辅助代码显式指定用户配置根；此前测试生成的诊断文件按 PID、hash、状态逐一确认后清理。最终全量测试不再改动日常目录。

最终全量测试 499/499 通过，lint、typecheck、build 均退出 0。实际 Web、tmux、恢复、异常终止与清理记录已归档至本机临时证据目录；未运行真实供应商模型质量评估，未执行 Git 提交或推送。


真实模型补充：在后续明确授权下完成 3 组 15 轮 DeepSeek Flash 测试，修正提取提示的协议歧义并增加反例回归，现为 500/500。项目知识提取与纠正的真实模型质量尚未通过，详见 checklist.md 补充说明及真实模型报告；不据此重写已完成的确定性证据。


## 真实模型失败修复（2026-10-15，用户授权继续）

- 修正前台异步存储表述，空索引不注册 read_memory，避免编造引用。
- 提取不再读取助手自述或 read_memory 旧正文作为新证据；纯旧记忆查询直接返回空候选。
- 提供同项目可替代目标集合，解析及存储双重校验；模型等待期间目标被人工修改则拒绝覆盖。明确纠正可以独立保存，不强求替代。
- 偏好问句拒绝作为新偏好；非法候选独立拒绝，有效项仍按原作用域事务提交，失败数量可检查。
- 新增来源、目标、混合候选、人工编辑竞争与零提取查询回归。最终全量 506/506；lint/typecheck/build 退出 0。
- 最终真实模型 5 场景和独立空记忆场景，6 项独立验收通过；详情及限制见真实模型修复报告。中间样本保留，未将失败迭代算成最终通过。
