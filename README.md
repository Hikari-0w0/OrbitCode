# OrbitCode

OrbitCode 是一个使用 TypeScript 自主实现的编程智能体。Web 入口已支持 OpenAI 兼容 Tool Calling 与自主 Agent Loop：模型可以连续调用本地工具、读取结构化结果并调整下一步行动，直到给出最终回复或触发安全停止条件。

## CLI 流式对话

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
```

`.env` 和 `orbitcode.yaml` 均不会被 Git 跟踪。OrbitCode 启动时自动加载当前工作目录的 `.env`，但不会覆盖进程中已经导出的同名变量。

启动单配置：

```bash
npm run cli -- --config orbitcode.yaml
```

YAML 包含多个配置时按 `name` 选择：

```bash
npm run cli -- --config orbitcode.yaml --provider primary
```

回复会随 OpenAI 兼容服务的 SSE 增量实时显示。当前进程内保留完整多轮历史；输入 `/exit`、按 `Ctrl-D` 或在空闲时按 `Ctrl-C` 可退出，生成期间按 `Ctrl-C` 只取消当前回复。

CLI 当前仍保持纯文本流式对话；本地 Tool Calling 暂由 Web 入口提供。

## Web 流式对话

```bash
npm run dev
```

浏览器访问 [http://localhost:3000](http://localhost:3000)。Web 与 CLI 共用项目根目录的 `.env` 和 `orbitcode.yaml`，无需在页面中重复配置密钥或服务地址。Web 可另外从未入库的 `orbitcode.workspaces.yaml` 加载本地授权项目；未创建该文件时，保持以 OrbitCode 启动目录作为唯一默认 Workspace。

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

切换 Workspace 会清空当前对话、草稿和可执行计划，并回到 Do Mode，避免把一个项目的上下文带入另一个项目。生成期间 Workspace 选择器会禁用。所有文件与命令工具仍经过路径、符号链接、敏感文件和命令沙箱校验，选择 Workspace 不会放宽这些边界。

页面支持：

- OpenAI 兼容模型的 SSE 增量回复
- ReAct 风格的多迭代 Agent Loop，以及一次响应中的多个工具调用
- 读取、写入和唯一原文替换文件
- 按受限 Glob 查找文件，以及按字面量搜索代码
- 在 macOS Seatbelt 严格沙箱中执行命令
- 只读工具分批并发，写文件、修改文件和命令工具按原调用边界串行执行
- 展示模型文本、迭代进度、工具排队/执行/结果、累计 Token 用量与最终停止原因
- 当前页面生命周期内的多轮上下文
- 多 Provider 选择（切换时清空当前历史）
- 多个服务端授权的本地 Workspace 选择（切换时隔离并重置会话）
- 停止生成、失败后继续和清空会话
- `/plan` 只读分析模式与 `/do` 完整执行模式
- 桌面与移动端响应式布局

刷新页面会清空对话历史。本阶段不包含数据库或会话持久化。

每次用户请求会启动一个独立 Agent Loop。每轮先调用模型，若模型请求工具，OrbitCode 会在服务端执行并把 assistant `tool_calls` 与对应 tool 结果写回内部 transcript，再进入下一轮模型请求。只有模型生成非空最终文本时，本轮用户消息和最终助手文本才会加入公开多轮历史；取消、错误和安全停止轮次不会污染下一次请求。

Agent Loop 默认最多执行 8 次模型迭代，硬上限为 32。可在服务端环境中覆盖默认值：

```dotenv
ORBITCODE_MAX_AGENT_ITERATIONS=8
```

停止原因分为六类：模型生成最终回复、达到最大迭代次数、用户取消、连续两轮只调用未知工具、模型响应流错误和 Agent 内部错误。`stopped` 是事件流中的唯一终止事件，页面会保留未完成轮次的部分文本与工具记录供检查。

OpenAI 兼容服务若报告 Token Usage，页面会显示本次及累计的输入、输出和总 Token；若任一迭代未报告 Usage，累计值会明确显示为“模型未报告”，不会用估算值冒充精确值。

### Plan Mode 与 Do Mode

页面输入区提供持续可见的 Plan/Do 切换，也继续支持在输入框中单独发送 `/plan` 或 `/do`。模式切换只改变当前页面状态，不会请求模型；Plan 后续请求由服务端只公开并只允许 `read_file`、`find_files` 和 `search_code`，即使模型伪造写入或命令调用也会被拒绝。

Plan 模式中的需求澄清使用普通多轮对话。最新一条成功 Plan 回复会显示“按此计划执行”；只有用户点击后，页面才会保留当前 Workspace 与已有计划上下文、切换到 Do，并追加一条可见的执行请求。失败、取消、旧回复或 Workspace 切换后的计划不可执行；模型文本也不能自动触发模式切换或副作用。

只有严格独立的 `/plan` 和 `/do` 会切换模式，`/plan 请分析这个任务` 会作为普通用户消息发送。切换 Provider、清空会话或刷新页面都会恢复 Do Mode。

文件和命令工具只接受当前选定 Workspace 内的相对路径，拒绝路径穿越、符号链接和敏感配置文件。`run_command` 还会过滤环境变量并在 OS 级沙箱内禁用网络和 Workspace 外的用户数据访问；当前平台无法通过沙箱能力探测时，命令工具直接返回不可用，不会降级为普通子进程。

> Web API 当前没有身份认证，且具备受限的本地文件和命令能力，只适合在本机使用。不要把开发服务器绑定或暴露到不受信任的网络；Plan Mode 也不是完整权限系统，后续仍需加入身份认证、细粒度权限与交互式确认。

## 可用命令

```bash
npm run dev       # 启动开发服务器
npm run cli       # 启动命令行对话（需追加 -- --config ...）
npm run test      # 运行单元、集成和 CLI 端到端测试
npm run build     # 生成生产构建
npm run start     # 启动生产服务器
npm run lint      # 运行 ESLint
npm run typecheck # 运行 TypeScript 类型检查
npm run check     # 依次执行 lint、类型检查和生产构建
```

## 环境变量

复制 `.env.example` 为 `.env`，只填写本地 API Key；模型名和服务地址写在未入库的 `orbitcode.yaml`。CLI 与 Web Route Handler 都只在服务端读取这些文件。任何 API Key 都不得提交到 Git、写入 YAML、作为命令行参数传递或发送到浏览器。`ORBITCODE_MAX_AGENT_ITERATIONS` 只影响 Web Agent Loop；CLI 本阶段仍保持原有纯文本流式多轮对话，不执行工具，也不识别 `/plan`、`/do`。

## 后续阶段

- 完整权限系统与用户交互式确认
- 上下文压缩与长期会话持久化
- 将入口无关的 Agent 核心接入 CLI
