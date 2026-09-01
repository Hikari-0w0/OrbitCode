# 单次工具调用系统 Checklist

状态：已批准
依据：已批准的 `spec.md`、`plan.md` 与 `task.md`

> 每项都记录实际命令、退出码和关键观察；未执行的项目不得标记通过。不得使用真实 API Key 作为测试数据，不得把用户本地凭据、敏感文件内容或完整环境写入证据。

## 需求验收

- [x] C01 / AC1 / F1、F8：默认注册中心恰好枚举 `read_file`、`write_file`、`edit_file`、`run_command`、`find_files`、`search_code` 六个唯一工具，OpenAI 参数 Schema 与运行时校验一致；重复/未知名称、缺失/未知字段和错误类型均在执行前结构化拒绝。（验证：`npm test -- src/tools/schema.test.ts src/tools/registry.test.ts`，退出码 `0`；测试中的副作用计数保持 `0`）
- [x] C02 / AC2 / F2、F9：临时工作区内普通 UTF-8 文件读取成功；绝对路径、`..`、目录、符号链接、超限文件和敏感文件均被拒绝，结果只含安全相对路径且无哨兵秘密。（验证：`npm test -- src/tools/workspace.test.ts src/tools/file-tools.test.ts`，退出码 `0`）
- [x] C03 / AC3 / F3、F9：创建与覆盖文本文件成功；父目录不存在、越界、敏感目标、符号链接和注入的中途写入失败不会改变目录外或既有目标，临时文件被清理。（验证：`npm test -- src/tools/workspace.test.ts src/tools/file-tools.test.ts`，退出码 `0`；测试比较失败前后字节与目录清单）
- [x] C04 / AC4 / F4、F9：唯一原文只替换一次；零匹配、多匹配、替换无变化和并发快照冲突均返回清晰错误且文件字节不变。（验证：`npm test -- src/tools/file-tools.test.ts src/tools/workspace.test.ts`，退出码 `0`）
- [x] C05 / AC5 / F5、F10、F11：当前 Darwin 环境真实 Seatbelt 命令正常/非零退出均保留 stdout、stderr、退出码、信号、超时和取消；工作区外、敏感文件、秘密环境、网络及派生进程逃逸被阻断，探测失败时命令不启动。（验证：`npm test -- src/tools/macos-seatbelt-sandbox.test.ts src/tools/run-command.test.ts`，退出码 `0`，不得跳过 Darwin 安全用例）
- [x] C06 / AC6 / F6、F7、F9：文件查找与代码搜索返回排序稳定、数量受限的相对路径/行列；匹配、空结果、非法模式、不可读内容、忽略目录、截断、符号链接和敏感路径场景符合约定。（验证：`npm test -- src/tools/glob.test.ts src/tools/file-tools.test.ts`，退出码 `0`）
- [x] C07 / AC7 / F11、F16、F19：工具正常完成、内部异常、超时和用户取消均形成唯一终态；超时/异常可进入模型跟进，取消不产生第二次模型请求，命令子进程、计时器和监听器全部清理。（验证：`npm test -- src/tools/registry.test.ts src/tools/macos-seatbelt-sandbox.test.ts src/core/single-tool-agent.test.ts`，退出码 `0`）
- [x] C08 / AC8 / F12、F13：OpenAI 调用标识、名称和参数跨 SSE 事件及网络块仍被正确拼接；说明文本与单个工具调用可共存并继续执行；单调用分片缺省索引或 `null` 索引可归一化，无效 JSON、冲突/缺失标识、显式错误索引和多个调用均协议失败且不产出可执行调用。（验证：`npm test -- src/models/openai-provider.test.ts`，退出码 `0`）
- [x] C09 / AC9 / F14、F16：可控模型记录第一次请求的六个定义，以及第二次请求中顺序正确的用户消息、助手工具调用和结构化工具结果；工具成功与可恢复失败最终都得到基于真实结果的文本回复。（验证：`npm test -- src/core/single-tool-agent.test.ts tests/web-tool-agent.e2e.test.ts`，退出码 `0`；断言模型请求次数为 `2`）
- [x] C10 / AC10 / F14、F15、F18：直接文本只请求模型一次且不执行工具；工具路径只执行一次；第二次再次调用工具、无最终文本或协议失败时没有第三次请求，失败轮次不进入后续历史。（验证：`npm test -- src/core/single-tool-agent.test.ts tests/web-tool-agent.e2e.test.ts`，退出码 `0`；断言工具次数 `≤1`、模型次数 `≤2`）
- [x] C11 / AC11 / F17–F19：真实浏览器中工具名称、执行中、成功/失败/超时/取消、结构化结果和最终文本依次准确显示；模型阶段与命令阶段停止后恢复输入；副作用已可能发生但最终失败时出现明确警告。（验证：开发服务器 + `agent-browser`，保存文字观察记录，不保存含项目内容的截图）
- [x] C12 / AC12 / F18：完成纯文本、成功工具、失败和取消轮后，下一次模型请求只包含成功轮次的普通用户/最终助手消息；CLI 原有对话、配置、恢复和取消测试不回退。（验证：`npm test -- tests/web-tool-agent.e2e.test.ts src/core/conversation.test.ts tests/cli.e2e.test.ts`，退出码 `0`）
- [x] C13 / AC13 / N1、N2、N4、N8、N9：核心与工具模块不依赖 React/Next 页面，客户端不导入 Node 工具实现，包清单无新增运行时依赖或禁用框架，CLI 配置格式保持兼容。（验证：`npm run typecheck`、`npm run build` 均退出码 `0`；`git diff -- package.json package-lock.json` 无依赖变更；对 `src/core`、`src/tools`、客户端组件和包清单运行依赖边界搜索无违规结果）
- [x] C14 / AC14：全部自动化检查通过，并在开发服务器、真实浏览器和 tmux 中完成用户本地未入库模型配置的真实闭环；纯文本、六个工具、工具失败、非零退出、超时、取消、严格隔离拒绝与第二次工具调用终止均有实际证据，测试后无残留资源和凭据泄漏。（验证：本清单“项目检查”及“端到端”全部通过）

## 集成与架构

- [x] C15：Schema → 注册中心 → OpenAI 工具定义保持单一来源，生产注册顺序固定且没有页面层复制参数规则。（验证：`npm test -- src/tools/schema.test.ts src/tools/registry.test.ts tests/web-tool-agent.e2e.test.ts`，退出码 `0`）
- [x] C16：`SingleToolAgent` 只依赖 `ChatProvider` 与 `ToolRegistry` 抽象，工具模块不导入模型、React 或 Next.js，组件不导入 `node:*` 或 `src/tools`。（验证：`rg -n 'from ["'"'](react|next|next/|@/components|@/app)' src/core src/tools` 与 `rg -n 'from ["'"'](node:|@/tools)' src/components` 均无违规匹配；人工记录允许项）
- [x] C17：Web Route 只从服务端 `process.cwd()` 建立授权根，Web 请求仍只接受 Provider 和普通文本历史，伪造根目录、工具消息、调用标识或结果字段会在模型/工具执行前被拒绝。（验证：`npm test -- src/web/chat-contract.test.ts tests/web-tool-agent.e2e.test.ts`，退出码 `0`）
- [x] C18：第一次模型请求、工具执行、第二次模型请求与 Web SSE 的事件/消息顺序完全一致；工具 transcript 不由浏览器保存或在后续轮次回传。（验证：`npm test -- tests/web-tool-agent.e2e.test.ts`，退出码 `0`；检查 mock 捕获请求和解析后事件序列）
- [x] C19：现有纯文本 Web、CLI、Provider、SSE、配置和环境测试全部继续通过。（验证：`npm run test`，退出码 `0`）

## 安全与异常路径

- [x] C20：路径边界拒绝绝对路径、路径穿越、NUL、分隔符歧义、所有符号链接、并发目标替换和受保护路径；直接工具与遍历工具使用相同策略。（验证：`npm test -- src/tools/workspace.test.ts src/tools/file-tools.test.ts`，退出码 `0`）
- [x] C21：写入/修改在成功时原子提交，在验证、I/O 或并发失败时无部分目标和残留临时文件；副作用状态与真实提交一致。（验证：`npm test -- src/tools/workspace.test.ts src/tools/file-tools.test.ts`，退出码 `0`）
- [x] C22：Seatbelt 真实对抗测试证明仅设置 `cwd` 之外还有 OS 级限制：绝对路径、`../`、shell、Node 脚本和派生进程均不能读写外部哨兵；后端不可用时绝不普通 `spawn` 降级。（验证：`npm test -- src/tools/macos-seatbelt-sandbox.test.ts`，当前 Darwin 退出码 `0` 且用例未跳过）
- [x] C23：命令子进程只收到固定最小环境，读取 `.env` 等敏感文件和访问网络失败；stdout/stderr、错误、Web SSE、DOM 和测试输出均不含唯一哨兵密钥。（验证：Seatbelt 与 Web E2E 测试设置唯一假密钥后运行 `npm test -- src/tools/macos-seatbelt-sandbox.test.ts tests/web-tool-agent.e2e.test.ts`，退出码 `0`，再搜索捕获输出无匹配）
- [x] C24：命令非零退出、启动失败、输出截断、超时、用户取消、`SIGTERM` 无响应和 `SIGKILL` 清理均保留准确结构化字段；测试结束后派生进程不存在。（验证：`npm test -- src/tools/macos-seatbelt-sandbox.test.ts src/tools/run-command.test.ts`，退出码 `0`）
- [x] C25：文件、搜索、命令和 Web 结果的大小/条目/时间限制均生效，截断结果带字段级标记，不产生无界缓冲、未处理 Promise 或 Next.js 崩溃。（验证：`npm test -- src/tools/file-tools.test.ts src/tools/run-command.test.ts tests/web-tool-agent.e2e.test.ts`，退出码 `0`）
- [x] C26：模型或工具在文件提交/命令启动后失败时，Agent 与页面携带 `possible` 或 `applied`；只读失败保持 `none`，任何路径均不声称自动回滚。（验证：`npm test -- src/core/single-tool-agent.test.ts src/web/chat-contract.test.ts tests/web-tool-agent.e2e.test.ts`，退出码 `0`）
- [x] C27：停止、请求断开、成功、工具失败、模型失败和开发服务器结束后，模型响应读取器、Abort 监听器、计时器、临时目录、命令进程组和测试端口均被释放。（验证：相关自动化测试可自行退出；浏览器/tmux 验收后使用进程与端口检查记录无残留）

## 项目检查

- [x] C28：全部自动化测试通过。（验证：`npm run test`，退出码 `0`）
- [x] C29：ESLint 通过。（验证：`npm run lint`，退出码 `0`）
- [x] C30：TypeScript 严格类型检查通过。（验证：`npm run typecheck`，退出码 `0`）
- [x] C31：生产构建通过，客户端 bundle 未引入 Node 文件/进程工具或凭据加载模块。（验证：`npm run build`，退出码 `0`；结合构建日志和依赖边界测试）
- [x] C32：依赖和题目约束未回退。（验证：`git diff -- package.json package-lock.json` 不含新增依赖；`package.json`、`package-lock.json` 中无 LangChain、LlamaIndex、OpenAI Agents SDK、Claude Agent SDK、AutoGen、CrewAI 或托管执行依赖）

## 端到端

- [x] C33 / Web mock 完整闭环：在 tmux 中启动指向本地 OpenAI mock 的开发服务器，用真实浏览器完成纯文本和一次工具调用；观察首次请求工具定义、工具开始/终态、结构化结果、第二次 transcript、增量最终回复和成功历史。（验证：tmux 服务器输出 + `agent-browser` 页面观察 + mock 捕获记录；不使用真实凭据）
- [x] C34 / Web mock 异常闭环：依次脚本化未知工具、无效参数、唯一替换零/多匹配、命令非零退出、工具超时、第二次再调用工具、最终模型流失败；页面保持可操作，模型/工具次数不越界，副作用提示准确。（验证：`tests/web-tool-agent.e2e.test.ts` 和真实浏览器逐场景观察）
- [x] C35 / 取消闭环：在初始模型流、长命令和最终模型流三个阶段分别点击停止；请求中止、命令进程组退出、运行中卡片终止、失败轮不进历史，随后新请求可成功。（验证：真实浏览器 + mock 延迟场景 + 进程/请求记录）
- [x] C36 / 严格隔离闭环：从 Web 请求命令读取/写入工作区外哨兵、敏感文件、环境密钥、网络地址及通过子进程逃逸；每次均安全失败，外部哨兵字节不变，页面和模型结果不含秘密。（验证：真实浏览器 + mock 强制 `run_command` + 文件哈希/字节比较 + 进程记录）
- [x] C37 / 六工具真实模型闭环：使用用户本地未入库的 OpenAI 兼容模型配置，在 tmux 中启动开发服务器并用真实浏览器分别请求读取、创建临时测试文件、唯一修改、查找文件、搜索代码和运行无害本地命令；每轮至多一次工具且最终回复与结果一致。（验证：tmux + `agent-browser`；只操作专用临时测试目录，结束后按既定清理步骤移除测试产物）
- [x] C38 / 真实模型边界：使用真实模型请求工具失败、命令非零退出、超时、取消、严格隔离拒绝和需要第二个工具才能完成的任务；OrbitCode 在一次工具上限终止或给出最终回复，不连续自主执行。模型若无法稳定产生指定调用，项目保持未验证并记录实际响应，不以 mock 证据替代。（验证：tmux + 真实浏览器 + 服务端工具事件记录）
- [x] C39 / 页面与资源：桌面和窄屏下工具卡、长输出、折叠、截断、副作用警告、滚动和停止操作可用；页面无横向溢出、错误覆盖层或控制台错误；结束后关闭浏览器、开发服务器、mock 和 tmux 会话，无残留监听端口或子进程。（验证：`agent-browser` 页面/控制台/视口检查，以及 tmux、端口和进程检查）

## 实际结果

结果：39 / 39 项全部按各自验证口径通过。

- 自动化：最终 `npm test` 退出码 `0`，共 87 项通过、0 失败、0 跳过；`npm run lint`、`npm run typecheck`、`npm run build` 均退出码 `0`，生产构建无警告。`package.json` 与 `package-lock.json` 无改动，未新增依赖。
- 文件与搜索：新增超限读取、非法 UTF-8、绝对路径、`..`、NUL、反斜杠、敏感路径、写入符号链接、只读目录失败、快照冲突及提交前确定性故障注入。临时文件已落盘后模拟 rename 失败，目标无部分内容且 `.tmp` 被清理。`find_files` 的 1,000 条上限、`search_code` 的 500 条上限、长行预览、不可读文件和 1 MiB 跳过均有字段级截断证据。
- Provider 与 Agent：覆盖工具 ID/名称/参数跨 SSE 和网络块拼接、冲突/缺失 ID、缺省/`null`/错误索引、多调用、说明文本与工具调用共存、无效 JSON，以及兼容后续分片用 `null` 表示缺省字段。Agent 直接文本一次请求，工具路径最多两次模型请求；第一次说明文本可展示但不进入最终历史，第二次工具调用、最终流失败和取消均不产生第三次请求。`none`、`possible`、`applied` 副作用在最终模型失败时保持准确。
- Seatbelt：Darwin 真实用例允许工作区读写，阻断其他用户目录、系统配置/数据目录、敏感文件、环境哨兵、本机网络及派生 shell/Node 进程；覆盖非零退出、stdout/stderr 分别截断、100 ms 超时、`SIGTERM` 无响应后的 `SIGKILL`、真实 Abort 取消和后端不可用不降级。
- tmux + 本地 mock：在 `127.0.0.1` 完成纯文本和六工具闭环。请求日志确认首次请求包含六个定义与 `tool_choice:auto`，第二次为 `tool_choice:none` 且 transcript 尾部顺序是 user → assistant tool call → tool result。未知工具、无效参数、唯一替换零/多匹配、命令非零、超时、第二次调用和最终流失败均保持每轮不超过两次模型请求。
- 浏览器：实际观察执行中、成功、失败、超时、取消、结构化结果折叠、最终文本与副作用警告。初始模型、长命令和最终模型三个阶段分别停止后输入恢复；取消轮不进入下一次普通历史，长命令进程组无残留。桌面与 `390 × 844` 视口无横向溢出、错误覆盖层或控制台错误，128 KiB 长输出在卡片内滚动且 `stdoutTruncated:true`。
- Web 严格隔离：真实浏览器强制命令读取/写入外部哨兵、读取环境密钥和访问本机网络均失败；外部文件 SHA-256 前后相同，DOM、工具输出和服务日志均不含哨兵秘密。
- 真实 Provider：经用户明确授权，只在临时副本的 `fixture-real/` 假数据中完成 `read_file`、`write_file`、`edit_file`、`find_files`、`search_code`、`run_command` 六工具。读取标记、26 字节精确写入、唯一替换、两条 TypeScript 查找/搜索结果和命令 stdout 均与真实文件结果一致；同时覆盖缺失文件、退出码 7、100 ms 超时、初始模型取消和外部文件隔离拒绝。需要第二个工具的任务只出现一个实际工具卡，第二个文件标记未泄露；模型输出的文本形式 DSML 标签没有被执行。
- 资源与凭据：浏览器已关闭，三个 tmux 验收会话均不存在，端口 `3000`、`3001`、`4100` 无监听，命令子进程无残留。临时项目已移入废纸篓；其中复制的真实 `.env` 与 Provider 配置已单独永久移除，API Key 从未出现在命令输出、文档、截图或日志中。
