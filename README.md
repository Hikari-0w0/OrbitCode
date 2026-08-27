# OrbitCode

OrbitCode 是一个使用 TypeScript 自主实现的编程智能体。Web 入口已支持 OpenAI 兼容 Tool Calling，可在服务端安全执行一次本地工具并让模型根据真实结果生成最终回复。

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

浏览器访问 [http://localhost:3000](http://localhost:3000)。Web 与 CLI 共用项目根目录的 `.env` 和 `orbitcode.yaml`，无需在页面中重复配置密钥或服务地址。

页面支持：

- OpenAI 兼容模型的 SSE 增量回复
- 读取、写入和唯一原文替换文件
- 按受限 Glob 查找文件，以及按字面量搜索代码
- 在 macOS Seatbelt 严格沙箱中执行命令
- 展示工具执行中、成功、失败、超时与取消状态
- 当前页面生命周期内的多轮上下文
- 多 Provider 选择（切换时清空当前历史）
- 停止生成、失败后继续和清空会话
- 桌面与移动端响应式布局

刷新页面会清空对话历史。本阶段不包含数据库或会话持久化。

每次用户请求最多执行一个工具。OrbitCode 会把结构化工具结果追加到当前轮内部 transcript，再请求模型生成最终文本；若模型在第二次请求中继续调用工具，本轮会安全终止，不会进入连续 Agent Loop。

文件和命令工具只接受项目工作目录内的相对路径，拒绝路径穿越、符号链接和敏感配置文件。`run_command` 还会过滤环境变量并在 OS 级沙箱内禁用网络和工作目录外的用户数据访问；当前平台无法通过沙箱能力探测时，命令工具直接返回不可用，不会降级为普通子进程。

> Web API 当前没有身份认证，且具备受限的本地文件和命令能力，只适合在本机使用。不要将开发服务器暴露到不受信任的网络。

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

复制 `.env.example` 为 `.env`，只填写本地 API Key；模型名和服务地址写在未入库的 `orbitcode.yaml`。CLI 与 Web Route Handler 都只在服务端读取这些文件。任何 API Key 都不得提交到 Git、写入 YAML、作为命令行参数传递或发送到浏览器。

## 下一阶段

- 连续多轮 Tool Calling Agent Loop
- 上下文压缩、终止条件与错误处理
