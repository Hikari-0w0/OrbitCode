# OrbitCode

OrbitCode 是一个使用 TypeScript 自主实现的编程智能体。Web 入口已支持 OpenAI 兼容 Tool Calling 与自主 Agent Loop：模型可以连续调用本地工具、读取结构化结果并调整下一步行动，直到给出最终回复或触发安全停止条件。

Web 与 CLI 共用本地 Agent 运行时：工具执行、权限、Plan/Do、上下文管理、会话持久化和完成验证保持相同核心语义。CLI 可独立启动，无需先运行 Web 服务。

## 核心架构

- `src/core/`：Agent Loop、会话、上下文管理、终止条件与完成验证
- `src/models/`：模型请求、SSE 解析与 Tool Calling 适配
- `src/tools/`：工具定义、参数校验、权限边界与本地执行
- `src/runtime/`：两端共用的配置、Agent 编排、会话操作与运行记录
- `src/web/`：HTTP/SSE 适配与 Web 实例组合
- `src/cli/`：终端输入、审批、会话命令与文本展示
- `src/components/`：界面展示与交互，不承载 Agent 核心逻辑

## 配置

环境要求：Node.js 20.9 或更高版本。

```bash
npm install
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
- 严格、默认和放行三档权限模式
- 工具调用的单次、会话、永久允许与拒绝确认
- 桌面与移动端响应式布局

Web 会话保存在当前用户目录的 `~/.orbitcode/conversations-v1`，页面刷新、切换对话或服务重启后可继续。浏览器只提交本轮用户输入、稳定会话 ID 和期望 revision，不提交或决定模型历史；服务端保存完整的用户、助手、工具调用和工具结果 transcript，并用 revision 冲突保护避免旧页面覆盖新记录。模型生成最终文本以及用户取消、错误、达到最大迭代次数等中断情况都会提交本轮上下文；异常退出时恢复最近完整检查点并写入结构化中断标记。

验证状态中的“所列检查通过”仅覆盖报告内的检查项，页面可展开查看具体范围，不等同于全部需求已验收。验收项由模型根据任务组织，运行时不通过业务关键词猜测需求是否完整。

`start_process` 创建的服务仅用于本轮验证，完成、取消或失败后会回收，不能作为回复后持续可用的预览服务。端口探测只记录 TCP 连通性，不验证 HTTP 内容或监听者归属；启动前占用检查也不消除检查后其他进程抢占端口的竞态。模型应根据工具结果选择适合任务的后续验证。

### 上下文管理

上下文使用“轻量预防 + 重量兜底”两层策略，并优先压缩体积最大的工具结果：

- 每次普通模型调用前，超过 `single_tool_result_tokens` 的单个工具结果会保存到对应会话的本地 context 目录。模型历史只保留有界预览、原始体积和 `context://v1/...` 引用；完整内容不会进入 Git。
- 同一次工具调用批次超过 `tool_result_group_tokens` 时，结果按估算体积从大到小继续卸载。模型可在 Plan 或 Do 模式使用只读 `read_context` 分块取回当前会话的引用；它不能读取文件路径、其他会话引用，也不改变 Workspace 权限。
- 整体历史达到 `window_tokens - automatic_reserve_tokens` 时，OrbitCode 使用同一 OpenAI 兼容 Provider 生成固定七节摘要。摘要调用由核心强制使用 `toolChoice: none` 且不提供工具；较早用户消息保持原文，近期约 `recent_messages_tokens` 且至少 5 条原始消息逐字保留。
- 自动压缩默认预留 13K Token；页面“压缩上下文”使用默认 3K 余量以获得更高压缩率。成功后页面显示压缩前后估算及估算来源；失败显示安全原因。摘要连续失败三次会停止自动重试，用户仍可手动压缩，成功后解除熔断。

`window_tokens` 是每个 Provider 的必填配置，OrbitCode 不会根据模型名称猜测。其他上下文字段可省略并使用 `orbitcode.example.yaml` 中的默认值；所有阈值均按 Provider 独立解析。Token 估算不使用精确 tokenizer：有普通模型 API usage 时，以最近一次 prompt usage 为锚点，只近似计算后续增量；没有 usage 时标注为字符近似。

重量压缩后的摘要只恢复任务脉络，不被视为代码事实。模型需要具体文件内容时必须重新调用 `read_file`，需要已卸载工具输出时必须调用 `read_context`，不能从摘要猜测实现细节。切换 Provider 或 Workspace 不删除旧对话；只有清空或删除对应对话时才清理其上下文引用。

Agent Loop 默认最多执行 8 次模型迭代；可配置为 1–32，或使用 `unlimited` 取消迭代轮数上限。无限迭代仍受单轮运行时长保护，默认 60 分钟，可配置为 1–1440 分钟：

```dotenv
ORBITCODE_MAX_AGENT_ITERATIONS=unlimited
ORBITCODE_MAX_AGENT_RUNTIME_MINUTES=60
```

停止原因还包括上下文压缩失败、上下文容量不足和自动压缩熔断。`stopped` 始终是事件流中的唯一终止事件，页面会保留未完成轮次的部分文本与工具记录供检查。

OpenAI 兼容服务若报告 Token Usage，页面会显示本次及累计的输入、输出和总 Token；若任一迭代未报告 Usage，累计值会明确显示为“模型未报告”，不会用估算值冒充精确值。

### Plan Mode 与 Do Mode

页面输入区提供持续可见的 Plan/Do 切换，也继续支持在输入框中单独发送 `/plan` 或 `/do`。模式切换只改变当前页面状态，不会请求模型；Plan 后续请求由服务端只公开并只允许 `read_file`、`find_files`、`search_code` 和 `read_context`，即使模型伪造写入或命令调用也会被拒绝。

Plan 模式中的需求澄清使用普通多轮对话。最新一条成功 Plan 回复会显示“按此计划执行”；只有用户点击后，页面才会保留当前 Workspace 与已有计划上下文、切换到 Do，并追加一条可见的执行请求。失败、取消、旧回复或 Workspace 切换后的计划不可执行；模型文本也不能自动触发模式切换或副作用。

只有严格独立的 `/plan` 和 `/do` 会切换模式，`/plan 请分析这个任务` 会作为普通用户消息发送。切换 Provider 会创建新的 Do Mode 对话；清空会话会恢复 Do Mode，刷新页面则恢复已保存模式。

文件和命令工具只接受当前选定 Workspace 内的相对路径，拒绝路径穿越、符号链接和敏感配置文件。`run_command` 可以联网，因此 Agent 能直接执行 `npm install` 等开发命令；命令仍需通过当前权限模式或人工确认，并会过滤服务端环境变量、阻止访问 Workspace 外的用户数据。当前平台无法通过沙箱能力探测时，命令工具直接返回不可用，不会降级为普通子进程。

### 五层工具权限

所有 Web 工具调用都在服务端统一经过五层检查：Plan/Do 约束、不可覆盖的危险命令黑名单、Workspace 真实路径边界、可配置规则与权限模式，以及需要时的人工确认。Web 客户端只展示安全摘要并提交决定，不能自行授权或执行工具。权限拒绝会作为结构化工具结果返回模型，Agent Loop 可以改用安全路径或解释受限原因，不会因为普通拒绝而崩溃。

权限规则使用 `工具名(模式)` 作为 YAML 键，值为 `allow`、`ask` 或 `deny`。复制示例后可按需拆分到三个固定位置：

```bash
mkdir -p .orbitcode
cp orbitcode.permissions.example.yaml .orbitcode/permissions.yaml
```

| 层级 | 固定位置 | 用途 |
| --- | --- | --- |
| 用户级 | `~/.orbitcode/permissions.yaml` | 当前用户跨项目规则 |
| 项目级 | `<Workspace>/.orbitcode/permissions.yaml` | 可随项目共享的规则 |
| 本地级 | `<Workspace>/.orbitcode/permissions.local.yaml` | 当前机器规则和“永久允许”写入目标 |

三个层级只决定存储位置，不决定优先级。OrbitCode 合并所有匹配规则后固定按 `deny > ask > allow` 判断；因此更具体、位于本地层或后读取的 `allow` 都不能覆盖任何匹配的 `ask` 或 `deny`。没有未转义 `*`、`?` 的模式是完整精确匹配；路径 Glob 的 `*` 只匹配单个路径段，`**` 匹配多层目录；命令 Glob 的 `*` 可以跨空格匹配字符。字面量星号和问号分别写成 `\*`、`\?`。

没有规则匹配时，三档模式的默认结果如下：

| 权限模式 | 读取工具 | 写入工具 | 命令工具 |
| --- | --- | --- | --- |
| 严格 Strict | ask | ask | ask |
| 默认 Default | allow | ask | ask |
| 放行 Permissive | allow | allow | allow |

模式只提供默认判断，不能绕过危险命令黑名单、Workspace 路径边界、受保护配置或 Plan Mode 的只读约束。显式规则同样不能绕过这些更高层限制。

当结果为 `ask` 时，页面提供四种选择：

- “本次允许”只对当前工具调用有效。
- “本会话允许”只复用相同会话、工具和规范目标；参数变化仍会重新确认。
- “永久允许”先允许当前调用，并尝试把相同工具与规范目标的精确 `allow` 原子写入本地级配置。若仍有匹配的 `ask`，后续调用仍会确认；若有 `deny`，调用不会执行。
- “拒绝”返回结构化失败，模型可以调整方案。

停止生成、清空、切换 Workspace 或 Provider、关闭权限会话，以及等待超时都会终止尚未完成的授权；迟到或跨会话决定无效。项目级与本地级权限文件本身受文件工具和命令沙箱保护。本仓库已忽略自身的 `.orbitcode/permissions.local.yaml`；在其他 Workspace 使用本地规则时，需要由该项目自行加入忽略规则，OrbitCode 不会修改外部项目的 `.gitignore`。

本阶段不实现按域名细分的网络规则、资源配额、审计日志或公网身份认证。联网能力跟随整个 `run_command` 的权限决定，不会单独弹出第二次网络授权。Web API 仍只适合本机使用，不要把开发服务器绑定或暴露到不受信任的网络。

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

读取配置不会授权启动进程或联网。Do 回合先通过现有 Web 卡片／CLI `/approve` 审批连接，再发现工具；调用工具时仍需独立授权。严格和默认权限模式对未知 MCP 操作默认询问；用户主动选择放行模式后，MCP 连接和调用默认允许，显式 ask／deny 规则仍优先，外部 Server 的只读注解不能降低风险。Plan 不连接、刷新或暴露 MCP 工具。外部 Server **不受本地文件沙箱保证**，上述本地路径边界和命令黑名单不能约束它的内部行为；OrbitCode 控制的是连接及调用授权。

规则使用 `mcp_connect(目标)`、`mcp_call(目标)`，与模型可见的 `mcp__…` 命名分开。审批生成的精确目标绑定 Server／配置摘要，调用还绑定原工具名、定义和参数摘要；配置或参数变化会重新授权，`deny > ask > allow` 保持不变。建议由审批生成精确规则，避免手写宽泛允许。

工具使用 Server 命名空间与摘要避免重名，执行前验证并冻结参数。支持受限 JSON Schema 2020-12：基本类型、enum/const、对象属性与必填项、additionalProperties、数组 items/数量/唯一性、Unicode 字符串长度、数值上下界、allOf/anyOf/oneOf/not，以及 `$defs` 中无环的本地 `$ref`。根 Schema 必须为 object；pattern、format、远程或循环引用、条件约束及未知关键字会拒绝注册，不做类型转换、补默认值或删除属性。未支持的输出 Schema 会标注为未验证。

文本和结构化结果进入现有上下文卸载、会话与运行记录流程；模型视图会在确认两者完全重复时只保留一份，持久化结果仍保留脱敏后的两种表示。媒体仅保留占位，不自动读取资源链接。已知配置秘密会在描述、审批摘要和结果中脱敏，HTTP 会话头与子进程 stderr 不展示。凭据应通过环境变量或未入库本地配置提供，不要放入命令参数；本仓库已忽略 `.orbitcode/mcp.yaml`，其他项目需自行加入忽略规则。

连接按进程内 Workspace／有效配置缓存，跨回合复用但不共享会话授权；配置改变会淘汰旧连接。工具列表分页完整完成后才注册，列表变化通知在下一个获准 Do 回合刷新。失败连接不自动重连或重试；修改配置或重启应用后可重新建立。正常退出和信号退出释放连接，stdio 以进程组有界终止。硬限额包括 32 个 Server、单 Server 128 个工具／32 页、工作区 256 个工具／512 KiB 定义、单消息 2 MiB、Schema 64 KiB、32 个在途请求和 128 个缓存连接；MCP 调用最长 60 秒且受回合总时限约束。

本阶段只接入工具，不提供资源发现、提示词、采样、tasks、健康检查或自动重连。外部工具成功不自动成为 CompletionTracker 的只读／命令验证证据。仅确认外部调用返回时，完成检查使用 scope: external-call，并且只引用一次成功的外部调用；此范围不证明外部副作用或本地变更。

## CLI 编程智能体

```bash
npm run cli
npm run cli -- --config orbitcode.yaml --provider primary --workspace my-app
npm run cli -- --resume <conversation-id>
npm run cli -- export-conversation <conversation-id> --output conversation.json
npm run cli -- export-run <run-id> --output run.json
```

存在多个 Provider 时通过 `--provider` 明确选择。默认优先读取设置页保存的托管资源；未创建托管设置时读取启动目录的旧配置和 `.env`。显式 `--config` 使用旧模型文件。交互 CLI 的 `--data-dir` 使用独立托管设置、会话、日志与用户级权限，且不自动加载日常 `.env`。`--resume` 恢复原绑定，不能同时指定 Provider 或 Workspace 覆盖参数。两端使用相同配置根和配置标识时，可先后继续 `~/.orbitcode/conversations-v1` 中同一会话；并发写入由写租约和 revision 保护。

单次非交互运行可使用 `npm run cli -- run --prompt-file task.txt --output-format json`，或以 `--stdin` 接收多行输入；进程等待模型与持久化结束后输出结果。JSONL 模式按序输出事件及唯一终态。未授权操作返回 blocked 和退出码 3；可在显式 `--data-dir` 下使用 `--policy-file` 指定本次隔离策略。运行结果的 `completed` 只表示 Agent 正常结束，任务正确性仍须独立验收。完整用法见 [Agent 评测用法](docs/evals/agent-evaluation.md)。

| 终端操作 | 命令 |
| --- | --- |
| 帮助、状态、取消、退出 | `/help`、`/status`、`/cancel`、`/exit` |
| 模型与项目 | `/providers`、`/provider <name>`、`/workspaces`、`/workspace <id>` |
| 规划与执行 | `/plan`、`/do`、`/execute-plan` |
| 权限模式 | `/permissions strict`、`/permissions default`、`/permissions permissive` |
| 审批 | `/approve <request-id> once`，最后一项也可为 `session`、`permanent` 或 `deny` |
| 会话 | `/new`、`/conversations`、`/resume <id>`、`/history`、`/rename <title>` |
| 清空、删除 | `/clear`、`/delete <id>`，再用提示中的 `/confirm <token>` 确认 |
| 上下文与恢复 | `/compress`、`/retry-save`、`/recover` |
| 工具详情与导出 | `/tool <call-id>`、`/export <path>` |

生成期间仍能输入审批或取消；Ctrl-C 取消当前操作，空闲时退出。管线输入逐行执行，遇到人工审批立即拒绝，不把下一条业务文本当作授权。只有独立 `/plan` 和 `/do` 切换模式；`//` 可发送以 `/` 开头的普通消息。文本输出会过滤终端控制序列，长工具结果可通过 `/tool` 查看。

`/retry-save` 只重试当前进程持有的未保存结果，不重新运行模型或工具。重启后 `/recover` 恢复已有磁盘检查点和中断标记，不能回滚文件或自动重放命令。会话授权不跨进程恢复，切换 Provider/Workspace 会新建 Do 会话。命令工具仍要求现有严格沙箱可用，不支持时明确拒绝。

导出文件可能包含完整对话与代码，拒绝覆盖已有路径。未保存状态下 `/export` 导出进程内检查点以便人工保留，格式为 `orbitcode-unsaved-checkpoint`，不等同于已保存的完整会话导出。

## 可用命令

```bash
npm run dev       # 启动开发服务器
npm run cli       # 使用托管设置或旧版配置启动命令行 Agent
npm run eval:agent -- --help # 查看真实模型评测的显式预算参数
npm run test      # 运行单元、集成和端到端测试
npm run build     # 生成生产构建
npm run start     # 启动生产服务器
npm run lint      # 运行 ESLint
npm run typecheck # 运行 TypeScript 类型检查
npm run check     # 依次执行 lint、类型检查和生产构建
```

## 环境变量

可在设置页选择本机私密存储或环境变量作为模型凭据；旧版文件方式可复制 `.env.example` 为 `.env`。任何 API Key 都不得提交到 Git、写入公开配置、作为命令行参数传递或发送到浏览器。`ORBITCODE_MAX_AGENT_ITERATIONS` 和 `ORBITCODE_MAX_AGENT_RUNTIME_MINUTES` 同时影响 Web 与 CLI Agent Loop；托管设置中的同类上限优先。

## 后续阶段

项目整理与运行诊断分别见 [现状基线](docs/project-baseline-2026-09-16.md) 和 [运行评估工作流](docs/evals/README.md)。运行评估可以直接使用本地日志和现有单轮导出命令，无需先从页面下载完整会话。

- 独立 HTTP 工具、按域名网络规则、资源配额与审计日志
