# 结构化系统提示与缓存可观测性 Checklist

状态：已批准
依据：已批准的 `spec.md`、`plan.md` 与 `task.md`

> 四阶段文档审批不代表功能验收。每项都必须记录实际命令、退出状态或可观察证据；未执行的项目不得标记通过。

## 需求验收

- [x] AC1 / F1、F2：固定提示恰好包含七个非空模块，按身份、系统约束、任务模式、动作执行、工具使用、语气风格、文本输出排序，以单个空行分隔；重复组装逐字符一致且规则无矛盾。（验证：`npm test -- src/core/system-prompt/system-prompt.test.ts`，固定模块完整性与稳定性用例）
- [x] AC2 / F3、F4、F5：给定全部动态内容时，请求顺序为固定 system、环境、自定义指令、Skill、记忆、session、成功历史、当前用户；移除任一可选项不产生空消息，标签片段和角色前缀不能改变消息边界。（验证：核心组装单元测试与 `npm test -- tests/web-tool-agent.e2e.test.ts` 捕获请求）
- [x] AC3 / F6、F7：Do 连续轮次 1、5、9 使用完整提醒，其余精简；切换 Plan 后从 1 重新开始，同一用户请求的全部 Agent 迭代版本一致。Plan 只规划，Do 执行并验证。（验证：核心轮次测试、Web reducer 测试及人工 Plan/Do 场景）
- [x] AC4 / F8：全局工具规则和六个相关工具描述均声明专用工具优先及适用的编辑前读取约束；实际典型任务先调用 `search_code`/`find_files` 而不是 shell，编辑或覆盖已有文件前出现针对当前内容的 `read_file`。（验证：`npm test -- src/tools/registry.test.ts src/tools/mode-policy.test.ts` 与人工工具序列记录）
- [x] AC5 / F9：同一模式多轮请求的固定 system 与工具定义内容、schema 和顺序完全一致，动态内容只在后续消息变化；Plan/Do 各自保持批准的工具集合，请求中不存在 `cache_control`。（验证：Provider 请求快照和 Agent 集成测试）
- [x] AC6 / F10：标准 `cached_tokens`、兼容数值、布尔命中和零缓存被准确解析；缺失、null、未知、冲突、越界及完全无 usage 均按规则兼容，合法基础 Token 不被异常缓存子字段丢弃。（验证：`npm test -- src/models/openai-provider.test.ts`）
- [x] AC7 / F10、F11、F12：多迭代请求分别报告缓存数值、零和不可用时，核心事件、SSE、reducer 与页面保持一致；只有完整数值计算累计缓存与命中率，最终回复、停止原因和成功历史不变。（验证：Agent、Web 契约、reducer、消息列表及端到端测试）
- [x] AC8 / F5、N3、N6、N7：超长动态文本、标签闭合片段、类似角色前缀、绝对路径与凭据哨兵被安全拒绝或转义，失败发生在模型请求和工具副作用前；既有 Workspace、Plan 权限和停止边界继续有效。（验证：核心安全用例、捕获请求、日志与 DOM 哨兵搜索）
- [x] AC9 / F13：人工对比文档包含六类任务、固定前提、改造前后观察和逐项结论；已执行结果有真实工具序列及文本证据，无法执行项明确标记未验证。（验证：`docs/evals/structured-system-prompt.md` 人工审阅及规定字段搜索）
- [x] AC10 / N1、N2、N5：提示业务逻辑只位于入口无关核心模块，Route/页面不复制七模块或轮次策略，Provider 不承担提示规则；没有新增运行时依赖、禁止框架、托管执行或 Anthropic 缓存字段。（验证：依赖结构检查、`package.json` 差异、`npm run typecheck` 与代码搜索）
- [x] AC11 / N10、N11：真实浏览器在桌面与窄屏清楚显示有缓存、零缓存、仅命中状态和未报告状态，无布局错位、错误覆盖层或控制台错误；现有 Agent、Provider、Web、工具行为无回归。（验证：开发服务器下浏览器检查和全量自动化测试）
- [x] AC12 / 全部需求：全部项目检查通过，并在安全临时 Workspace 完成 Plan/Do、读取后编辑、专用工具选择、失败恢复、缓存展示和最终回复闭环；测试后无残留服务、浏览器、临时目录或子进程。（验证：项目检查、浏览器、tmux 真实对话与清理检查）

## 集成与架构

- [x] 七个固定模块只有声明式常量，固定组装器对模块完整性、唯一性、优先级和动态标签污染执行断言。（验证：模块单元测试及 `rg` 检查固定模块无运行态导入）
- [x] Agent Loop 在第一次 Provider 调用前组装一次提示，同一请求后续迭代只追加 assistant/tool 消息，不重新计算日期、环境或强化版本。（验证：多迭代捕获请求测试）
- [x] Web Route 从授权 Workspace 条目构造环境白名单，WorkspaceBoundary 仍独立承载绝对根路径，浏览器与模型请求都不接收根路径。（验证：Route/环境测试及浏览器网络请求观察）
- [x] 模式轮次在普通提交、“按此计划执行”、失败、取消、模式切换、Workspace/Provider 切换、清空和刷新路径中保持计划定义的状态转换。（验证：reducer 与组件请求测试）
- [x] Plan 工具集合仍只有 `read_file`、`find_files`、`search_code`，伪造副作用调用仍由服务端无副作用拒绝；Do 恢复六工具。（验证：`npm test -- src/tools/mode-policy.test.ts src/core/agent-loop.test.ts`）
- [x] Provider usage 经模型类型、Agent 累计、AgentEvent、Web SSE、reducer 到消息组件的每层判别字段一致，没有 UI 私自猜测缓存命中。（验证：单元测试与 Web 端到端测试）
- [x] `src/core/system-prompt/` 不导入 React、浏览器或 Next.js；组件不导入 Provider 解析实现，依赖方向无环。（验证：`rg -n "react|next/|next\\/" src/core/system-prompt src/core` 人工核对误报，配合 `npm run typecheck`）
- [x] 工具描述调整没有改变工具名称、参数 schema、mutability、执行结果或注册顺序。（验证：registry 快照和既有工具测试）

## 安全与异常路径

- [x] 动态补充单项和总长度边界、非法日期/时区/平台、非法 `modeTurn` 均在 Provider 请求前被拒绝，且不会开始工具。（验证：核心、环境、Web 契约和 Agent 调用计数测试）
- [x] 五种动态内容中的 `<`、`>`、`&` 与闭合标签均被安全实体转义，原始文本不能制造第二个标签或伪造 system/user 角色。（验证：核心动态上下文参数化测试）
- [x] 环境提示、模型请求、Agent 事件、SSE、DOM、控制台、日志和人工对比文档均不包含 API Key、认证头、完整环境变量、受保护内容或 Workspace 绝对路径哨兵。（验证：自动化哨兵断言与验收产物搜索）
- [x] `modeTurn` 即使被客户端伪造成其他合法值，也只影响完整/精简提醒，不能改变 Plan/Do 工具集合、执行权限、最大迭代或停止原因。（验证：使用不同 modeTurn 的模式权限集成测试）
- [x] 缓存可选字段缺失、未知、类型错误、冲突或越界时只降级缓存子信息；基础 Token 合法则响应继续，基础 Token 本身非法才触发现有协议错误。（验证：Provider 参数化测试）
- [x] 零缓存、缓存未命中和缓存未报告在事件与 UI 中语义可区分，不以 0 补齐缺失值，不从延迟或重复文本推测命中。（验证：Web 契约和消息组件测试）
- [x] 工具失败、无效参数、命令超时、取消、模型流中断、连续未知工具和最大迭代仍保留结构化结果与唯一停止事件，提示改造没有弱化现有安全限制。（验证：现有 Agent、工具、命令沙箱及 Web 端到端测试）
- [x] 人工对比只使用安全临时 Workspace 和未入库本地 Provider 配置；证据不复制密钥、完整敏感输出或机器绝对路径。（验证：人工记录审阅与 `git diff`/文件搜索）

## 项目检查

- [x] 全量自动化测试通过（验证：`npm run test`，退出码 0）
- [x] ESLint 通过（验证：`npm run lint`，退出码 0）
- [x] TypeScript 严格类型检查通过（验证：`npm run typecheck`，退出码 0）
- [x] 生产构建通过（验证：`npm run build`，退出码 0）
- [x] 运行时依赖无新增且 lockfile 没有无关变化（验证：检查 `package.json`、`package-lock.json` 差异）
- [x] 工作树只包含本功能相关变更，没有修改或删除用户已有无关内容（验证：`git status --short` 与 `git diff --check`）

## 端到端

- [x] 可控 OpenAI SSE：多次模型迭代包含读取、编辑、验证和最终回复 → 捕获请求显示稳定固定前缀、有序动态 system、读取后编辑、稳定工具定义及正确数值缓存累计。（验证：`npm test -- tests/web-tool-agent.e2e.test.ts`）
- [x] 可控兼容服务：分别只返回布尔命中、缺失缓存、异常缓存和完全无 usage → 对话均正常完成，页面或事件显示 status/unavailable，异常缓存不破坏合法基础 Token。（验证：Provider/Web 集成测试）
- [x] 浏览器桌面视口：切换 Plan、连续提交跨过强化周期、点击“按此计划执行”进入 Do → 模式状态、工具范围、Token/缓存、工具记录和最终停止原因一致，无错误覆盖层和控制台错误。（验证：开发服务器与浏览器实际操作）
- [x] 浏览器窄屏视口：有缓存、零缓存和不可用文案均完整可读，不遮挡消息、工具卡片或计划操作。（验证：窄屏浏览器实际操作）
- [x] tmux 真实闭环：使用用户未入库模型配置启动 OrbitCode，完成专用搜索、读取已有文件、编辑、验证和最终回复；工具序列及输出风格记录到人工对比文档，终端和证据不显示密钥。（验证：tmux 会话实际观察）
- [x] tmux 异常闭环：分别诱导无效工具参数、工具失败、命令超时和最大迭代；Agent 能纠正或以对应结构化原因停止，随后仍可开始新请求。（验证：tmux 会话与安全临时 Workspace 实际观察）
- [x] 人工对比：以与基线相同的 Provider、模型、模式、输入和复位 Workspace 重跑六类任务，逐项记录改造后结果与结论；环境不可用的条目保持未验证。（验证：`docs/evals/structured-system-prompt.md`）
- [x] 资源清理：浏览器、开发服务器、tmux 子进程和临时 Workspace 均已关闭或删除，无僵尸命令或残留测试服务。（验证：测试结束后的进程与临时目录检查）

## 实际结果

状态：已完成（2026-08-28）

- `npm test`：退出码 0，143 项通过；另单独执行两个 `.tsx` 组件测试文件，7 项通过。
- `npm run lint`：退出码 0。
- `npm run typecheck`：退出码 0。
- `npm run build`：退出码 0，首页与四个 API 路由均成功构建。
- `git diff --check`：退出码 0；`package.json` 与 `package-lock.json` 无变化，没有新增运行时依赖。
- 可控端到端测试完成真实文件的 `read_file → edit_file → read_file`，四次 Provider 请求的前三条 system 前缀与工具定义逐项相同，请求中没有 `cache_control`，缓存累计为 49/100 prompt Token。
- 真实浏览器桌面和 390px 窄屏均无错误覆盖层、页面错误或横向溢出；真实 Provider 显示 0 缓存，可控合法 SSE 显示 250 Token（25%）、命中和模型未报告三态。
- 浏览器网络证据确认 Plan 连续轮次为 1、2，“按此计划执行”切换 Do 后重置为 1；单元测试覆盖 1、5、9 的完整提醒周期。
- 六项人工对比全部执行：E1、E2、E4、E6 符合，E3、E5 因少量非必要读取标为部分符合；没有把未达项写成通过。
- tmux 真实异常闭环覆盖 `invalid-arguments` 后恢复、命令 timeout、not-found 恢复和 `max-iterations`；停止事件唯一且结构化。
- 凭据、认证头、完整环境变量、受保护文件内容和 Workspace 绝对路径均未写入验收文档或 DOM；动态提示安全测试通过。
- 浏览器、开发服务器和 tmux 会话均已关闭；人工夹具和临时 SSE 已移入废纸篓，可恢复，工作区内无残留评估目录。

剩余观察：真实模型在 E3、E5 中仍可能读取少量相邻文件。当前行为不影响 Plan 权限、工具安全或结果正确性，后续若继续优化，应针对停止决策改进，而不应放宽工具与 Workspace 边界。
