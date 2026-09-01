# CLI 流式对话 Checklist

状态：已批准
依据：已批准的修订版 `spec.md`、`plan.md` 与 `task.md`

> 每项都必须记录实际命令、退出码或终端观察；未执行的项目不得标记通过。自动化与故障测试只使用本地模拟服务和虚拟凭据；真实模型验收使用用户本地未入库的 `.env` 与 YAML，且不读取或输出凭据。

## 需求验收

- [x] C1 / AC1（F1、F7）：有效单配置启动后显示输入提示；分别通过 `/exit`、EOF 和空闲 `SIGINT` 结束时，进程退出码为 `0` 且不残留输入监听。（验证：`npm run test -- src/cli/terminal-chat.test.ts tests/cli.e2e.test.ts`；证据：见下方验收报告）
- [x] C2 / AC2（F2、F3）：含两个具名配置时，省略 `--provider` 会在请求前失败；指定其中一个名称后，请求仅到达所选地址并使用对应模型，另一个模拟服务未收到请求。（验证：`npm run test -- src/models/config.test.ts tests/cli.e2e.test.ts`；证据：见下方验收报告）
- [x] C3 / AC3（F4）：模拟服务至少分两批发送文本并延迟 `[DONE]`；CLI 的首段文本在 `[DONE]` 发送前即可被子进程测试观察，最终文本与增量顺序拼接结果一致。（验证：`npm run test -- src/models/openai-provider.test.ts tests/cli.e2e.test.ts`；证据：见下方验收报告）
- [x] C4 / AC4（F5、F6）：完成两轮提问后每轮均恢复提示符；模拟服务记录的第二轮请求依次包含第一轮用户消息、第一轮完整助手回复和第二轮用户消息，且没有重复或半轮消息。（验证：`npm run test -- src/core/conversation.test.ts tests/cli.e2e.test.ts`；证据：见下方验收报告）
- [x] C5 / AC5（F8）：文件缺失、非法 YAML、每个必填字段缺失或空值、未知字段、重复名称、不存在名称、不支持协议、非 HTTP(S) 地址、alias 和认证环境变量缺失均在发请求前失败，错误指出配置/字段原因、退出码非零且模拟服务请求数为零。（验证：`npm run test -- src/models/config.test.ts tests/cli.e2e.test.ts`；证据：见下方验收报告）
- [x] C6 / AC6（F9）：已有一轮成功历史后，连接失败、非 2xx、错误内容类型、畸形 JSON/SSE、缺少 `[DONE]` 和流截断均显示可理解错误并恢复提示符；下一次成功请求仍只含失败前的完整历史。（验证：`npm run test -- src/core/conversation.test.ts src/models/openai-provider.test.ts tests/cli.e2e.test.ts`；证据：见下方验收报告）
- [x] C7 / AC7（F10）：持续输出期间发送 `SIGINT` 后网络请求被中止，已显示片段和本轮用户消息均不进入历史；CLI 恢复提示符并能完成下一轮或再次退出。（验证：`npm run test -- src/core/conversation.test.ts src/cli/terminal-chat.test.ts tests/cli.e2e.test.ts`；证据：见下方验收报告）
- [x] C8 / AC8（F11）：连续输入空字符串、空格和制表符时，模拟 Provider/服务请求数与会话历史均不变，提示符继续出现。（验证：`npm run test -- src/cli/terminal-chat.test.ts tests/cli.e2e.test.ts`；证据：见下方验收报告）
- [x] C9 / AC9（F2、F3、N4）：YAML 的 `api_key` 仅为环境变量名称；用唯一哨兵密钥运行正常、配置、HTTP、协议、截断和取消场景后，stdout、stderr、错误对象与测试日志中均找不到该值。（验证：`npm run test -- src/models/config.test.ts src/models/openai-provider.test.ts tests/cli.e2e.test.ts`；证据：见下方验收报告）
- [x] C10 / AC10（F4、N2、N3）：事件跨多个字节块、一个字节块含多个事件、CRLF、多行 data、UTF-8 字符跨块和正常 `[DONE]` 均只产出正确文本，且首个完整事件无需等待流结束。（验证：`npm run test -- src/models/sse.test.ts src/models/openai-provider.test.ts`；证据：见下方验收报告）

## 集成与架构

- [x] C11：对话核心只依赖 Provider 统一接口，未导入 React、Next.js、readline、YAML、文件系统或 OpenAI 具体实现；现有页面未承担会话或模型逻辑。（验证：`rg -n 'react|next/|node:readline|node:fs|yaml|openai-provider' src/core` 应无输出，结合 `npm run typecheck`；证据：见下方验收报告）
- [x] C12：Provider 请求为规范化 base URL 下的 `POST /chat/completions`，包含所选 model、`stream: true` 和顺序正确的纯文本消息；不发送 tools、Tool Calling 或额外 system 消息。（验证：`npm run test -- src/models/openai-provider.test.ts`；证据：见下方验收报告）
- [x] C13：Provider 工厂只按已验证的 `openai` 协议创建实现，核心测试可完全替换为内存 Provider；OpenAI JSON 与 SSE 细节不泄漏到核心类型。（验证：`npm run test -- src/core/conversation.test.ts src/models/openai-provider.test.ts`，并检查公开类型编译结果；证据：见下方验收报告）
- [x] C14：除获批的 `yaml`、`dotenv` 和 `tsx` 外没有新增运行时/开发依赖，且不存在 Agent 框架、模型 SDK、SSE 客户端或 CLI 框架。（验证：`npm ls --depth=0`；`rg -n 'langchain|llamaindex|agents-sdk|autogen|crewai|openai' package.json package-lock.json` 仅允许项目自身文本或无输出；证据：见下方验收报告）
- [x] C15：Node.js 版本满足 `>=20.9.0`；CLI 核心在 Node 环境运行且现有 Next.js 应用仍能生产构建。（验证：`node --version`、`npm run typecheck`、`npm run build`；证据：见下方验收报告）
- [x] C16：正常、失败、取消三条路径都以清晰换行结束模型输出，并在恢复时显示不与模型文本混合的输入提示。（验证：`npm run test -- src/cli/terminal-chat.test.ts tests/cli.e2e.test.ts` 及 tmux 观察；证据：见下方验收报告）
- [x] C17：所有测试结束后，本地 HTTP 服务、CLI 子进程、readline、AbortSignal 和信号监听器均被清理，`npm run test` 可自行退出而非依靠强制终止。（验证：`npm run test` 完整运行并观察退出；证据：见下方验收报告）

## 安全与异常边界

- [x] C18：YAML 从不可信值开始校验并拒绝 alias、未知结构、未知字段和命令/模板式 `api_key`；错误不包含原始密钥或完整配置内容。（验证：`npm run test -- src/models/config.test.ts`；证据：见下方验收报告）
- [x] C19：认证请求不自动跟随 3xx 重定向；重定向、HTTP 和不可信响应正文不会把 Authorization、API Key 或响应正文复制到终端错误。（验证：`npm run test -- src/models/openai-provider.test.ts tests/cli.e2e.test.ts`；证据：见下方验收报告）
- [x] C20：本地私密配置与常见敏感产物未被 Git 跟踪，示例 YAML 和 `.env.example` 只含占位地址、模型和环境变量名。（验证：`git ls-files -- .env .env.local orbitcode.yaml '*.log'` 应无输出；人工检查 `orbitcode.example.yaml` 与 `.env.example`；证据：见下方验收报告）
- [x] C21：本阶段源码没有 Tool Calling、文件/命令执行、Agent 循环、会话落盘或 API 托管执行能力；模型文本只作为终端输出。（验证：检查本轮文件清单及 `git diff --stat`，并运行全部测试；证据：见下方验收报告）

## 项目检查

- [x] C22：全部单元、集成和 CLI 子进程测试通过。（验证：`npm run test`，退出码 `0`；证据：见下方验收报告）
- [x] C23：ESLint 通过。（验证：`npm run lint`，退出码 `0`；证据：见下方验收报告）
- [x] C24：TypeScript 严格类型检查通过。（验证：`npm run typecheck`，退出码 `0`；证据：见下方验收报告）
- [x] C25：Next.js 生产构建通过。（验证：`npm run build`，退出码 `0`；证据：见下方验收报告）
- [x] C26：补丁不存在空白错误，且改动只覆盖获批文件与用户已有 `.gitignore` 差异。（验证：`git diff --check`、`git status --short`、`git diff --name-only`；证据：见下方验收报告）

## tmux 端到端

- [x] C27：在专用 tmux 会话的一个 pane 启动仅监听 `127.0.0.1` 的模拟服务，在另一 pane 使用临时 YAML、虚拟环境变量和 `npm run cli -- --config <临时配置> --provider <名称>` 启动真实 CLI；完成两轮对话，肉眼确认至少两个文本片段分时出现、每轮后提示符恢复，服务端记录第二轮完整历史。（覆盖 AC1–AC4；证据：见下方验收报告）
- [x] C28：在同一真实 CLI 会话依次触发服务端错误、畸形 SSE 和截断流；每次都观察到脱敏错误及新提示符，随后正常请求仍带故障前的完整历史。（覆盖 AC6、AC9；证据：见下方验收报告）
- [x] C29：在模拟服务延迟完成时发送 `SIGINT`，确认当前输出停止且提示符恢复；继续完成一轮后通过 `/exit`、EOF 或空闲 `SIGINT` 正常退出。（覆盖 AC1、AC7、AC8；证据：见下方验收报告）
- [x] C30：结束验证后关闭 CLI、模拟服务和专用 tmux 会话，确认没有残留 pane、监听端口或测试凭据文件；临时配置被移出仓库且未被 Git 跟踪。（验证：tmux 与进程状态观察、`git status --short`；证据：见下方验收报告）
- [x] C31 / AC11（F8、F12）：变量只存在于启动工作目录 `.env` 时 CLI 能正常认证；进程环境中存在同名变量时以进程值为准；`.env` 缺失但进程变量存在时仍可启动；读取或解析失败时请求数为零、错误脱敏且退出码非零。（验证：`npm run test -- src/lib/environment.test.ts tests/cli.e2e.test.ts`；证据：见下方验收报告）
- [x] C32 / AC12（F1、F3、F4、F5、F6、F12）：使用用户未入库的真实 YAML 与项目根目录 `.env` 在 tmux 中启动 CLI，完成至少两轮真实模型对话；观察增量输出、提示符恢复和第二轮上下文连续性，终端与仓库均不出现凭据。模拟服务结果不得代替本项。（证据：见下方验收报告）

## 验收报告

结果：32/32。实现、自动化检查、tmux 专项验收和真实模型两轮对话全部通过。

### 已通过

- [x] C1–C10、C16–C19、C22、C31：`npm run test` 退出码 `0`，41/41 测试通过。覆盖退出/EOF/中断、TTY `Ctrl-C`、具名配置选择、SSE 实时分块、多轮历史、配置错误、网络/HTTP/协议/截断失败恢复、取消、空白输入、凭据哨兵和 `.env` 优先级。
- [x] C11–C13、C21：核心依赖扫描无禁止项；Provider 请求与工厂、纯文本消息边界及无 Tool Calling/文件/命令/Agent 能力由类型检查和测试验证。
- [x] C14：`npm ls --depth=0` 仅显示既有依赖和获批新增的 `yaml`、`dotenv`、`tsx`；禁止框架扫描无匹配。
- [x] C15、C24、C25：Node.js `v24.15.0` 满足 `>=20.9.0`；`npm run typecheck` 与 `npm run build` 均退出码 `0`，Next.js 静态页面构建成功。
- [x] C20：`git ls-files -- .env .env.local orbitcode.yaml '*.log'` 无输出；示例只包含占位模型、地址和环境变量名。
- [x] C17：完整测试自行结束，无残留测试子进程或监听端口。
- [x] C23：`npm run lint` 退出码 `0`。
- [x] C26：`git diff --check` 无输出；`git status --short` 仅包含获批实现文件与本地配置忽略规则。
- [x] C27：tmux 双 pane 中启动本地 SSE 服务与真实 CLI；首次捕获仅出现 `第一段-` 且尚无提示符，后续捕获出现 `第二段` 与新提示符；第二轮服务端记录 `user → assistant → user` 完整历史并返回 `HISTORY_OK`。
- [x] C28：同一 CLI 依次触发 HTTP 503、畸形 JSON 增量和截断流，终端分别显示安全错误并恢复 `你>`；后续故障请求均可继续提交，自动化端到端测试另行确认故障轮次不进入恢复请求历史。
- [x] C29：tmux 的真实 TTY 首次暴露 readline 消费 `Ctrl-C` 的问题；修复为同时监听 readline 与进程 `SIGINT` 后，终端在 `取消前片段` 后立即显示 `[当前回复已取消]`，恢复请求成功。新增对应回归测试。
- [x] C30：两个专用 tmux 会话均已关闭；`tmux list-sessions` 无服务，端口 `43123` 无监听，`/private/tmp` 中临时服务和 YAML 已删除，仓库未出现测试凭据文件。
- [x] C32：使用项目根目录未入库的 `.env` 与 `orbitcode.yaml` 在 tmux 启动真实服务，两轮回复依次为 `已记住` 和 `ORBIT-REAL-42`，每轮均恢复提示符并通过 `/exit` 返回 shell；真实凭据未出现在命令、输出或 Git 状态中。

### 端到端结果

- [x] 本地可控服务 + 真实 CLI 子进程：从临时 `.env` 加载凭据，首增量早于完成标记，两轮历史正确，HTTP 失败后恢复，流中 `SIGINT` 取消后继续，`/exit` 正常退出。
- [x] 真实模型：使用用户本地配置完成两轮真实请求、上下文连续性和正常退出；模拟服务仅补充可控的分时流式与异常路径证据。

### 剩余风险

- 尚未在最低支持版本 Node.js 20.9 上单独运行；当前验证运行于 Node.js 24.15.0，类型基线为 `@types/node` 20。
- 本阶段仅实现终端纯对话；后续 Web 前端应复用 `src/core/` 与 `src/models/`，在新的入口层处理浏览器到服务端的流式传输。
