# Workspace 选择与 Plan 执行工作流 Checklist

状态：已批准
依据：已批准的 `spec.md`、`plan.md` 与 `task.md`

> 每项都记录实际验证证据；未执行的项目不得标记通过。本文档获批并完成实现后才开始勾选。

## 需求验收

- [x] AC1 / F1、F2、F13：分别在 Workspace 配置缺失、包含多个合法项、重复 ID、非目录和不可读目录时加载 Catalog；缺失时仅显示启动目录默认项，合法配置可选，非法配置在请求模型前安全报错。（验证：`npm test -- src/web/workspace-config.test.ts src/web/chat-contract.test.ts`，并检查 API 响应/测试日志不含哨兵凭据或规范路径）
- [x] AC2 / F3、F4、F12：在 Workspace A 中建立对话、草稿和可执行 Plan 后切换 B；页面显示 B，清空 A 的历史/草稿/计划并回到 Do。切换 Provider 或清空对话保留 B，刷新使用服务端默认 workspace。（验证：`npm test -- src/components/chat-session-state.test.ts`，再以真实浏览器操作观察）
- [x] AC3 / F5、N2、N3：正常聊天请求仅提交 Workspace ID；未知、超长、已移除、当前不可用的 ID 以及额外绝对路径字段均在 Agent 创建和工具副作用前被拒绝，且不回退到启动目录。（验证：`npm test -- src/web/chat-contract.test.ts src/web/workspace-config.test.ts tests/web-tool-agent.e2e.test.ts`）
- [x] AC4 / F6、N3、N4：在两个含同名文件的临时 workspace 中分别执行读取、搜索、写入和命令，结果始终来自当前选择；路径穿越、外部符号链接和敏感文件仍被拒绝，沙箱不串用根目录。（验证：`npm test -- tests/web-tool-agent.e2e.test.ts src/tools/workspace.test.ts src/tools/file-tools.test.ts src/tools/macos-seatbelt-sandbox.test.ts`）
- [x] AC5 / F7、F8：可见控件和严格独立的 `/plan`、`/do` 都能往返切换且不请求模型；Plan 中模型只看到 `read_file`、`find_files`、`search_code`，伪造写入/命令无副作用拒绝，Do 恢复全部工具。（验证：`npm test -- src/tools/mode-policy.test.ts src/components/chat-session-state.test.ts src/components/chat-workspace.test.tsx tests/web-tool-agent.e2e.test.ts`）
- [x] AC6 / F9、F11：Plan 模式提交含糊任务时，模型以普通最终回复澄清，用户答复后继续使用同一 workspace、Plan 模式和公开历史得到计划；全程不写文件、不运行命令、不因模型文本自动切到 Do。（验证：真实模型的浏览器/tmux 多轮场景，同时观察工具事件与工作目录文件状态）
- [x] AC7 / F10、F11、F12：仅当前 workspace 最新成功 Plan 回复显示“按此计划执行”；点击一次后切换 Do，追加可见执行消息并发起仅一个新请求，请求历史包含计划。失败、取消、旧回复和 workspace 切换后均不可执行。（验证：`npm test -- src/components/chat-session-state.test.ts src/components/chat-workspace.test.tsx`，并在浏览器 Network 中确认单次 Do 请求）
- [x] AC8 / F12、F13：模型或工具执行期间 Workspace、Provider 和 Plan/Do 控件均禁用；取消或流错误后保留当前 workspace，未完成回复不进入成功历史或可执行计划。workspace 失效后有安全提示，修复并重载可继续。（验证：`npm test -- src/components/chat-session-state.test.ts src/web/chat-handler.test.ts`，并以浏览器执行取消/目录临时失效场景）
- [x] AC9 / N1、N8：浏览器只持有 workspace ID，Route Handler 将其解析为 `WorkspaceBoundary` 后再构造 Agent；`src/core/` 不导入 React、Next.js、Workspace Catalog 配置或 UI reducer。（验证：`npm run typecheck`、`npm run build`，以及 `rg -n "react|next/|next\\.|workspace-config|chat-session-state" src/core`，预期无非测试违规导入）
- [x] AC10 / N5、N9、N10：Workspace 数量、ID 和名称上限均有自动化测试，无扫描整机行为；运行时依赖未增加，原 Agent Loop、Provider、Plan 权限、工具、沙箱、取消和 Web SSE 测试全部通过。（验证：`git diff -- package.json package-lock.json`、`npm run test`）
- [x] AC11 / N6、N7：桌面和窄屏浏览器中可辨认 Workspace、Plan/Do、禁用状态和执行计划操作，所有交互键盘可达且无控制台错误；Network、DOM、notice 和测试输出不含 API Key、受保护内容或 workspace 规范路径。（验证：真实浏览器分别使用宽度 1440px 与 390px 检查，并搜索哨兵值）
- [x] AC12 / F1–F13：全部自动化命令以退出码 0 完成；开发服务下用两个安全临时 workspace 完成选择、隔离读取、Plan 澄清、计划确认、Do 写入/读回、workspace 失效和取消闭环，结束后无残留进程或临时目录。（验证：`npm run test`、`npm run lint`、`npm run typecheck`、`npm run build`、真实浏览器和 tmux 纪录）

## 集成与架构

- [x] Workspace Catalog 的“列表时摘要”和“聊天时重新解析”完成同一授权链，不会信任旧的可用性快照。（验证：先加载 Catalog，再移除/改权目录并发起聊天，预期请求在模型前失败）
- [x] `POST /api/chat` 在 workspace 解析成功后才创建 Provider、Tool Registry 和 Agent Loop，且每个请求仅注入一个边界。（验证：Route/Agent 集成测试的调用计数和双目录结果）
- [x] Plan/Do 的 UI 控件、斜杠命令、请求快照和服务端 `ModeToolPolicy` 对同一 `AgentMode` 契约一致。（验证：`npm test -- src/components/chat-session-state.test.ts src/tools/mode-policy.test.ts tests/web-tool-agent.e2e.test.ts`）
- [x] “按此计划执行”走普通 Web 聊天、SSE、Agent Loop 和 Tool Scheduler 链路，不存在 UI 直接执行工具的旁路。（验证：浏览器 Network/SSE 事件与工具记录）
- [x] Workspace 配置、Web 会话 reducer 和 React 控件未进入 `src/core/`；Agent Loop 现有公共接口不因本轮 UI 工作流改动。（验证：架构搜索、`git diff -- src/core`、`npm run typecheck`）

## 安全与异常路径

- [x] 配置拒绝 YAML alias、重复键、未知字段、重复 ID、非绝对路径、超数量/长度上限、非目录和不可访问目录。（验证：`npm test -- src/web/workspace-config.test.ts`）
- [x] Web 请求拒绝 workspace 绝对路径、额外 cwd/path 字段、未知 ID 和超长 ID，且不回退至默认 workspace。（验证：`npm test -- src/web/chat-contract.test.ts src/web/workspace-config.test.ts`）
- [x] 从 Workspace A 尝试 `../`、绝对路径、外部符号链接、`.env` 和 Workspace B 文件均返回结构化安全拒绝，无副作用。（验证：`npm test -- src/tools/workspace.test.ts src/tools/file-tools.test.ts tests/web-tool-agent.e2e.test.ts`）
- [x] Plan 中伪造 `write_file`、`edit_file` 和 `run_command` 都返回 `permission-denied` 且 `sideEffect: "none"`，不因 UI 显示错误而放宽权限。（验证：`npm test -- src/tools/mode-policy.test.ts tests/web-tool-agent.e2e.test.ts`）
- [x] 命令失败、超时、Abort 和沙箱不可用继续保留 stdout、stderr、退出/超时信息与正确副作用状态，不访问非当前 workspace。（验证：`npm test -- src/tools/run-command.test.ts src/tools/macos-seatbelt-sandbox.test.ts`）
- [x] 连续点击计划执行、请求期间切换、SSE 断流、取消、workspace 在 Catalog 加载后失效均不会双重执行或污染成功历史。（验证：`npm test -- src/components/chat-session-state.test.ts src/web/chat-handler.test.ts`，并用浏览器验证）
- [x] API 响应、SSE 事件、DOM、控制台、服务端日志和测试输出不含真实 API Key、完整环境变量、受保护文件内容或 workspace 规范路径。（验证：使用唯一哨兵值运行自动测试与浏览器检查，对输出做定向搜索）

## 回归与项目检查

- [x] 全量单元、集成和 CLI/Web E2E 测试通过（验证：`npm run test`，退出码 0）
- [x] ESLint 通过（验证：`npm run lint`，退出码 0）
- [x] TypeScript 严格类型检查通过（验证：`npm run typecheck`，退出码 0）
- [x] 生产构建通过（验证：`npm run build`，退出码 0）
- [x] 无新增运行时依赖，`orbitcode.workspaces.yaml`、`.env`、日志、截图、录屏与临时目录未被 Git 跟踪。（验证：`git diff -- package.json package-lock.json .gitignore` 与 `git status --short --ignored`）
- [x] 现有 Agent 异常路径未回归：工具失败、无效参数、命令超时、用户取消、最大迭代和连续未知工具均以既定结构与停止原因完成。（验证：`npm test -- src/core/agent-loop.test.ts src/core/tool-scheduler.test.ts src/tools/schema.test.ts src/tools/run-command.test.ts`）

## 端到端

- [x] 浏览器完整主路径：启动页面 → 选择 Workspace A → 切到 Plan → 让模型读取项目并澄清 → 得到计划 → 点击“按此计划执行” → Do 写入并读回 → 显示工具、Token、进度和最终停止原因。（验证：真实浏览器 + 用户未入库的真实模型配置）
- [x] Workspace 隔离路径：在 A 完成会话和写入后切换 B，确认页面重置为 Do，读取同名文件只得到 B 内容，在 B 中无法从历史、工具或命令访问 A。（验证：真实浏览器/tmux，同时检查两个临时目录）
- [x] 异常恢复路径：在 Catalog 加载后让当前 workspace 暂时不可用，发送时安全失败且不请求模型；修复配置/目录、重新加载后恢复发送。（验证：真实浏览器 Network、notice 和服务端请求记录）
- [x] 取消与竞态路径：在模型流和工具执行中分别点击停止，控件恢复后 workspace 不变，未完成回复不可执行，不存在残留工具子进程或第二个 Do 请求。（验证：真实浏览器、Network 和进程列表）
- [x] 结束验收后关闭开发服务、浏览器会话、tmux 会话与子进程，删除本轮安全临时 workspace；不删除用户配置或真实项目文件。（验证：进程列表、临时目录检查与 `git status --short`）

## 实际结果

验收结果：35 / 35 项通过。

- 自动化：`npm run test` 通过，共 130 项；`npm run lint`、`npm run typecheck`、`npm run build` 均以退出码 0 完成。最终安全补丁后补充了 `/dev/null`、npm、C++ 工具链、相对路径契约与失败参数展示回归，并再次完成全量检查。
- 架构：`src/core/` 未导入 React、Next.js、Workspace Catalog 或 Web 会话 reducer；`package.json`、`package-lock.json` 和 Agent Loop 公共接口无改动。浏览器只提交不透明 Workspace ID，服务端在每次聊天前重新解析并验证授权目录。
- Workspace：缺少配置时回退为单一启动目录；多 Workspace 配置、严格字段/数量/长度校验、未知或失效 ID、不安全路径、符号链接、敏感文件与跨 Workspace 访问均有自动化或浏览器证据。`orbitcode.workspaces.yaml` 已加入忽略和受保护路径，Catalog/API/错误提示不公开本地绝对路径。
- 浏览器：在 1440px 桌面和 390px 窄屏完成选择器、Plan/Do、禁用态、取消、计划执行和错误恢复检查，无 Next.js 错误覆盖层或控制台错误。Workspace 切换清空旧会话、草稿和计划并恢复 Do；Provider 切换和清空对话保留当前 Workspace。
- 真实模型：在临时 Beta Workspace 中，Plan 阶段只调用 `read_file` 并生成计划，未产生写入；点击“按此计划执行”后经普通 SSE、Agent Loop 和工具调度完成多轮读取、写入、命令及读回确认。最终 `result.txt` 与源文件逐字节一致，Alpha Workspace 未产生结果文件。
- 异常路径：验证当前 Workspace 暂时失效时在模型请求前安全失败，恢复目录并重新加载后可继续；取消后 Workspace 保持不变，未完成回复不进入成功历史或可执行计划；未知 Workspace 请求返回结构化 `workspace-unknown`。
- 清理：真实模型测试使用的 Alpha/Beta 临时 Workspace、临时授权配置、开发服务、浏览器会话和 tmux 会话均已清理；这些均为一次性测试资源，不涉及用户项目文件，也无需恢复。Git 工作区中没有测试日志、截图、录屏或临时目录。

剩余边界：本阶段采用服务端授权配置选择本地 Workspace，不实现浏览器任意目录选择器、完整权限系统、上下文压缩或交互式确认；这些与获批 Spec 的非目标一致。
