# Agent Loop 与 Plan Mode Checklist

状态：已批准
依据：已批准的 `spec.md`、`plan.md` 与 `task.md`

> 每项只在实际执行并记录证据后标记通过；未执行、环境不具备或结果不符合预期的项目保持 `[ ]`。

## 需求验收

- [ ] AC1 / F1、F5、F10：脚本模型依次请求读取、修改、验证命令并最终回复；检查每个后续请求都含此前 assistant tool_calls 与对应 tool 结果，公开历史最终只含本轮用户消息和最终助手文本。（验证：`npm run test -- src/core/agent-loop.test.ts tests/web-tool-agent.e2e.test.ts`）
- [x] AC2 / F2、F9：延迟分批发送文本、工具参数、finish reason 和 Usage；首个文本事件在传输完成前可观察，收集结果与上游一致，并同时收到 iteration/progress/token-usage 事件。（验证：`npm run test -- src/models/openai-provider.test.ts src/core/agent-loop.test.ts`）
- [x] AC3 / F3、F15：分别返回零、一个、多个跨分片工具调用，以及重复标识、稀疏/冲突索引、缺失字段、错误完成原因、完成后事件和截断流；合法调用按序组装，非法响应以 model-error 停止且不执行未开始工具。（验证：`npm run test -- src/models/openai-provider.test.ts src/core/agent-loop.test.ts`）
- [x] AC4 / F4：混合“多个读取 → 写入 → 多个读取 → 命令”时，时间记录证明同一只读批次可重叠、并发不超过 8，写入和命令不与其他调用重叠；模型 transcript 中结果顺序与原调用顺序相同。（验证：`npm run test -- src/core/tool-scheduler.test.ts tests/web-tool-agent.e2e.test.ts`）
- [ ] AC5 / F5、F14：无效 JSON、参数错误、路径拒绝、命令非零、超时、内部异常可回传并允许模型纠正；连续两个全未知迭代以 repeated-unknown-tool 停止，合法允许调用可重置计数，整个未知路径无副作用。（验证：`npm run test -- src/core/agent-loop.test.ts src/core/tool-scheduler.test.ts src/tools/mode-policy.test.ts`）
- [x] AC6 / F6、F7：默认最大迭代为 8，有效覆盖值按指定边界停止；空白、零、负数、非整数和大于 32 在请求模型前被拒绝；最后允许迭代仍请求工具时只确认调用、不执行并唯一停止为 max-iterations。（验证：`npm run test -- src/web/server-config.test.ts src/core/agent-loop.test.ts`）
- [x] AC7 / F7、F15：分别触发 final-response、max-iterations、cancelled、repeated-unknown-tool、model-error、agent-error；每轮恰有一个 stopped，包含正确迭代数与 sideEffect，Web 不把非成功原因显示为完成。（验证：`npm run test -- src/core/agent-loop.test.ts src/web/chat-handler.test.ts src/web/chat-contract.test.ts`）
- [x] AC8 / F8：模型流、并发只读批次、写入启动前和命令执行中取消时，当前工作收到同一取消信号，后续工具/模型不启动，读取器、计时器、监听器、命令及子进程被清理，随后可开始新轮次。（验证：相关单元测试、`npm run test -- src/core/agent-loop.test.ts src/core/tool-scheduler.test.ts src/web/chat-handler.test.ts`，以及 tmux 进程检查）
- [x] AC9 / F11、F12、F14：默认 Do 提供六个工具；独立输入 `/plan` 不产生聊天请求且页面切换模式，后续模型只看到三个只读工具，伪造写入/修改/命令调用在服务端以 permission-denied 拒绝且文件无变化；`/do` 同样不产生请求并恢复全部工具。（验证：`npm run test -- src/tools/mode-policy.test.ts tests/web-tool-agent.e2e.test.ts`，以及浏览器 Network/页面观察）
- [x] AC10 / F13：真实浏览器完成至少三个模型迭代和多个工具调用时，页面正确展示模式、文本、当前/最大迭代、阶段、工具完成数、各调用排队/执行/终态、结构化结果、reported/unavailable Usage 和唯一停止原因；桌面与窄屏无覆盖或横向溢出。（验证：开发服务器 + `agent-browser` 桌面/移动检查）
- [ ] AC11 / F10、F16：成功轮后执行失败、取消、最大迭代和未知工具停止轮，下一次上游请求只含成功历史；空白输入、并发提交、非法 mode、伪造内部历史和超限请求均在副作用前拒绝，之后合法请求仍成功。（验证：`npm run test -- src/core/agent-loop.test.ts src/web/chat-contract.test.ts tests/web-tool-agent.e2e.test.ts`）
- [x] AC12 / N1–N4：核心循环不导入 React、Next.js 或浏览器组件，Route Handler 不包含循环/调度状态机；依赖清单无新增包，也不存在禁止的 Agent 框架、SDK 或托管执行能力。（验证：`npm run typecheck`、`npm run build`、依赖与 import 的 `rg` 检查、`git diff -- package.json package-lock.json`）
- [x] AC13 / N6–N9、N11：工具调用数、只读并发数、历史、请求体、输出和迭代上限均被测试；既有路径、敏感文件、命令隔离、超时、截断、取消测试继续通过；浏览器事件、DOM、日志和测试输出不包含哨兵凭据、内部堆栈或上游原始错误正文。（验证：`npm run test`、浏览器控制台与输出哨兵检查）
- [ ] AC14 / 全部需求：完整自动化检查、浏览器流程、tmux 多迭代闭环和在可用情况下的真实模型场景均按下列项目执行；测试结束后无残留浏览器、服务器、监听端口、读取器或子进程，证据不含凭据。（验证：本清单全部适用项的实际记录）

## 模型协议与响应收集

- [x] OpenAI 请求在提供工具时包含完整模式过滤 definitions、`parallel_tool_calls: true` 和 `stream_options.include_usage: true`；纯文本 CLI 请求保持原有无工具行为。（验证：Provider 与 CLI 测试中的请求体断言）
- [x] 多工具 accumulator 只接受 0–15 的连续索引、最多 16 个调用和唯一安全 callId；调用按 index 升序产出，任意网络分块不改变结果。（验证：`npm run test -- src/models/openai-provider.test.ts`）
- [x] assistant 的可选说明文本与多 tool_calls 在内部 transcript 中完整保留，每个 tool 结果使用对应 callId，序列化后符合 OpenAI 兼容消息顺序。（验证：Provider 序列化测试与 Web 集成上游请求记录）
- [x] Usage 位于 finish reason 之前或之后的合法兼容场景均正确收集；缺失产生 unavailable，负数、非整数、字段矛盾或重复 Usage 被拒绝且不泄露原始正文。（验证：Provider 与 Agent Loop 测试）
- [x] 流缺少 finish reason、缺少 `[DONE]`、`[DONE]` 后仍有事件或读取中断时不会执行该响应中的工具。（验证：Provider 和 Agent Loop 的执行计数断言）

## 调度、权限与安全边界

- [x] 调度器只依据注册中心服务端 mutability 分类，不信任模型参数或名称对副作用属性的声明。（验证：调度器假工具测试）
- [x] 连续只读段可并发，但读取不会跨越写入/命令边界提前执行；所有副作用调用为单例串行。（验证：调度器时间线断言）
- [x] 并发只读批次中一个工具失败不会取消或遗留同批其他任务，所有 Promise 都被收敛，最终结果仍按调用顺序完整返回。（验证：调度器失败测试与未处理 rejection 监测）
- [x] Plan definitions 和执行策略均只允许 `read_file`、`find_files`、`search_code`；禁用工具连参数校验和底层 execute 都不会进入。（验证：mode-policy 解析/执行计数断言）
- [x] 未知工具与模式禁用工具分别返回 `unknown-tool` 和 `permission-denied`，名称经过长度/字符限制，结果不含任意模型输入或内部实现详情。（验证：Registry、mode-policy、Web contract 测试）
- [x] 文件路径穿越、绝对路径、符号链接逃逸、受保护文件、并发写冲突和部分写入防护的既有测试全部继续通过。（验证：`npm run test -- src/tools/workspace.test.ts src/tools/file-tools.test.ts`）
- [x] 命令继续要求 macOS Seatbelt 严格隔离，凭据环境不传入；失败、非零退出、超时和取消保留结构化字段，取消后无派生进程。（验证：`npm run test -- src/tools/run-command.test.ts src/tools/macos-seatbelt-sandbox.test.ts`）

## 核心循环与历史

- [ ] 每个模型迭代开始前有 progress(model)，工具阶段有 progress(tools) 与完成计数；每个真实执行调用至多一个 started 和一个 result。（验证：Agent Loop 精确事件序列断言）
- [ ] 第 1 至第 7 次工具响应可继续循环；第 8 次仍请求工具时不执行末批并以 max-iterations 停止；把配置改小后边界相应变化。（验证：Agent Loop 与 server-config 测试）
- [ ] final-response 必须带非空 finalMessage 并提交历史；其余 stopped 不带可提交最终消息且不改变公开历史。（验证：Agent Loop 历史断言）
- [ ] sideEffect 按 `none < possible < applied` 跨批次聚合，取消、模型错误和最大迭代停止均报告停止时真实最高状态。（验证：Agent Loop 多批次错误测试）
- [ ] 同一 session 的第二个并发 streamTurn 在任何模型或工具执行前被拒绝；首轮停止后状态恢复为 idle。（验证：Agent Loop 并发测试）
- [ ] Plan 和 Do 的固定 system 提示由服务端插入，浏览器不能提交 system/tool/tool_calls 消息；实际权限测试不依赖提示词结果。（验证：Web contract 拒绝测试和上游请求记录）

## Web 契约与界面

- [x] Web 请求只接受精确的 `provider`、`mode`、`messages`，继续执行角色顺序、消息数、消息长度和请求体大小限制；客户端不能传最大迭代值。（验证：`npm run test -- src/web/chat-contract.test.ts tests/web-tool-agent.e2e.test.ts`）
- [x] 每种 AgentEvent 经过服务端编码和客户端解析后字段无损，额外字段、非法判别组合、非法计数和恶意工具名被拒绝。（验证：`npm run test -- src/web/chat-contract.test.ts src/web/chat-handler.test.ts`）
- [x] 请求取消、ReadableStream cancel、页面卸载和停止按钮均触发服务端 AbortController；连接关闭后 handler 不再 enqueue 或产生重复 stopped。（验证：handler 测试和浏览器停止观察）
- [ ] `/plan`、`/do` 只有严格独立命令触发模式切换；`/plan 请分析` 等普通文本不会被客户端静默截断或误判。（验证：组件交互与浏览器 Network 观察）
- [ ] Provider 切换、清空和刷新恢复 Do；生成中模式切换、Provider 切换、清空和重复发送不可用。（验证：真实浏览器交互）
- [ ] 非 final-response 轮次的部分文本和工具卡保留供检查，但不会进入下一轮请求；有副作用时页面显示明确警告。（验证：Web 集成上游记录和浏览器观察）
- [ ] 模型文本、工具参数和工具结果仅作为文本或 JSON 结构显示；HTML/脚本哨兵不创建可执行 DOM，长内容遵守折行/滚动和截断提示。（验证：浏览器 DOM 与控制台检查）

## 项目检查

- [x] 自动化测试通过。（验证：`npm run test`，退出码 `0`）
- [x] ESLint 通过。（验证：`npm run lint`，退出码 `0`）
- [x] TypeScript 严格类型检查通过。（验证：`npm run typecheck`，退出码 `0`）
- [x] 生产构建通过。（验证：`npm run build`，退出码 `0`）
- [x] 未新增运行时或开发依赖，`package.json` 与 `package-lock.json` 没有本轮依赖变更。（验证：`git diff -- package.json package-lock.json`）
- [x] 旧 `SingleToolAgent` 文件和引用已移除，Web Route 只组装新核心。（验证：`rg -n "SingleToolAgent|single-tool-agent" src tests` 无匹配）
- [x] README 与 `.env.example` 准确说明默认 8、硬上限 32、Plan/Do、Usage 缺失语义、CLI 边界和本地部署风险，不包含真实密钥。（验证：人工核对与哨兵搜索）

## 浏览器与端到端

- [ ] 使用开发服务器和可控本地模型完成直接文本回复，首个文本增量在最终停止前显示，页面无 Next.js 错误覆盖层或控制台错误。（验证：`agent-browser`）
- [ ] 使用可控本地模型完成至少三迭代的“读取 → 修改 → 命令验证 → 最终回复”闭环，页面过程与上游 transcript 一致，目标文件变化符合预期。（验证：tmux 启动服务 + `agent-browser`，使用临时测试工作区）
- [ ] 同一响应触发混合多工具调用，页面能区分所有 callId，实际时间线满足只读并发和副作用串行。（验证：带延迟的本地模拟模型/工具记录）
- [ ] Plan 模式分析任务并生成文本计划，工作区无变化；切换 Do 后显式提交执行请求，允许写入与命令并最终回复。（验证：浏览器操作、工作区前后快照）
- [ ] 分别观察工具无效参数、路径拒绝、命令非零、命令超时和工具内部失败，Agent 可恢复并由模型调整或说明，页面结构化状态正确。（验证：tmux + 本地模拟模型）
- [ ] 分别观察最大迭代、连续未知工具、模型流截断/非法事件和 agent-error，页面停止原因准确且下一轮历史不含失败轮。（验证：tmux + 本地模拟模型）
- [ ] 在模型流、并发读取和命令运行期间分别点击停止，页面恢复可输入，服务端与工具取消，无残留命令、子进程或监听端口。（验证：`agent-browser` + tmux 进程/端口检查）
- [ ] 在常见桌面视口和窄屏移动视口检查模式、进度、Usage、工具卡、长输出、停止状态、键盘焦点和减少动画偏好。（验证：`agent-browser` 视口切换与截图观察；截图不入库）
- [x] 测试完成后关闭浏览器并停止开发服务器、mock 服务和 tmux 会话，确认无本轮残留进程。（验证：进程与监听端口检查）
- [ ] 若用户本地未入库配置可用，使用真实 OpenAI 兼容模型完成一次多迭代只读任务和一次 Plan 模式任务；终端、DOM、日志和证据不出现 API Key。若环境不可用，本项保持未验证并记录原因。（验证：真实模型 + `agent-browser`）

## 实际结果

2026-08-28 实际执行：

- `npm run test`：退出码 0，103/103 通过。
- `npm run lint`、`npm run typecheck`、`npm run build`：退出码均为 0；Next.js 四个路由构建成功。
- tmux 定向回归：Agent Loop、调度、Web handler 与 Web 多迭代 E2E 共 15/15 通过；会话随后关闭。
- `agent-browser`：桌面和 390×844 视口均无横向溢出、错误覆盖层或控制台错误；可控三轮 SSE 展示两个并发只读调用、一个写入调用、reported/unavailable Usage 和 final-response；停止按钮恢复输入，取消轮次未写入下一次请求历史。
- 独立 `/plan`、`/do` 操作前后聊天请求计数保持不变，模式与服务端工具范围提示正确切换。
- 浏览器、开发服务器和 tmux 已关闭，TCP 3000 无监听；截图位于工具临时目录，未写入仓库。
- 未使用用户本地真实 API Key。依据仓库 `AGENTS.md` 的测试安全约束，真实模型项保持未验证；本轮使用本地 mock Provider、真实 Agent 核心/文件工具集成测试和浏览器可控 SSE 完成验收。
- 仍未勾选的场景未被推测为通过，主要是完整“读取→修改→命令”浏览器闭环、全部异常路径的浏览器逐项观察，以及真实模型验收。
