# OrbitCode

OrbitCode 是一个使用 TypeScript 自主实现的编程智能体。Web 入口已支持 OpenAI 兼容 Tool Calling 与自主 Agent Loop：模型可以连续调用本地工具、读取结构化结果并调整下一步行动，直到给出最终回复或触发安全停止条件。

Web 与 CLI 共用本地 Agent 运行时：工具执行、权限、Plan/Do、上下文管理、会话持久化和完成验证保持相同核心语义。CLI 可独立启动，无需先运行 Web 服务。

使用入口：[首次配置](#配置) · [CLI](#cli-编程智能体) · [开发检查](#开发与验证) · [文档目录](docs/README.md)

## 核心架构

- `src/core/`：Agent Loop、会话、上下文管理、终止条件与完成验证
- `src/app/`：Next.js 页面、路由与 API 入口
- `src/mcp/`：MCP JSON-RPC、传输与协议客户端
- `src/models/`：模型请求、SSE 解析与 Tool Calling 适配
- `src/tools/`：工具定义、参数校验、权限边界与本地执行
- `src/runtime/`：两端共用的配置、Agent 编排、会话操作与运行记录
- `src/web/`：HTTP/SSE 适配与 Web 实例组合
- `src/cli/`：终端输入、会话命令与文本展示
- `src/components/`：界面展示与交互，不承载 Agent 核心逻辑

## Web 工作台

左侧会话列表支持搜索、新建、切换、重命名和删除；右上角会话菜单提供清空和完整导出。页面面向桌面浏览器，会话侧栏固定显示，不再维护手机专用布局。顶部工作环境可切换模型和工作区；输入区按内容自动增高，保留规划/执行和停止；上下文压缩可从工具栏“上下文”展开，最新计划仍可直接执行。

Skills、背景与记忆、历史清理在独立管理面板中操作。设置分为模型、工作区、MCP、运行偏好、配置恢复和外观；支持浅色、深色及跟随系统。按会话保存本标签页草稿，编辑设置或记忆时提供未保存保护。消息支持受限 Markdown、代码复制和原文查看，工具结果及完成验证信息单独展示，历史审批记录只读保留。

本轮实现及验收边界见 [UI 重构验收清单](docs/specs/ui-interaction-redesign/checklist.md)。

## 仓库知识检索

可为工作区配置独立 Embedding 服务，手动构建 Markdown、TypeScript/TSX 与测试索引。Agent 通过只读 `search_knowledge` 按需混合检索并返回来源，修改前继续读取当前文件；Web/CLI 共享配置、权限和索引。文件变化时过滤旧正文，服务不可用时显式降级为关键词检索。

使用说明见 [仓库知识检索](docs/specs/repository-rag/README.md)，实际验证与限制见 [RAG 真实模型评估记录](docs/evals/repository-rag-real-model-2026-10-25.md)。

## 配置

环境要求：Node.js 20.9 或更高版本。

```bash
npm ci
npm run dev
```

打开 [http://localhost:3000/settings](http://localhost:3000/settings)，添加 OpenAI 兼容模型和本机工作区，然后返回对话。模型密钥可选择在本机私密设置中保存，或引用环境变量；MCP Server 也可在设置页添加、停用、连接并查看发现的工具。保存 MCP 配置本身不会启动子进程或发送网络请求。托管设置存放在 `~/.orbitcode/settings-v1.json`，仅本机服务的设置接口可读写；已有对话从下一轮开始使用新配置。

已有 YAML 配置的用户可在设置页预览并确认导入，原文件保持不变。以下是仍受支持的旧配置方式；显式 `--config` 继续使用指定的旧模型文件。

在本地 `.env` 中填写真实 API Key。旧 YAML 只保存环境变量名称：

```dotenv
MODEL_API_KEY=your-local-api-key
```

```yaml
providers:
  - name: primary
    protocol: openai
    model: your-model
    base_url: https://api.openai.com/v1
    api_key: MODEL_API_KEY
    # 官方 DeepSeek API 关闭思考模式时取消注释：
    # thinking:
    #   enabled: false
    #   api_style: deepseek
    context:
      # 必须按模型实际能力填写；128000 只是示例。
      window_tokens: 128000
      single_tool_result_tokens: 8000
      tool_result_group_tokens: 12000
      recent_messages_tokens: 10000
      automatic_reserve_tokens: 13000
      manual_reserve_tokens: 3000
      preview_chars: 2000
```

`.env` 和 `orbitcode.yaml` 均不会被 Git 跟踪。非隔离运行会加载当前工作目录的 `.env`，但不会覆盖进程中已经导出的同名变量。使用 `--data-dir` 的 CLI 评测不会自动加载该文件。

`thinking` 为可选配置。为兼容既有配置，省略 `api_style` 时使用 SiliconFlow 的 `enable_thinking` 参数；连接 DeepSeek 官方 API 时必须设置 `api_style: deepseek`，此时 OrbitCode 会发送官方的 `thinking.type` 参数，且不接受仅由 SiliconFlow 支持的 `budget_tokens`。

旧版 YAML 可在模型条目中添加 `max_tokens: 32768`，显式设置单次输出预算；省略时维持服务商默认值。该值不同于 `context.window_tokens`，须按服务商实际输出上限设置，OrbitCode 本地接受 1 到 1048576 且不超过配置上下文窗口的整数，不会绕过服务商限制。导入托管设置、编辑模型及建立运行快照时会保留此字段，设置页可编辑最大输出预算；留空使用服务商默认值，也可选择思考模式、参数格式及适用的思考预算。遇到非成功结束原因时，错误记录区分 `length`、`content_filter`、`insufficient_system_resource` 和 `aborted`；截断的工具参数不会执行。

## Web 流式对话

```bash
npm run dev
```

浏览器访问 [http://localhost:3000](http://localhost:3000)。首次使用可从侧栏进入“设置”，添加模型和工作区。尚未创建托管设置时，旧版 `orbitcode.yaml` 与 `orbitcode.workspaces.yaml` 仍可使用；托管设置建立后以托管资源为准。

### 选择本地 Workspace

需要管理多个本地项目时，在设置页添加目录。旧版文件配置仍可使用：

```bash
cp orbitcode.workspaces.example.yaml orbitcode.workspaces.yaml
```

```yaml
default: orbitcode
workspaces:
  - id: orbitcode
    name: OrbitCode
    path: /absolute/path/to/OrbitCode
  - id: my-app
    name: My App
    path: /absolute/path/to/my-app
```

`id` 是浏览器与服务端之间传递的不透明标识，`name` 用于页面展示，`path` 只在服务端解析。页面不接受任意绝对路径，也不会把完整目录发送给模型。修改配置后点击页面错误提示中的“重新加载”即可刷新。

切换 Workspace 会创建一个绑定到新目录的 Do Mode 对话，旧对话及其记录保持可用，从而避免跨项目混用上下文。生成期间 Workspace 选择器会禁用。所有文件与命令工具仍经过路径、符号链接、敏感文件和命令沙箱校验，选择 Workspace 不会放宽这些边界。

页面支持：

- OpenAI 兼容模型的 SSE 增量回复
- ReAct 风格的多迭代 Agent Loop，以及一次响应中的多个工具调用
- 读取、写入和唯一原文替换文件
- 按受限 Glob 查找文件，以及按字面量搜索代码
- 在 macOS Seatbelt 文件沙箱中执行命令，并支持联网安装项目依赖
- 启动、查看和停止本轮临时进程；拒绝启动前已被占用的目标端口，支持 IPv4/IPv6 loopback 连通探测
- 只读工具分批并发，写文件、修改文件和命令工具按原调用边界串行执行
- 展示模型文本、迭代进度、工具排队/执行/结果、累计 Token 用量与最终停止原因
- 基于真实工具证据汇总完成状态，并展示 Agent 总运行时间和验证结果
- 可跨刷新和服务重启恢复的本地多对话历史
- 大工具结果本地卸载、`read_context` 按引用重读与结构化历史摘要
- 手动上下文压缩、压缩前后 Token 估算、失败状态与三次失败熔断
- 多 Provider 选择（切换时创建新绑定对话，旧记录保留）
- 多个服务端授权的本地 Workspace 选择（切换时创建隔离的新对话）
- 停止生成、失败后继续和清空会话
- `/plan` 只读分析模式与 `/do` 完整执行模式
- 主Agent、子任务和独立Skill自主执行，显式拒绝与工作区边界继续生效
- 工具调用按规则直接允许或拒绝，并返回结构化错误
- 面向桌面浏览器的工作台布局

Web 会话保存在当前用户目录的 `~/.orbitcode/conversations-v1`，页面刷新、切换对话或服务重启后可继续。浏览器只提交本轮用户输入、稳定会话 ID 和期望 revision，不提交或决定模型历史；服务端保存完整的用户、助手、工具调用和工具结果 transcript，并用 revision 冲突保护避免旧页面覆盖新记录。模型生成最终文本以及用户取消、错误、达到最大迭代次数等中断情况都会提交本轮上下文；异常退出时恢复最近完整检查点并写入结构化中断标记。

运行时被动记录工具结果、失败与副作用，不要求模型提交完成报告。普通任务的 `unverified` 表示未自动判定整项任务验收；历史会话中的“所列检查通过”仅覆盖当时列出的检查，最终回复和工具调用成功均不能替代独立验收。子任务可通过 `agent verify` 验证预先声明的文件契约，范围见下文。

`start_process` 创建的服务仅用于本轮验证，完成、取消或失败后会回收，不能作为回复后持续可用的预览服务。端口探测只记录 TCP 连通性，不验证 HTTP 内容或监听者归属；启动前占用检查也不消除检查后其他进程抢占端口的竞态。模型应根据工具结果选择适合任务的后续验证。

### 上下文管理

上下文使用“轻量预防 + 重量兜底”两层策略，并优先压缩体积最大的工具结果：

- 每次普通模型调用前，超过 `single_tool_result_tokens` 的单个工具结果会保存到对应会话的本地 context 目录。模型历史只保留有界预览、原始体积和 `context://v1/...` 引用；完整内容不会进入 Git。
- 同一次工具调用批次超过 `tool_result_group_tokens` 时，结果按估算体积从大到小继续卸载。模型可在 Plan 或 Do 模式使用只读 `read_context` 分块取回当前会话的引用；它不能读取文件路径、其他会话引用，也不改变 Workspace 权限。已知文本可用 `read_context` 的可选 `query` 搜索整个引用（区分大小写的字面量，offset=0），返回完整扫描范围、精确匹配数和最多4段摘录；省略摘录不等于未扫描。普通分页仍支持定位阅读，读到末页不证明此前区间已覆盖，无匹配也只证明该字面量不存在。
- 整体历史达到 `window_tokens - automatic_reserve_tokens` 时，OrbitCode 使用同一 OpenAI 兼容 Provider 生成固定七节摘要。摘要调用由核心强制使用 `toolChoice: none` 且不提供工具；较早用户消息保持原文，近期约 `recent_messages_tokens` 且至少 5 条原始消息逐字保留。
- 自动压缩默认预留 13K Token；页面“压缩上下文”使用默认 3K 余量以获得更高压缩率。成功后页面显示压缩前后估算及估算来源；失败显示安全原因。摘要连续失败三次会停止自动重试，用户仍可手动压缩，成功后解除熔断。

`window_tokens` 是每个 Provider 的必填配置，OrbitCode 不会根据模型名称猜测。其他上下文字段可省略并使用 `orbitcode.example.yaml` 中的默认值；所有阈值均按 Provider 独立解析。Token 估算不使用精确 tokenizer：有普通模型 API usage 时，以最近一次 prompt usage 为锚点，只近似计算后续增量；没有 usage 时标注为字符近似。

重量压缩后的摘要只恢复任务脉络，不被视为代码事实。模型需要具体文件内容时必须重新调用 `read_file`，需要已卸载工具输出时必须调用 `read_context`，不能从摘要猜测实现细节。切换 Provider 或 Workspace 不删除旧对话；只有清空或删除对应对话时才清理其上下文引用。

Agent Loop 默认最多执行 8 次模型迭代；可配置为 1–32，或使用 `unlimited` 取消迭代轮数上限。无限迭代仍受单轮运行时长保护，默认 60 分钟，可配置为 1–1440 分钟：

设置页“运行偏好”可勾选“不限制主 Agent 模型轮数”，保存到用户级设置后从下一轮生效；也可取消勾选恢复有限轮数。已保存的运行偏好优先于下面的环境变量。不限迭代仍受任务组请求预算、总运行时限、取消及错误终止条件约束；子任务仍受自身预算和角色上限约束。

```dotenv
ORBITCODE_MAX_AGENT_ITERATIONS=unlimited
ORBITCODE_MAX_AGENT_RUNTIME_MINUTES=60
```

停止原因还包括上下文压缩失败、上下文容量不足和自动压缩熔断。`stopped` 始终是事件流中的唯一终止事件，页面会保留未完成轮次的部分文本与工具记录供检查。

OpenAI 兼容服务若报告 Token Usage，页面会显示本次及累计的输入、输出和总 Token；若任一迭代未报告 Usage，累计值会明确显示为“模型未报告”，不会用估算值冒充精确值。

### Plan Mode 与 Do Mode

页面输入区提供持续可见的 Plan/Do 切换，也继续支持在输入框中单独发送 `/plan` 或 `/do`。模式切换只改变当前页面状态，不会请求模型；Plan 后续请求由服务端限制为读取文件、搜索、上下文/记忆读取、Skill 加载/资源读取及受限的 `agent` 任务控制；具体列表随当前可用能力收窄，子任务继续继承 Plan 约束。即使模型伪造写入或命令调用也会被拒绝。

Plan 模式中的需求澄清使用普通多轮对话。最新一条成功 Plan 回复会显示“按此计划执行”；只有用户点击后，页面才会保留当前 Workspace 与已有计划上下文、切换到 Do，并追加一条可见的执行请求。失败、取消、旧回复或 Workspace 切换后的计划不可执行；模型文本也不能自动触发模式切换或副作用。

只有严格独立的 `/plan` 和 `/do` 会切换模式，`/plan 请分析这个任务` 会作为普通用户消息发送。切换 Provider 会创建新的 Do Mode 对话；清空会话会恢复 Do Mode，刷新页面则恢复已保存模式。

文件和命令工具只接受当前选定 Workspace 内的相对路径，拒绝路径穿越、符号链接和敏感配置文件。`run_command` 默认可以联网，因此 Agent 能直接执行 `npm install` 等开发命令；命令仍需通过工具能力和拒绝规则检查，并会过滤服务端环境变量、阻止访问 Workspace 外的用户数据。macOS 使用 Seatbelt，Linux 使用 bubblewrap；可选禁网与只读工具链配置见[跨平台命令沙箱](docs/command-sandbox.md)。当前平台无法通过沙箱能力探测时，命令工具直接返回不可用，不会降级为普通子进程。

### 工具权限与自主执行

Web、CLI、主 Agent、子 Agent、独立 Skill 和 MCP 共用自主执行策略：操作通过检查后直接执行，不再等待人工审批。Plan/Do、危险命令黑名单、Workspace 真实路径边界、角色/Skill工具能力和显式拒绝规则继续生效；执行前仍复检参数指纹、目标和当前规则。

权限规则使用 `工具名(模式)` 作为 YAML 键，值使用 `allow` 或 `deny`。三个固定位置分别为用户级 `~/.orbitcode/permissions.yaml`、项目级 `<Workspace>/.orbitcode/permissions.yaml`、本地级 `<Workspace>/.orbitcode/permissions.local.yaml`，任一匹配的deny均优先于allow；配置损坏失败关闭。文件工具和命令沙箱不能改写受保护的权限配置。

```bash
mkdir -p .orbitcode
cp orbitcode.permissions.example.yaml .orbitcode/permissions.yaml
```

没有未转义 `*`、`?` 的模式是完整精确匹配；路径Glob的 `*` 匹配单层，`**` 匹配多层；命令Glob的 `*` 可跨空格。没有匹配拒绝规则时默认允许。旧 `ask` 规则兼容为允许，旧strict/default/permissive模式保留可读但不再改变执行或触发人工确认，不自动改写用户配置。

界面不再提供审批模式和批准按钮；旧 `/approve`、`/task approve` 命令不能授予权限，旧决定HTTP接口返回410。历史事件和会话格式仍可读取，历史授权卡仅展示安全摘要。运行中的取消、时限、清理和会话绑定仍生效。这里的自主执行不代表模型回复已通过任务验收。

### MCP 外部工具

Web 与 CLI 通过 `src/runtime/` 共用 MCP 工具接入。独立的 `src/mcp/` 实现 JSON-RPC、stdio 和 Streamable HTTP，当前协议版本为 `2025-11-25`。未引入 MCP SDK、Agent 框架或新的运行时依赖。

在 `~/.orbitcode/mcp.yaml` 或 `<Workspace>/.orbitcode/mcp.yaml` 声明 Server；参考 [配置示例](.orbitcode/mcp.example.yaml)：

```yaml
mcpServers:
  local-demo:
    type: stdio
    command: node
    args: [./your-mcp-server.mjs]
    env:
      DEMO_TOKEN: ${DEMO_TOKEN}
  remote-demo:
    type: http
    url: https://example.com/mcp
    headers:
      Authorization: Bearer ${DEMO_TOKEN}
```

两层按 Server 名合并，同名时项目级完整覆盖用户级，包含 args、env 和 headers。只在 env、headers 中展开 `${VAR}`；变量缺失会禁用对应 Server，空值保留、不递归展开。stdio 的工作目录为所选 Workspace，直接启动 command，不经过 Shell；只继承 PATH、HOME、TMPDIR、LANG、LC_ALL，其余变量必须显式提供。项目根配置损坏会禁用该工作区的 MCP；单个 Server 错误不影响其余 Server 和本地工具。

读取配置不会立即启动进程或联网。Do回合对已启用MCP按规则检查连接和调用，通过后直接执行，不再人工审批；显式deny和配置复检仍生效。Plan不连接、刷新或暴露MCP工具。外部 Server **不受本地文件沙箱保证**，上述本地路径边界和命令黑名单不能约束它的内部行为；OrbitCode 控制的是连接及调用授权。

规则使用 `mcp_connect(目标)`、`mcp_call(目标)`，与模型可见的 `mcp__…` 命名分开。规范目标绑定Server／配置摘要，调用还绑定原工具名、定义和参数摘要；配置或参数变化后须重新检查，显式deny始终优先。

工具使用 Server 命名空间与摘要避免重名，执行前验证并冻结参数。支持受限 JSON Schema 2020-12：基本类型、enum/const、对象属性与必填项、additionalProperties、数组 items/数量/唯一性、Unicode 字符串长度、数值上下界、allOf/anyOf/oneOf/not，以及 `$defs` 中无环的本地 `$ref`。根 Schema 必须为 object；pattern、format、远程或循环引用、条件约束及未知关键字会拒绝注册，不做类型转换、补默认值或删除属性。未支持的输出 Schema 会标注为未验证。

文本和结构化结果进入现有上下文卸载、会话与运行记录流程；模型视图会在确认两者完全重复时只保留一份，持久化结果仍保留脱敏后的两种表示。媒体仅保留占位，不自动读取资源链接。已知配置秘密会在描述、审批摘要和结果中脱敏，HTTP 会话头与子进程 stderr 不展示。凭据应通过环境变量或未入库本地配置提供，不要放入命令参数；本仓库已忽略 `.orbitcode/mcp.yaml`，其他项目需自行加入忽略规则。

连接按进程内 Workspace／有效配置缓存，跨回合复用但不共享会话授权；配置改变会淘汰旧连接。工具列表分页完整完成后才注册，列表变化通知在下一个获准 Do 回合刷新。失败连接不自动重连或重试；修改配置或重启应用后可重新建立。正常退出和信号退出释放连接，stdio 以进程组有界终止。硬限额包括 32 个 Server、单 Server 128 个工具／32 页、工作区 256 个工具／512 KiB 定义、单消息 2 MiB、Schema 64 KiB、32 个在途请求和 128 个缓存连接；MCP 调用最长 60 秒且受回合总时限约束。

本阶段只接入工具，不提供资源发现、提示词、采样、tasks、健康检查或自动重连。外部工具成功不自动成为本地任务验收证据。当本轮工具仅包含外部调用和可选的 `read_context` 时，运行时以 `observed` 记录最多 20 项外部调用结果（含成功与失败），范围为 `external-call`；此范围不证明外部副作用、答复正确性或本地变更。

## CLI 编程智能体

```bash
npm run cli
npm run cli -- --config orbitcode.yaml --provider primary --workspace my-app
npm run cli -- --resume <conversation-id>
npm run cli -- export-conversation <conversation-id> --output conversation.json
npm run cli -- export-run <run-id> --output run.json
```

存在多个 Provider 时通过 `--provider` 明确选择。默认优先读取设置页保存的托管资源；未创建托管设置时读取启动目录的旧配置和 `.env`。显式 `--config` 使用旧模型文件。交互 CLI 的 `--data-dir` 使用独立托管设置、会话、日志与用户级权限，且不自动加载日常 `.env`。`--resume` 恢复原绑定，不能同时指定 Provider 或 Workspace 覆盖参数。两端使用相同配置根和配置标识时，可先后继续 `~/.orbitcode/conversations-v1` 中同一会话；并发写入由写租约和 revision 保护。

单次非交互运行可使用 `npm run cli -- run --prompt-file task.txt --output-format json`，或以 `--stdin` 接收多行输入；进程等待模型与持久化结束后输出结果。JSONL 模式按序输出事件及唯一终态。默认直接执行，无人工审批阻塞；可在显式 `--data-dir` 下使用 `--policy-file` 限制本次隔离策略。显式deny以结构化工具失败返回模型，不能仅凭completed判断任务成功。旧JSON的approvalBlocked字段兼容保留为false。运行结果的 `completed` 只表示 Agent 正常结束，任务正确性仍须独立验收。完整用法见 [Agent 评测用法](docs/evals/agent-evaluation.md)。

| 终端操作 | 命令 |
| --- | --- |
| 帮助、状态、取消、退出 | `/help`、`/status`、`/cancel`、`/exit` |
| 模型与项目 | `/providers`、`/provider <name>`、`/workspaces`、`/workspace <id>` |
| 规划与执行 | `/plan`、`/do`、`/execute-plan` |
| 会话 | `/new`、`/conversations`、`/resume <id>`、`/history`、`/rename <title>` |
| 清空、删除 | `/clear`、`/delete <id>`，再用提示中的 `/confirm <token>` 确认 |
| 上下文与恢复 | `/compress`、`/retry-save`、`/recover` |
| 工具详情与导出 | `/tool <call-id>`、`/export <path>` |

生成期间仍能取消；Ctrl-C取消当前操作，空闲时退出。管线输入逐行执行，允许范围内的工具直接执行。只有独立 `/plan` 和 `/do` 切换模式；`//` 可发送以 `/` 开头的普通消息。文本输出会过滤终端控制序列，长工具结果可通过 `/tool` 查看。

`/retry-save` 只重试当前进程持有的未保存结果，不重新运行模型或工具。重启后 `/recover` 恢复已有磁盘检查点和中断标记，不能回滚文件或自动重放命令。切换 Provider/Workspace 会新建 Do 会话。命令工具仍要求现有严格沙箱可用，不支持时明确拒绝。

导出文件可能包含完整对话与代码，拒绝覆盖已有路径。未保存状态下 `/export` 导出进程内检查点以便人工保留，格式为 `orbitcode-unsaved-checkpoint`，不等同于已保存的完整会话导出。

## 可用命令

```bash
npm run dev       # 启动开发服务器
npm run cli       # 使用托管设置或旧版配置启动命令行 Agent
npm run eval:agent -- --help # 查看真实模型评测的显式预算参数
npm run test      # 运行仓库自动化测试；不调用真实模型
npm run build     # 生成生产构建
npm run start     # 启动生产服务器
npm run lint      # 运行 ESLint
npm run typecheck # 运行 TypeScript 类型检查
npm run check     # 依次执行 lint、类型检查和生产构建
```

## 环境变量

可在设置页选择本机私密存储或环境变量作为模型凭据；旧版文件方式可复制 `.env.example` 为 `.env`。任何 API Key 都不得提交到 Git、写入公开配置、作为命令行参数传递或发送到浏览器。`ORBITCODE_MAX_AGENT_ITERATIONS` 和 `ORBITCODE_MAX_AGENT_RUNTIME_MINUTES` 同时影响 Web 与 CLI Agent Loop；托管设置中的同类上限优先。

## 开发与验证

依赖按 `package-lock.json` 安装。提交前执行：

```bash
npm test
npm run check
```

`npm test` 自动收集 `src/`、`tests/` 下的 `.test.ts` 和 `.test.tsx`，不收集 `tmp/` 中的评测项目。定向检查可使用 `npm test -- src/core/agent-loop.test.ts`；`npm run check` 依次执行 lint、类型检查和生产构建，不包含测试。涉及页面还需启动服务检查实际浏览器、错误覆盖层和控制台。

本地生产运行先执行 `npm run build`，再执行 `npm run start`。Web 默认仅监听 `127.0.0.1`，开发入口为本机使用设计；Linux 命令执行需安装 bubblewrap 并允许所需 namespace，Docker 默认策略可能阻止隔离初始化，运行条件和专项测试见[命令沙箱文档](docs/command-sandbox.md)。探测不通过时返回不可用，不会降级。不要将本地工作台直接作为公网服务。

真实模型评测需另外配置模型并明确选择场景和预算，见 [评测用法](docs/evals/agent-evaluation.md)。自动化测试通过不代表真实模型完成任意任务的效果或性能已验证。

## 本地数据与维护

用户级配置、会话、上下文、运行日志及记忆默认保存在 `~/.orbitcode/`；项目记忆保存在 Workspace 的 `.orbitcode/memory-v1/`，已加入本仓库忽略规则。Web 可用 `ORBITCODE_DATA_DIR`、CLI 可用 `--data-dir` 隔离用户级数据；项目级资料仍取自绑定的 Workspace。

备份前先结束运行并关闭服务，再保管完整用户数据目录及需要的项目级资料。备份与导出可能含凭据、对话和源码，不应提交到仓库。不要以删除数据目录作为日常清理方式；过期会话使用界面或 CLI 先预览、确认后删除。

文档入口见 [文档目录](docs/README.md)，运行取证见 [运行评估工作流](docs/evals/README.md)。历史规格和评测数字保留当时的证据边界，不能当作当前测试结果。

## 项目背景与长期记忆

每轮模型运行前加载会话绑定 Workspace 根目录的 `AGENTS.md`、项目 `.orbitcode/instructions.md` 与用户 `~/.orbitcode/instructions.md`。当前用户明确要求优先于文件约定；项目 instructions 优先于根 AGENTS，再优先于用户 instructions，全部服从系统安全、模式与真实工具权限。修改从下一轮生效，查看背景不会请求模型。

指令文件可写独立行 `@include <相对路径>`，相对于引用文件解析。根 AGENTS 的边界是 Workspace；项目 instructions 的边界是项目 `.orbitcode`；用户 instructions 的边界是用户配置目录。最多 5 层、每根 32 个唯一文件、每文件 16,000 UTF-8 字节，三来源累计展开文本最多 48,000 字节。重复/循环引用跳过并提示；绝对路径、URL、越界链接、受保护凭据/记忆配置及其他加载失败会阻止本轮，缺失根文件则视为无约定。

正常生成最终文本且会话保存成功后，后台以该轮模型提取笔记，不使用工具。取消、整轮错误及运行上限不触发；正常回复首次保存失败后，重试保存成功可触发一次。任务最多单并发、8 个等待项、30 秒，无自动重试；后台失败不影响已保存对话。当前回复只能确认理解要求，不能提前确认记忆已写入；实际结果查看后台任务状态。仅查询旧记忆且没有新增记忆要求的轮次不再请求提取模型。关闭进程会取消未完成提取，不保证跨重启必达，也不为旧会话批量补提取。

笔记分为用户偏好、纠正反馈、项目知识和参考资料。用户级仅保存明确跨项目的偏好；其余默认项目级。每条笔记采用带 frontmatter 的 Markdown，标注作用域、来源和证据性质。用户级资料位于用户配置根的 `memory-v1`，项目级位于 `.orbitcode/memory-v1`，状态位于用户配置根的 `memory-state-v1`。`HEAD.json` 指向完整版本目录，其中有 `index.md` 与 `notes/<id>.md`；旧版本保留以便检查冲突。每级索引最多 200 行且不超过 25,000 字节，容量不足不删除旧笔记。

Agent 请求携带当前用户/项目索引，记忆只作为可被纠正的背景。存在有效索引时才提供 `read_memory`，正文经本轮不透明引用按需读取；普通文件与命令工具不能直接操作记忆存储。索引及正文均参与现有上下文预算，必要时执行既有压缩。笔记事实不是当前代码验收证据。

Web 侧栏“项目背景与长期记忆”可检查来源、任务结果、关闭自动提取、查看/编辑/删除 Markdown。CLI 支持 `/background`、`/memory [user|project] list`、`show <id>`、`update <id> <file>`、`delete <id>` 和 `/memory on|off`；作用域默认项目级。直接修改当前版本的 Markdown 会在下次加载时重新校验并登记，冲突内容保留；不要手写索引引用。关闭自动提取不删除或停止加载已有记忆。

恢复仍使用原有会话绑定、修订及 `/recover`：完整检查点内唯一缺结果的调用会标为“执行结果未知”，不重放工具或回滚文件。上次保存轮次距今至少 24 小时时，请求中提醒外部状态可能变化；旧记录缺少可信轮次时间时显示未知，重命名不重置提醒依据。

侧栏“检查过期会话（30 天）”及 CLI `/cleanup preview` 只预览。按最近持久化更新时间至少 30 × 24 小时计算；明确选定并确认后才删除，CLI 使用 `/cleanup delete <id...>` 与 `/confirm <token>`。执行时重新检查修订、期限及运行/待保存/待恢复状态，逐条报告结果；工作区、指令、已存笔记和独立运行日志保留。启动时不删除会话。

显式 `--data-dir` 或 Web `ORBITCODE_DATA_DIR` 同时隔离用户级指令、笔记和后台状态，不读取日常用户级配置；项目级资料仍来自明确绑定的 Workspace。本功能没有向量检索、RAG、团队同步或会话格式迁移。

## 可复用 Skills

Skill 是 YAML frontmatter 加 Markdown 操作指令。Web 的 Skills 面板和 CLI 使用相同运行层；初始模型提示只给名称与简介，模型需要时调用 `load_skill`。用户也可显式调用：

```text
/skills
/skills refresh
/skill run review src/runtime
/skill deactivate review
```

`/skill <名称> [参数]` 是简写；与 `run`、`deactivate` 控制词同名时使用 `/skill run <名称>`。已有控制命令和 `//` 转义保持原义。列表和刷新不调用模型。CLI 单次执行支持 Skill 调用；管理命令使用交互 CLI 或 Web 面板。

按项目级 `.orbitcode/skills/`、用户配置根下 `skills/`、应用内置 `skills/` 的顺序选择同名定义。用户配置根默认 `~/.orbitcode`，使用隔离数据目录时随之隔离。根目录中的 `*.md` 是单文件 Skill，一级子目录的 `SKILL.md` 是目录型入口；模板和参考目录不会被递归识别为新 Skill。同层重名报错，高优先级已知名称的错误定义不会偷偷回退到内置版本。

```markdown
---
name: inspect-project
description: 读取指定文件并按项目约定给出检查建议
allowed-tools: [read_file, find_files, search_code, read_skill_resource]
mode: shared
---
读取 {{arguments}}，遵守项目规则。需要模板时用 read_skill_resource 读取 examples/report.md。
```

必填字段为 `name`、`description`、`allowed-tools`、`mode`；名称是小写字母开头的字母/数字/连字符，最多 64 字符。白名单是精确工具名数组，不支持通配符，空数组只保留系统加载工具。元信息拒绝未知字段、重复键、YAML 别名/锚点。单个坏文件不阻断其他有效名称，来源不可读或扫描超限会明确阻止使用不完整目录。

`{{arguments}}` 替换完整参数，`{{arg:1}}` 等引用从 1 开始的位置参数。引号保留含空格参数，缺参报错；`\{{arguments}}` 输出字面占位符。替换是单遍纯文本操作，不执行 Shell 或模板代码。

共享模式沿用主会话模型和上下文，激活内容在后续请求中持续保留，保存/恢复后仍生效；多个 Skill 的白名单取交集。`load_skill` 只豁免 Skill 白名单，仍不能越过 Plan/Do 或授权限制。显式停用解除相应激活限制；清空会话同时清除激活。刷新只影响待加载定义，已激活内容维持快照，显式重新调用才采用新版。

独立模式使用 `mode: isolated`，可选 `history: { kind: none }`（默认）、`history: { kind: recent, turns: 3 }` 或 `history: { kind: all }`；recent 的 turns 为 1—50。可选 `model: <已有模型配置ID>`；共享模式指定不同模型会被拒绝。子执行复用 Agent Loop，但隔离上下文、进程管理和完成验证，只回传状态、验证边界和有界摘要；主会话等待独立执行完成，全程不进行人工审批。子会话共享授权工作区，因此文件改动会保留；取消不会自动回滚或重做。

独立执行继承父工具限制及 Plan/Do，不允许再递归启动独立 Skill；每次最多 16 次模型迭代、5 分钟且不超过父预算，每主回合最多 4 次。缺失模型、未发现外部工具或容量超限不会静默回退。已配置MCP仍分别执行连接/调用规则检查，扫描 Skill 不发起连接。

目录型资源通过受白名单控制的 `read_skill_resource` 按需读取，不自动执行脚本；资源必须仍位于授权 Workspace 内，禁止穿越、链接逃逸和受保护路径。用户级/内置目录在工作区外时，只能加载入口，附属资源须先放到授权工作区。已通过资源工具引用的文件发生变化后会要求重新激活。脚本执行仍使用原命令工具、规则检查、沙箱、超时与取消；指纹校验不提供不可变文件系统或脚本运行期间的外部改写隔离。

每个入口最多 64 KiB，参数 16 KiB；每会话最多激活 8 个 Skill、指令合计 128 KiB，并受模型上下文预算进一步约束。目录摘要超过 16 KiB 时不向模型发送不完整目录；界面保留诊断。资源单次最多 128 KiB，每激活最多记录 64 个资源。

内置 `commit`、`review`、`test` 均为独立样板，可按项目需要覆盖。commit 仅处理用户明确授权范围、使用中文提交说明且不默认推送；review 默认只读；test 按现有 npm 流程检查并保留真实结果。样板是流程指令，不能替代运行权限或验收证据。

## 子 Agent 与后台任务

主 Agent 使用统一的 `agent` 工具按需委派。定义式 `defined` 选择角色，从空白历史启动；`fork` 继承父会话接纳时的完整消息组、背景及已激活 Skill 快照，排除当前尚未完成的整个工具批次。每个子执行独立维护上下文、权限、完成验证、取消和用量，仍使用同一个授权 Workspace。

模型工具参数示例：

```json
{"operation":"start","task":{"kind":"defined","role":"explorer","prompt":"读取关键入口并说明依赖关系","background":false}}
{"operation":"start","task":{"kind":"fork","prompt":"依据当前任务检查异常路径"}}
{"operation":"wait","taskId":"返回的任务 ID","timeoutMs":30000}
{"operation":"status","taskId":"返回的任务 ID"}
{"operation":"cancel","taskId":"返回的任务 ID"}
{"operation":"result","taskId":"返回的任务 ID","offset":0,"limit":4000}
```

创建接纳后立即返回稳定 ID，任务先进入 `preparing`，再排队执行；历史复制失败等准备错误作为同一任务的终态保留，可通过状态接口查看，不会隐式重跑。定义式默认前台，由主 Agent 随后等待，Fork 固定后台。显式后台、等待超时、手动转后台都继续同一次执行，截止时间保持不变。停止主回复或结束等待不会取消已接纳任务；取消子任务、清空/删除其会话、关闭运行时会停止相关执行。前后台只影响父级等待和结果投递；两者均自主执行，不产生审批请求。取消、原始截止时间和运行时关闭继续停止任务与子进程。

只读子任务可并行；具备修改能力的子任务独占共享工作区直到执行和清理结束。访问模式由实际可用工具及角色限制决定，命令、外部工具或未知元数据按独占处理，不能仅凭任务文字声明只读。独占期间父级文件工具等待，`agent` 查询/等待/取消和进程状态/停止仍可用；独立 Skill 采用相同协调规则。该规则不隔离用户编辑、其他进程或外部服务，父级整合时仍需重新读取并验证文件。

后台子任务与独立 Skill 共用就绪 FIFO 并发池。任务在 `waiting-resources` 等待工作区许可，在 `queued` 等待执行名额；资源等待不会占用执行名额，也不会延长原截止时间。就绪任务按进入队列的先后执行；关闭运行时会取消并等待资源接纳、运行和清理收敛。

子任务在接纳时固定任务、角色、模型、工具上限、上下文来源和预算，执行时仍检查动态权限撤销。当前运行时的任务接口提供 `admission` 摘要与 `preparedContext` 清单，区分接纳历史和实际引用复制的消息数、字节数、哈希及有界映射；不含完整凭据配置。清单不能恢复已丢弃历史，也不是工作区文件快照或重启恢复记录。

运行偏好中的 `groupRequests` 限制每个父轮及其后台子任务、独立 Skill 和摘要共同接纳的模型请求尝试，包含 OpenAI 适配器管理的重试，默认128、范围1–4096。父回复结束或下一轮不会给原后台任务续额；失败/取消不退款，已开始请求继续收尾，超限续轮以明确的模型预算错误停止。任务接口的 `usage.requestBudgets` 区分请求名额和已报告/未知用量；这是当前运行时的请求限制，不是token计费上限，后台记忆维护不纳入本组。

运行偏好中的 `groupTokens` 可启用同一父轮的共享token接纳预算，默认0关闭，范围0–10亿。请求和重试按输入JSON的UTF-8字节、格式余量及输出上限预留，已知usage结算实际值，缺失或取消保留预留额；不足时阻止新请求，已开始的请求继续收尾。模型没有配置输出上限时，启用该预算会使用8192的单次输出上限。不支持单次输出限制的Provider会被拒绝。`usage.requestBudgets[].tokens` 显示已报告、活动预留、未知及可用额；预估不构成服务商计费硬保证，已知超额会如实显示并阻止继续接纳。

需要确定性文件验收时，在创建任务时声明产物，再在终态后调用 `verify`，例如：

```json
{"operation":"start","task":{"kind":"defined","role":"builder","prompt":"生成report.md并检查内容","background":true,"output":{"files":[{"path":"report.md","contains":"# 报告"}]}}}
```

```json
{"operation":"verify","taskId":"实际创建返回的任务ID"}
```

声明最多8个相对路径，可选字面量或SHA256要求；验收按当前父权限和能力独立重读文件，不执行命令。结果范围固定为 `declared-file-checks-only`，区分通过、失败和未运行，不等同于自然语言任务完成。文件后续变化需重新验收，历史验收记录不会自动跟踪外部改动。Web与CLI对话均可要求模型调用该操作；验收工具结果可随父会话检查点保存，当前任务面板显示其有限范围。

当前运行时的任务接口提供 `timing`，按单调时钟记录准备排队、准备、资源等待、执行排队、执行、清理和终态发布各阶段耗时，以及首次停止请求所处阶段和停止至终态的耗时。终态执行计时固定，不受活动日志截断或后续查询影响；`deliveryTiming` 单独记录暂存、提交与失效。已投递的执行计时可随父会话检查点保存，投递计时仍仅存于当前运行时，不提供重启恢复。CLI `/tasks` 输出完整计时，模型状态查询仅返回紧凑摘要。

Web 侧栏“子 Agent 与任务”显示角色来源、任务状态、预算、用量、投递状态和结果，并可等待、转后台、取消及读取结果，无人工审批操作。CLI 支持：

```text
/agents
/tasks
/task show <id>
/task wait <id>
/task background <id>
/task cancel <id>
/task result <id> [offset]
/delegation delegate-only fork
/delegation collaborate auto
```

输入框“父级分工”可选择“协作与接管”或“仅委派汇总”。仅委派时，父模型只能使用任务控制与正文读取；子任务按角色、Plan/Do和权限执行。需要父级接管时，由用户切回协作并说明任务范围。CLI 单次运行可用 `--delegation delegate-only`。分工契约逐轮保存，可在运行导出的检查点中核对。输入框“子任务类型”可限定本轮所有新任务为 defined 或 fork；默认自动选择。CLI 可用 `/delegation delegate-only fork` 或单次运行 `--delegation-kind fork`。限定类型会收窄模型工具 Schema，并由运行时拒绝不匹配的创建调用，不解析自然语言替用户选择，也不保证模型一定创建任务。

子回复自动交付有界摘要，`replyTruncated`明确摘要是否省略正文，`replyStorage`报告正文是否保存。模型可调用`agent result`，用户可在任务面板点击“读取回复正文”或使用`/task result`分页查看；继续时使用实际返回的`nextOffset`。单页最多4000个Unicode字符，低结果预算时页长会自动缩小。完整正文与有界工具事实随父会话保存，子运行导出包含`childReply`与可用的`childToolFacts`；这些内容仍需按敏感会话数据保管。

正文上限256 KiB、工具事实64 KiB，父会话最多256项、16 MiB序列化总量。正文有效期30天；读取拒绝过期数据，后续写入清理过期项，清空或删除父会话会删除对应正文。保存失败以`unavailable`明确返回，最终回复仍由独立证据判断是否满足任务。实施与验证见[架构改进交付](docs/evals/sub-agents-architecture-delivery-2026-10-20.md)。

CLI 等待期间仍可输入控制命令，Ctrl+C 只结束当前等待。交互 CLI 退出或 Web 服务关闭会取消未完成任务；单次 `run` 在最终 JSON/JSONL 前关闭运行时，并在 `childTasks` 中报告子任务终态。后台队列仅存内存，关闭后不自动恢复，未保存结果可能丢失。

角色定义按项目 `.orbitcode/agents/*.md`、用户配置根 `agents/*.md`、应用内置 `agents/*.md` 的顺序覆盖；同层重名或坏的高优先级定义有诊断且不回退。不加载插件。内置角色为 `general`、`explorer`、`reviewer`。例如：

```markdown
---
name: inspect-project
description: 读取代码并列出有证据的风险
allowed-tools: [read_file, find_files, search_code, read_context]
disallowed-tools: [agent, write_file, run_command]
model: inherit
max-iterations: 8
permission-mode: default
---
检查指定模块，引用文件和实际工具结果，明确未验证项。
```

所有frontmatter字段必填；permission-mode是旧配置兼容字段，不再触发审批。工具使用精确名称，黑名单优先，空白名单不允许工具；模型为 `inherit` 或现有 OpenAI 兼容 Provider 配置名。角色正文在任务生命周期持续生效，权限始终取父快照、父当前限制、角色、Plan/Do 和当前拒绝规则的交集。子任务不能再次调用 `agent`，也不能启动独立 Skill；加载共享 Skill 仍受工具限制。每文件最多 64 KiB、frontmatter 8 KiB、任务输入 16 KiB；定义扫描和列表不发模型请求。

设置页“运行偏好”配置子预算：默认每主轮 4 个、保留 32 条记录、并发 2 个、最多 16 轮、5 分钟、单次前台等待 30 秒。有效轮次与时限还受父配置、角色上限约束；排队和执行计入原始截止时间。独立 Skill 也使用同一并发池。未投递结果不驱逐，已投递终态在容量压力或保留期限后退休。

完成结果进入队列，主 Agent 只在安全的模型请求边界消费，父轮已结束时不额外唤醒模型。结果与去重回执使用现有会话写入租约和 revision 一起保存，保存失败可 `/retry-save`。查看或等待不会额外投递。结果分别列出停止原因、模型回复、工具失败、原始命令退出信息、副作用、清理和验证状态；`final-response` 不能当作验收成功。

同一运行时内按 canonical Workspace 根协调潜在写入，包括命令、MCP 和长进程；长进程持有许可直到退出，读可并行。上下文隔离不提供文件隔离、回滚、跨进程或外部编辑器互斥。Fork 尽量保持稳定请求前缀，提示缓存是否命中以服务实际 usage 为准；缺失统计显示未知。父 self 用量与子 self 分开，聚合视图覆盖当前运行时已观测的父请求和仍保留的终态子记录，不代表退休任务的完整历史账单。

当前版本交付状态与边界见 [子 Agent 交付状态](docs/specs/sub-agents/delivery-status.md)。简单读取任务通常优先直接使用现有工具；独立上下文或多步子任务才是委派的主要适用场景，有限对照并不支持普遍加速结论。

实施与验收证据见 [子 Agent 验收记录](docs/evals/sub-agents.md) 和 [批准的规格](docs/specs/sub-agents/spec.md)。Fork 对已实际复制的上下文对象保留本次执行内的父引用别名，解析到子会话副本；未复制的其他父引用仍拒绝。子结果另保留有界全文搜索事实，扫描完成不代表模型理解正确或任务验收通过。本阶段不提供 Worktree、多 Agent 团队编排、跨会话后台恢复或 Hook 引擎。

模型无需额外提交完成报告：`report_completion`已撤下，报告参数错误不再触发强制收尾。运行时保留工具结果、命令退出码、失败、副作用及子交接；`unverified`表示未自动判定整项任务验收，不能据此否认已执行的检查，也不能用最终回复替代独立验证。旧角色/Skill白名单中的该名称被兼容忽略，不重新启用工具。

子任务源码探索在接近轮数上限时收到请求末尾的预算提示，硬上限、工具权限与截止不变；异常终止仍交回有界的已读文件和搜索位置。`handoff.reads`只表示实际工具来源，不证明卸载正文已完整读取或解释正确。目标类型错误与真实边界错误区分，原生日志保留`callId`、`iteration`和固定`targetFailureReason`，不记录原始查询、参数或错误正文。
