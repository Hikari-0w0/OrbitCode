# OrbitCode

OrbitCode 是一个使用 TypeScript 自主实现的编程智能体。Web 入口已支持 OpenAI 兼容 Tool Calling 与自主 Agent Loop：模型可以连续调用本地工具、读取结构化结果并调整下一步行动，直到给出最终回复或触发安全停止条件。

完整的 Coding Agent 能力由 Web 入口提供；CLI 当前仅用于流式多轮对话。

## 核心架构

- `src/core/`：Agent Loop、会话、上下文管理、终止条件与完成验证
- `src/models/`：模型请求、SSE 解析与 Tool Calling 适配
- `src/tools/`：工具定义、参数校验、权限边界与本地执行
- `src/web/`：Web 会话持久化、恢复与接口编排
- `src/components/`：界面展示与交互，不承载 Agent 核心逻辑

## 配置

环境要求：Node.js 20.9 或更高版本。

```bash
npm install
cp .env.example .env
cp orbitcode.example.yaml orbitcode.yaml
```

在本地 `.env` 中填写真实 API Key。YAML 不保存密钥，只保存环境变量名称：

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

`.env` 和 `orbitcode.yaml` 均不会被 Git 跟踪。OrbitCode 启动时自动加载当前工作目录的 `.env`，但不会覆盖进程中已经导出的同名变量。

`thinking` 为可选配置。为兼容既有配置，省略 `api_style` 时使用 SiliconFlow 的 `enable_thinking` 参数；连接 DeepSeek 官方 API 时必须设置 `api_style: deepseek`，此时 OrbitCode 会发送官方的 `thinking.type` 参数，且不接受仅由 SiliconFlow 支持的 `budget_tokens`。

## Web 流式对话

```bash
npm run dev
```

浏览器访问 [http://localhost:3000](http://localhost:3000)。Web 使用项目根目录的 `.env` 和 `orbitcode.yaml`，无需在页面中重复配置密钥或服务地址。Web 可另外从未入库的 `orbitcode.workspaces.yaml` 加载本地授权项目；未创建该文件时，保持以 OrbitCode 启动目录作为唯一默认 Workspace。

### 选择本地 Workspace

需要管理多个本地项目时，先复制示例并把每个 `path` 改为已存在的绝对目录：

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
- 启动、查看和停止本轮临时长驻进程，并等待 IPv4/IPv6 loopback 端口就绪
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

页面输入区提供持续可见的 Plan/Do 切换，也继续支持在输入框中单独发送 `/plan` 或 `/do`。模式切换只改变当前页面状态，不会请求模型；Plan 后续请求由服务端只公开并只允许 `read_file`、`find_files` 和 `search_code`，即使模型伪造写入或命令调用也会被拒绝。

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

## 可用命令

```bash
npm run dev       # 启动开发服务器
npm run cli       # 启动命令行对话（需追加 -- --config ...）
npm run test      # 运行单元、集成和端到端测试
npm run build     # 生成生产构建
npm run start     # 启动生产服务器
npm run lint      # 运行 ESLint
npm run typecheck # 运行 TypeScript 类型检查
npm run check     # 依次执行 lint、类型检查和生产构建
```

## 环境变量

复制 `.env.example` 为 `.env`，只填写本地 API Key；模型名和服务地址写在未入库的 `orbitcode.yaml`。这些配置只在服务端读取。任何 API Key 都不得提交到 Git、写入 YAML、作为命令行参数传递或发送到浏览器。`ORBITCODE_MAX_AGENT_ITERATIONS` 只影响 Web Agent Loop。

## 后续阶段

- 独立 HTTP 工具、按域名网络规则、资源配额与审计日志
