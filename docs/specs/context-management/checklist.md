# 上下文管理 Checklist

状态：已批准
依据：已批准的同目录 `spec.md`、`plan.md` 与 `task.md`

> 每项仅在实际执行并记录证据后标记 `[x]`。测试使用本地替身或用户未入库环境配置，不记录真实 API Key。

## 需求验收

- [x] AC1 / F1：普通 Agent usage 可成为 revision 锚点，新增内容只计算 delta；usage 缺失明确显示全量近似。（验证：`npm run test -- src/core/context/token-estimator.test.ts src/core/agent-loop.test.ts`）
- [x] AC2 / F2：单个大工具结果在下一次模型调用前被原子卸载，Provider 只看到有界预览、体积与 opaque reference，用户原文不变。（验证：`npm run test -- src/core/context/lightweight-compaction.test.ts src/core/agent-loop.test.ts`）
- [x] AC3 / F3：同一批次结果按体积稳定降序卸载至阈值内，assistant/tool 配对与顺序合法。（验证：`npm run test -- src/core/context/message-groups.test.ts src/core/context/lightweight-compaction.test.ts`）
- [x] AC4 / F4：每次普通模型调用前固定执行 light → estimate → optional heavy；自动触发线使用配置窗口减 13K 默认余量，单调用点摘要最多一次。（验证：`npm run test -- src/core/context/context-manager.test.ts src/core/agent-loop.test.ts`）
- [x] AC5 / F5：重量压缩保留至少最近 5 条、约 10K Token 的合法原始尾部及全部旧用户原文，不拆工具组。（验证：`npm run test -- src/core/context/message-groups.test.ts src/core/context/heavy-compaction.test.ts`）
- [x] AC6 / F6：摘要必须含七个固定章节；分析草稿不进入 history、SSE、Web 响应或后续 Provider 请求。（验证：`npm run test -- src/core/context/summary-parser.test.ts src/core/context/heavy-compaction.test.ts src/web/chat-contract.test.ts`）
- [x] AC7 / F7：摘要 Provider 请求不含 tools 且 `toolChoice` 固定为 `none`；替身返回工具调用时历史不变并报告摘要失败。（验证：`npm run test -- src/core/context/tool-free-summary-generator.test.ts src/core/context/context-manager.test.ts`）
- [x] AC8 / F8：成功重量压缩后有且仅有一条 system boundary，明确要求重新读取文件与已卸载内容。（验证：`npm run test -- src/core/context/heavy-compaction.test.ts`）
- [x] AC9 / F9：摘要连续失败 1、2 次可再次显式触发，第 3 次打开会话熔断；后续自动路径零摘要请求，手动成功恢复并归零。（验证：`npm run test -- src/core/context/context-manager.test.ts src/web/context-session-manager.test.ts`）
- [x] AC10 / F10：合法引用可分块读取；跨会话、伪造、过期、路径输入、越界和符号链接均结构化失败且不触达 Workspace。（验证：`npm run test -- src/lib/local-context-store.test.ts src/tools/read-context.test.ts`）
- [x] AC11 / F11：Web 手动压缩显示进行中、成功前后估算、失败原因和熔断；Agent/压缩活动时前后端都拒绝并发。（验证：组件测试 + `agent-browser` 真实页面）
- [x] AC12 / F12：多 Provider 可用不同窗口与阈值；缺失/非法 window、未知字段、余量倒置、阈值倒置和容量关系均被拒绝。（验证：`npm run test -- src/models/config.test.ts src/web/server-config.test.ts`）
- [x] AC13 / F13：Context Session 绑定 Workspace/Provider，成功轮次提交完整工具 transcript，失败/取消不提交新增消息；关闭后引用失效并调度清理。（验证：`npm run test -- src/web/context-session-manager.test.ts src/core/agent-loop.test.ts tests/web-context-management.e2e.test.ts`）

## 核心算法与状态

- [x] 相同输入、配置和摘要结果产生相同卸载顺序与保留集合；同体积结果按原顺序稳定处理。（验证：重复运行核心单测并深比较结果）
- [x] 工具组校验拒绝缺失、重复、未知或被打断的 toolCallId，不把非法 transcript 发给 Provider。（验证：`npm run test -- src/core/context/message-groups.test.ts`）
- [x] 压缩只有在候选完整校验且产生净收益后提交；Agent 非成功终止恢复轮次开始时的历史/usage 锚点并清理临时引用，摘要、存储或取消失败不留下部分修改。（验证：`npm run test -- src/core/context/context-manager.test.ts src/core/context/heavy-compaction.test.ts src/lib/local-context-store.test.ts`）
- [x] 普通 Agent usage 和摘要 usage 分账，摘要请求不会污染 UI 已有累计 Token。（验证：`npm run test -- src/core/agent-loop.test.ts src/core/context/tool-free-summary-generator.test.ts`）
- [x] 必须保留内容本身超预算时返回 `capacity` 并停止，不删改用户消息、不继续普通模型调用。（验证：核心与 Agent 集成测试）

## 集成与架构

- [x] `src/core/context/` 不导入 React、Next.js、Route Handler 或 OpenAI 具体实现。（验证：`rg -n "from [\"'](?:react|next|@/app|@/components|@/web|@/models/openai-provider)" src/core/context` 无匹配）
- [x] 摘要核心只依赖通用 Provider 和 Store 端口，本地路径只存在于 `src/lib/local-context-store.ts`。（验证：源码依赖检查 + `npm run typecheck`）
- [x] Context Session 与 Permission Session ID、状态和 lease 独立；聊天装配任一失败会释放另一方已取得资源。（验证：Route/manager 集成测试）
- [x] 浏览器不再提供完整模型历史，服务端 Context Session 是内部 transcript 唯一事实来源。（验证：Web contract 测试并检查实际 `/api/chat` 请求）
- [x] Plan/Do 均可使用 `read_context`，其他工具仍按原模式公开和拒绝。（验证：`npm run test -- src/tools/mode-policy.test.ts src/tools/read-context.test.ts`）
- [x] `stopped` 仍是 Agent SSE 唯一终止事件，上下文失败有专用且严格解析的停止原因。（验证：`npm run test -- src/web/chat-handler.test.ts src/web/chat-contract.test.ts`）

## 安全与异常路径

- [x] Context Store 使用仓库外应用私有根目录，写入原子化，引用不含绝对路径，SSE/UI/错误不泄露真实路径。（验证：Store/contract 测试及响应内容检查）
- [x] `read_context` 的 session capability 只旁路当前会话内部读取；现有路径/命令工具全部仍经 PermissionGateway。（验证：scheduler/permission 回归测试和伪造工具用例）
- [x] 现有权限规则 `deny > ask > allow`、三档模式、永久允许、危险命令和 Workspace 边界测试全部保持通过。（验证：`npm run test -- src/core/permissions/*.test.ts src/tools/permission-*.test.ts src/tools/dangerous-command.test.ts src/tools/workspace.test.ts`）
- [x] 存储写入失败不会丢弃完整工具结果；读取失败不暴露引用是否属于其他会话。（验证：Store 与 lightweight 测试）
- [x] 摘要网络、HTTP、流中断、重复 usage、tool-call、非 stop、非法 JSON、缺节和超长内容均归类为安全失败。（验证：summary generator/parser 测试）
- [x] Agent 取消、手动压缩取消、页面清空和会话 TTL 会终止活动操作，状态与 lease 最终释放。（验证：manager、Agent、React 测试）
- [x] 日志、测试 fixture、浏览器截图和 tmux 输出不包含真实 API Key、完整环境变量或已卸载敏感正文。（验证：测试仅使用哨兵凭据，并用 `rg` 检查产物；不提交产物）

## 配置与兼容性

- [x] `context.window_tokens` 为 Provider 必填且不会按模型名猜测；示例值明确只是示例。（验证：配置测试与 README 审查）
- [x] 策略阈值均可按 Provider 配置，省略时使用文档化默认值；硬上限防止内存/磁盘滥用。（验证：配置边界测试）
- [x] 不新增运行时依赖，`package.json` 中不存在 Agent 框架、tokenizer 或托管执行 SDK。（验证：`git diff -- package.json package-lock.json`）
- [x] CLI 纯文本入口仍能通过原有测试且未被迫依赖 Web Context Session。（验证：`npm run test -- src/cli/terminal-chat.test.ts src/core/conversation.test.ts`）

## Web 用户体验

- [x] 手动压缩按钮具有可访问名称，状态通过 `aria-live` 宣告，移动端不遮挡输入与停止操作。（验证：组件测试 + `agent-browser`）
- [x] 成功展示 before/after 数值及 `usage-anchor`/`approximation` 来源，不把估算显示为模型精确报告。（验证：组件测试 + 浏览器观察）
- [x] 失败保留可见聊天并显示安全原因；Context Session 失效时能明确提示重建/清空，不静默换历史。（验证：组件测试 + 模拟 404/409/422）
- [x] 清空、切换 Workspace/Provider 和页面卸载会关闭或取消两个独立会话，既有权限等待卡不会悬挂。（验证：React/Route 集成测试）
- [x] 页面无 Next.js 错误覆盖层，浏览器控制台无未处理错误。（验证：开发服务器 + `agent-browser`）

## 项目检查

- [x] 相关单元与集成测试通过（验证：`npm run test`，退出码 0）
- [x] ESLint 通过（验证：`npm run lint`，退出码 0）
- [x] TypeScript 严格类型检查通过（验证：`npm run typecheck`，退出码 0）
- [x] 生产构建通过（验证：`npm run build`，退出码 0）

## 端到端

- [x] 大工具结果 → 自动卸载 → Provider 仅见预览/引用 → 模型调用 `read_context` 分块读回 → 给出最终回复。（验证：tmux + 本地 OpenAI 兼容替身，记录请求 transcript）
- [x] 多轮历史接近自动线 → 先轻量后重量摘要 → 保留旧用户原文和最近 5 条以上 → system boundary 生效 → Agent 继续工作。（验证：`tests/web-context-management.e2e.test.ts` + tmux）
- [x] 页面点击手动压缩 → 使用 3K 摘要余量 → 显示 before/after → 下一轮继续使用压缩后服务端历史。（验证：`agent-browser` + 替身请求记录）
- [x] 摘要连续三次失败 → 第三次熔断 → 下一次自动路径不发摘要请求并安全停止 → 手动成功后恢复。（验证：端到端替身计数器）
- [x] 工具失败、无效参数、命令超时和达到最大 Agent 迭代次数仍按既有结构化路径终止，且失败轮次不提交新增上下文。（验证：tmux 异常场景）
- [x] 切换 Workspace/Provider 后旧 context reference 和旧 Context Session 均不可复用，权限会话行为不回归。（验证：浏览器 + API 集成测试）

## 实际结果

实现于 2026-08-29 完成，验收结果如下：

- `npm test`：226 项通过，0 失败；覆盖上下文核心、权限回归、Route、CLI 及三个 OpenAI 兼容替身端到端场景。
- `npm run check`：ESLint、TypeScript 严格检查和 Next.js 生产构建全部退出码 0；构建产物包含 Context Session 创建、查看/关闭和手动压缩 Route。
- `agent-browser`：桌面与 390×844 移动布局通过；手动压缩状态可见，Provider 切换后双会话重建成功，无错误覆盖层或控制台异常。既有 Plan 按钮存在一项非本功能引入的颜色对比度告警，本次未扩大范围修改。
- `tmux`：真实 HTTP/SSE OpenAI 兼容替身验证大结果卸载与 `read_context` 重读、自动重量摘要、三次失败熔断、自动零重试及手动恢复，3 项全部通过。
- 依赖与边界：未新增运行时依赖；`src/core/context/` 未导入 React、Next.js、Web Route 或具体 OpenAI Provider；测试和产物未记录真实凭据。

## 草案自检

- AC1–AC13 均有直接可执行或可观察检查项。
- 覆盖核心算法、架构依赖、存储边界、摘要禁用工具、三次熔断、配置、Web、浏览器和 tmux 端到端。
- 未预填任何通过结果，未要求真实密钥，未把源码行号作为验收依据。
