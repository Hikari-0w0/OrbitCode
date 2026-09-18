# CLI 与 Web 功能对齐 Checklist

状态：已批准
依据：[spec.md](spec.md) 已批准；[plan.md](plan.md)、[task.md](task.md) 已批准。

> 2026-09-18 已执行自动化、tmux 和浏览器验证；证据及未覆盖项见末节。

## 验证环境与证据规则

- 自动化测试使用独立临时 Workspace、会话/日志目录、合成 API 凭据和本机可控 SSE 服务。通过构造器注入测试目录；子进程测试入口显式传递测试目录，不改写 HOME 或用户配置。
- 命令测试在可用的现有沙箱环境下运行；平台不可用拒绝场景单独测试。没有沙箱的平台不得跳过后宣称命令执行验收通过。
- 下列路径已按实际测试落点更新；共享算法同时由既有 core/tools/Web 回归覆盖，未重复为每个入口创建相同单测。
- 每项证据记录：日期、命令/操作、退出码或实际状态、关键观察、日志/截图位置。记录不包含真实凭据，产物不加入 Git。
- `npm test` 全套验证仅执行一次；只有后续修改、失败修复或新增疑点才重复受影响检查。

## 需求验收

- [x] C01 / AC1 / F1：原 `--config`、`--provider`、`--help`、`export-run` 继续工作；默认配置可启动；无效参数、配置和缺失凭据不请求模型。（验证：`npx tsx --test src/cli/arguments.test.ts src/web/server-config.test.ts tests/cli.e2e.test.ts`）
- [x] C02 / AC1 / F1：切换两个 Provider 和两个授权 Workspace 产生独立 Do 会话；失败切换保留原绑定；`--resume` 与覆盖绑定参数冲突被拒绝，旧会话可恢复。（验证：`tests/cli-conversation.e2e.test.ts` 与 `tests/cli-conversation.e2e.test.ts`，使用 `npx tsx --test` 执行）
- [x] C03 / AC2 / F2：可控模型完成读文件→编辑→执行失败→修复→验证→最终回复，后续模型请求含真实工具结果；全部当前注册工具均有 CLI 接入覆盖。（验证：`npx tsx --test tests/cli-agent.e2e.test.ts tests/runtime-parity.e2e.test.ts`，核对 registry 清单与实际调用）
- [x] C04 / AC2 / F2：未知工具、畸形 JSON、无效参数和普通工具失败返回结构化结果；可恢复错误后能继续，连续失败由既有预算停止。（验证：`src/runtime/agent-runtime.test.ts`、`tests/cli-agent.e2e.test.ts`）
- [x] C05 / AC3 / F3：完整 `/plan`、`/do` 不调用模型；带正文的 `/plan` 为普通消息；Plan 伪造写入和命令被拒绝；有效计划明确执行后保留上下文并追加可见请求。（验证：`src/cli/commands.test.ts`、`src/core/conversations/plan-execution.test.ts`、`tests/cli-agent.e2e.test.ts`）
- [x] C06 / AC3 / F3：失败、取消、过期、跨 Workspace、后续轮次和历史恢复后的旧计划不能触发执行；模型输出的控制命令不起作用。（验证：计划规则与 session-controller 测试）
- [x] C07 / AC4 / F4：三种权限模式与四种审批决定覆盖；deny > ask > allow、目标变化重审和永久写入失败结果准确；放行模式不能绕过硬边界。（验证：`npx tsx --test src/web/permission-session-manager.test.ts src/tools/permission-gateway.test.ts tests/cli-permission.e2e.test.ts`）
- [x] C08 / AC4–AC5 / F4–F5：多审批按 ID 处理，不混用答案；取消、超时、会话切换后迟到答案无效；重启和 resume 不复用旧内存授权。（验证：权限端到端测试及终端 E02）
- [x] C09 / AC5 / F5：非 TTY ask 立即拒绝，不读取下一条业务输入作为批准；完整排队行串行处理，EOF/退出有界收尾；TTY 生成期间普通输入不误当审批。（验证：`src/cli/terminal-chat.test.ts`、`tests/cli-permission.e2e.test.ts`，终端 E02/E03）
- [x] C10 / AC6 / F6：流式文本、阶段、工具结果、Usage、停止、耗时、副作用和完成验证可读；长结果有完整查看入口，Usage 缺失不冒充 0 或估算；检查通过明确仅覆盖所列检查。（验证：`npx tsx --test src/cli/renderer.test.ts tests/cli-agent.e2e.test.ts`）
- [x] C11 / AC7 / F7：单结果与批次卸载、自动摘要、手动压缩、连续失败熔断及手动成功解除熔断均符合现有行为；展示估算来源与失败原因。（验证：`npx tsx --test tests/cli-context.e2e.test.ts tests/runtime-parity.e2e.test.ts`）
- [x] C12 / AC7 / F7：同会话跨入口读卸载引用成功，其他会话引用被拒绝，切换不误删旧上下文，清空/删除后引用按规则清理。（验证：上下文和会话端到端测试）
- [x] C13 / AC8 / F8：新建、列表、历史、重命名、继续、清空、删除全部可操作；模式重启后恢复，清空回 Do，破坏性确认绑定正确目标及 revision。（验证：`npx tsx --test tests/cli-conversation.e2e.test.ts tests/cli-conversation.e2e.test.ts`）
- [x] C14 / AC8 / F8：Provider/Workspace 配置不可用时仍可读取和导出历史，但执行被拒绝；会话及单轮导出不依赖有效模型配置，实际文件含完整目标数据。（验证：CLI 参数与会话端到端测试，核对文件 JSON）
- [x] C15 / AC9 / F9：Web→CLI→Web 继续同一会话，历史、模式、工具结果和上下文一致；两个 CLI 及 CLI/Web 独立进程竞争时不覆盖记录。（验证：`npx tsx --test tests/conversation-cross-process.e2e.test.ts tests/runtime-parity.e2e.test.ts` 与浏览器 E04）
- [x] C16 / AC9 / F9：保存失败明确未保存；retry-save 不请求模型、不重放工具，revision 冲突不覆盖；进程重启后没有内存 pending save，recover 只恢复磁盘证据并提示副作用。（验证：会话服务、跨进程测试及 E03）
- [x] C17 / AC10 / F10：最大迭代、最大时长、连续失败、模型错误、上下文错误/容量/熔断和取消分别给出准确原因；每轮唯一终止。（验证：`src/runtime/agent-runtime.test.ts`、`tests/cli-agent.e2e.test.ts`）
- [x] C18 / AC10 / F10：正常、失败、取消、审批等待、迭代器提前关闭及流断开均回收审批、受管进程与租约；一个清理步骤失败不阻止其余步骤。（验证：runtime 测试、跨入口测试及 E03，核对进程与端口）
- [x] C19 / AC11 / F11：CLI 运行可由现有本地日志与导出流程定位，source 正确，既有版本 3/4 的 Web 记录可读，缺失必要来源字段的损坏记录仍报错；模型阶段、工具、停止和持久化信息符合实际。（验证：`npx tsx --test src/lib/local-agent-run-log.test.ts src/lib/local-agent-run-exporter.test.ts tests/runtime-parity.e2e.test.ts`）
- [x] C20 / AC11 / F11：日志/导出写入失败有反馈；日志成功不能替代任务完成验证，日志失败不丢失已保存会话。（验证：AgentRunTracker、runtime 和 CLI 导出故障注入测试）

## 集成、架构与安全

- [x] C21 / AC12 / N1–N2：只有一套 Agent 运行编排和算法，core/runtime 无 Web 或 UI 反向依赖，未新增运行时依赖或 Agent SDK。（验证：审阅 diff、package-lock 与 `rg -n '@/web|@/app|@/components|from "react"|from "next' src/core src/runtime`）
- [x] C22 / AC4、AC12 / N3：路径穿越、符号链接、敏感配置、危险命令和沙箱不可用场景在两端均被拒绝；无直接 Shell 执行旁路。（验证：现有工具安全测试加 `tests/runtime-parity.e2e.test.ts`）
- [x] C23 / AC5、AC12 / N3：模型和工具跨 chunk ANSI/OSC、光标、标题/剪贴板等控制序列不能改变终端提示/审批；原始内容持久化和显示净化分离。（验证：`npx tsx --test src/cli/terminal-text.test.ts src/cli/renderer.test.ts` 与 tmux 可见观察）
- [x] C24 / AC11–AC12 / N4：合成秘密值不出现在参数、正常/异常 stdout、stderr、运行日志与导出中，未打印完整环境。（验证：测试 fixture 故障注入与产物扫描；仅证明被测路径，不宣称任意用户正文自动脱敏）
- [x] C25 / AC12 / N5：原 Web HTTP/SSE 形状、同源及大小检查、权限与会话 API 回归通过，旧 checkpoint/日志可读。（验证：现有 Web 端到端和 lib 测试）

## 项目检查

- [x] C26 / AC12：`npm test` 退出码 0，记录测试总数及跳过原因；跳过的平台场景不得算验收通过。
- [x] C27 / AC12：`npm run lint` 退出码 0。
- [x] C28 / AC12：`npm run typecheck` 退出码 0。
- [x] C29 / AC12：`npm run build` 退出码 0。
- [x] C30 / AC12：`git diff --check` 通过；README、AGENTS 和评估说明与实际能力一致，未包含凭据和测试产物。

## 端到端操作

以下为验收操作要求；实际执行方式及临时产物在末节单独记录。启动替身：`npx tsx tests/helpers/cli-parity-server.ts`，打印本机服务地址和场景选择方法，不打印凭据。为它准备未入库 YAML，使用合成环境变量，绑定临时 Workspace 和测试存储。

- [x] E01 / AC2、AC6、AC12：在新建 tmux 会话启动 `npm run cli -- --config <测试配置绝对路径>`；要求修改临时项目并运行验证，观察模型增量→工具→真实本地文件变化→验证输出→最终报告。检查文件内容及验证退出码；仅出现最终文本不算通过。
- [x] E02 / AC3–AC5、AC12：同一终端 Plan 分析后 `/execute-plan`，遇到写入审批先拒绝再在下一次请求允许；生成中输入匹配 request-id 的批准并观察执行继续，另一次用 Ctrl-C 取消。确认无需等待整轮结束就能响应审批，下一轮仍可输入。
- [x] E03 / AC5、AC9–AC10、AC12：替身分别返回无效参数、失败命令、超时命令和超过迭代上限的调用；另开进程执行长任务并强制中断，再启动 CLI 检查 `/recover`。观察每种停止原因、进程/端口回收、磁盘记录及没有自动重放。SIGKILL 后只要求可由恢复机制处理，不能声称执行了进程内 finally。
- [x] E04 / AC7–AC9、AC12：启动开发服务器，用 agent-browser 新建会话、Plan、审批并完成一轮；CLI resume 后继续、查看工具、压缩；浏览器重新加载后继续并核对 revision/历史/上下文。检查错误覆盖层和控制台错误，最后关闭浏览器与服务器。
- [x] E05 / AC12：在安全的未入库配置与凭据环境可用时，用真实 Provider 在 tmux 完成至少一轮读/改/验证及后续追问，单独记录真实模型结果。遵循项目“不在测试中使用真实密钥”的约束：自动测试始终使用合成凭据；真实服务验证若缺少项目允许的安全凭据注入方式则保持未验证，不将密钥写入命令、fixture、日志或录屏。替身结果不能替代此项。
- [x] E06 / AC12：完成后确认所有本次创建的 tmux 会话、浏览器、替身/开发服务器和受管进程均关闭，临时测试数据不污染用户会话库或 Git。

## 实际结果

日期：2026-09-18。**36/36 项通过，0 项未通过，0 项未执行（含下方修复后的 tertiary 单次补验）**。勾选项采用自动化与人工操作的组合证据，不代表所有异常都在终端手工重做。

| 检查项 | 实际证据与观察 |
| --- | --- |
| C01–C02 | CLI 参数、原 CLI e2e、Provider/Workspace 切换及失效配置测试通过；切换失败不替换原绑定。配置测试保留在 `src/web/server-config.test.ts`、`workspace-config.test.ts`，实际调用共享实现。 |
| C03–C06 | `tests/cli-agent.e2e.test.ts` 完成读、改、失败命令、修复和验证；结合 context 测试覆盖当前 12 个注册工具。Plan 硬拒绝写入、显式执行与共享资格规则测试通过；tmux 实际执行计划并按 ID 审批。 |
| C07–C09 | CLI 权限 e2e 覆盖四种审批、迟到答案、非 TTY 拒绝及取消；既有权限网关/管理器测试覆盖规则优先级、硬边界和失效授权。终端输入测试覆盖排队与 EOF；tmux 中生成期间可审批与取消。 |
| C10–C12 | renderer、CLI context 与现有上下文管理测试通过；大结果卸载、引用隔离、成功手动摘要均有实际断言。自动压缩、熔断沿用共享核心/Web 回归；浏览器手动压缩遇到无可替换历史时正确失败，历史保留。 |
| C13–C16 | CLI conversation、runtime service、跨入口和独立进程测试通过；实际导出 JSON、模式、revision 和模型调用次数有断言。浏览器旧 revision 请求返回 409，刷新后恢复；SIGKILL 恢复通过独立子进程测试验证，不宣称运行了被杀进程的 finally。 |
| C17–C18 | 核心停止条件及 runtime 提前关闭、清理/日志失败测试通过。tmux 实测 invalid-arguments、command-failed、timeout、max-iterations 和 Ctrl-C cancelled；之后仍可输入。 |
| C19–C20 | 日志/exporter、Web handler、runtime 故障测试及跨入口测试通过；CLI/Web source 正确，保存失败可重试且不重放模型或工具，清理/日志失败不吞掉唯一终止。 |
| C21–C22、C25 | 生产 core/runtime 无 UI 反向导入；package/package-lock 无改动。既有路径、符号链接、危险命令、沙箱、HTTP/SSE、会话兼容测试全部通过；CLI 复用同一注册工具和网关。 |
| C23 | `src/cli/terminal-text.test.ts` 与 renderer 测试通过。另在 tmux 中调用实际 TerminalText，分 chunk 输入清屏 CSI、OSC 标题和剪贴板序列；捕获显示原审批标记保留、正文完整、标题未变，输出无伪造标题或剪贴板正文。记录 `/tmp/orbitcode-parity-terminal-controls.txt`；探针会话已关闭。 |
| C24 | 合成凭据 fixture 测试通过，隔离会话/日志目录扫描未发现合成密钥。没有读取真实 Provider 密钥或打印完整环境；该结论仅覆盖被测路径。 |
| C26 | `npm test`：退出码 0；341 tests，341 pass，0 fail，0 skipped。日志 `/tmp/orbitcode-parity-tests-final.log`。此前 IPv6 日志竞态修复后重新执行全套。 |
| C27–C30 | `npm run lint`、`npm run typecheck`、`npm run build`、`git diff --check` 均退出码 0；构建日志 `/tmp/orbitcode-parity-build-final.log`。README、AGENTS、评估说明及四份规格同步更新。 |
| E01–E02 | tmux `orbitcode-parity` 通过测试 CLI 入口注入临时存储，实际写入 fixture.txt 并读回；Plan 执行先拒绝、下一次请求允许，Ctrl-C 后仍可继续。终端捕获 `/tmp/orbitcode-parity-terminal.txt`。命令失败→修复→验证的完整顺序另由 CLI e2e 覆盖。 |
| E03 | tmux 真实工具覆盖无效参数、失败命令、超时及迭代上限。强杀及重启恢复由 `tests/conversation-cross-process.e2e.test.ts` 的独立子进程覆盖，未用 tmux 强杀重复执行。 |
| E04 | agent-browser 在隔离副本 `http://localhost:3187` 完成 CLI 历史恢复、Plan、审批、写入及跨入口继续，检查 revision 冲突和刷新后的完整历史。截图 `/tmp/orbitcode-parity-web.png` 已观察，无错误覆盖层，浏览器无 JS 异常。使用默认 Turbopack；未将额外 webpack 启动尝试视为通过。 |
| E05 | tertiary 首次补验暴露完成报告重复失败；用户授权修复后，原场景重跑达到 verified 并正常 final-response，后续追问及保存也通过。前后证据分别保留在下方。 |
| E06 | 已关闭本次 agent-browser、tmux、3187 开发服务器与 53371 替身；存储位于隔离临时目录，不污染用户会话库，测试产物未入库。 |

隔离副本为 `/var/folders/86/0z5y9hyx0n19zgqbfxwd4fsr0000gn/T/orbitcode-parity-ui-w4lzaym3`，仅其测试入口注入 `.test-conversations` 和 `.test-logs`。真实 Provider 补验使用进程内加载已有环境配置的方式，不把凭据写入参数或测试文件。

### 真实 tertiary 补验（2026-09-18）

- 授权与环境：用户明确允许使用已配置的 tertiary；模型为 `deepseek-flash`。tmux `orbitcode-tertiary` 调用实际 `runCli`，通过临时入口注入隔离 Workspace、会话及日志目录；已有本地配置只在进程内加载，没有复制密钥。自动化测试仍使用合成凭据。未修改 Agent 行为或安全规则。
- 会话：`cfd3207c-2bcc-4664-80be-524e4c80682c`，Workspace `default`（指向临时 workspace）。初始 `sum.mjs` 在空数组上抛异常；测试含空数组与含负数数组两项断言。
- 第一轮 runId：`423ec07c-4608-4786-af41-629e1e2c6cfd`；UTC 05:33:27–05:34:51；9 次迭代，10 次工具调用，其中原测试失败 1 次、完成报告失败 5 次；耗时 83811 ms（含人工审批等待），模型报告累计 47144 tokens；停止 `repeated-tool-failure`，保存 revision 1。
- 实际执行：读取两个文件；首次 `node sum.test.mjs` 退出 1；单次批准 edit_file 后仅给 reduce 增加初值 0；再次单次批准同一命令，退出 0，stdout 为 `SUM_CHECKS_PASSED`。独立重跑同样通过，测试文件与初始内容逐字一致。
- 失败事实：模型把“复现原有失败”作为 passed 检查，引用失败命令证据，触发“通过项必须引用至少一个成功工具结果”。五次报告仍保留该引用，最终被重复失败预算停止；另有 passed 检查仅引用写入证据，按现有规则也不能替代验证。证据 ID 本身存在，不能把问题误判为证据丢失或空参数；展示时间线参数为安全摘要，实际调用取自 checkpoint.context.messages。
- 判断与改进方向：工具契约与“验证预期失败”这一检查表达存在适配问题，模型未能根据反馈恢复；反馈没有指出具体检查项，是否导致重复失败仍是待验证的原因假设。后续可先改进错误定位并用固定场景比较恢复率，不通过放宽成功证据规则来让测试通过。本次只诊断，未实施该行为改动。
- 后续追问 runId：`bab8774f-904b-4870-8f5b-64a857a4e78e`；UTC 05:35:31–05:35:33；1 次迭代、无工具调用、2914 ms、7394 tokens，正常 `final-response`，保存 revision 2。模型正确解释改动、测试结果及未通过结构化报告，未声称报告成功。
- 证据：临时目录 `/var/folders/86/0z5y9hyx0n19zgqbfxwd4fsr0000gn/T/orbitcode-tertiary-1xqht47w` 下的 `conversations`、`logs` 和实际 workspace 文件；终端捕获 `/tmp/orbitcode-tertiary-terminal.txt`。10 个产物扫描未匹配已配置 API Key；这些产物未入库。tmux/CLI 已退出，无测试服务残留。

首次补验时 E05 未勾选：真实模型工具闭环及后续追问正常，但原任务结构化收尾失败。该历史结论由下方修复后补验更新。

### 完成报告反馈修复与复验（2026-09-18）

用户明确授权修复后，仅修改共享完成报告的反馈与工具/系统提示：`CompletionTracker.accept` 按输入路径收集可独立确定的错误；`report_completion` 通过现有 `error.issues` 回传。反馈准确区分不存在的证据、失败证据、仅有写入证据及缺少写入后验证，并指导补充匹配验证。输入无效时不继续推导该检查项的语义错误，其他项仍独立检查。证据通过规则、权限、失败预算、重试上限均未放宽。

- 回归：新增 2 个 tracker 测试、1 个 CLI 端到端测试，确认一次反馈多个问题、混合成功/失败证据仍被拒绝、修正后可接受，以及真实模型协议中携带 `error.issues` 并正常结束。原有伪造证据、失败门禁、写入后验证及构建/Lint/HTTP 匹配测试保留。
- `npm test`：344/344 通过，0 失败、0 跳过；日志 `/tmp/orbitcode-completion-fix-tests.log`。首次全量检查发现旧压缩 fixture 紧贴固定提示容量上限；调整测试历史长度和测试窗口，继续覆盖“压缩前触发、压缩后可继续”，生产上下文配置未改。
- `npm run lint`、`npm run typecheck`、`npm run build`、`git diff --check` 均通过；构建日志 `/tmp/orbitcode-completion-fix-build.log`。未修改页面、未引入依赖、未提交或推送。
- tertiary 原场景：相同初始源码、测试和用户请求，新的隔离目录 `/var/folders/86/0z5y9hyx0n19zgqbfxwd4fsr0000gn/T/orbitcode-tertiary-fixed-q01gmece`，实际 tmux/CLI 默认权限并逐次批准原测试、文件编辑和重跑测试。
- 会话 `cacecda7-c25a-43bf-9e63-894a0434d3b1`；runId `57358e54-d3b1-45ca-9a46-5be085c8c83b`；UTC 05:49:58–05:51:52。8 次迭代、8 次工具调用，初始测试按预期失败 1 次、完成报告被拒绝 1 次；随后模型依据两项具体错误补读修改后的文件，重新提交报告成功，最终 `verified` + `final-response`，保存 revision 1。模型报告 42424 tokens；114368 ms 含审批等待，不用墙钟时间推导模型提速。
- 独立验证：`node sum.test.mjs` 退出 0、输出 `SUM_CHECKS_PASSED`；测试文件与初态逐字一致，实际仅 sum.mjs 增加 reduce 初值。历史失败在最终回复中明确说明。
- 后续追问 runId `75aaa85b-026f-4ba0-858d-9fd1bf94e2da`，正常 `final-response` 并保存 revision 2；该解释轮未执行工具，其本轮 verification 为 unverified，未继承上一轮的 verified。
- 终端捕获 `/tmp/orbitcode-tertiary-fixed-terminal.txt`；10 个产物扫描未匹配已配置 API Key；tmux/CLI 已退出，临时产物未入库。

修复前同场景完成报告失败 5 次并停止，修复后失败 1 次后成功恢复。这是一次真实复验的观察结果，不代表已统计所有模型或任务的稳定成功率。
