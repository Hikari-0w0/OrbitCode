# OrbitCode

OrbitCode 是一个使用 TypeScript 自主实现的编程智能体，目标是通过大语言模型完成本地文件读写、命令执行和编程任务循环。目前仓库已完成 Next.js 项目初始化。

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

本阶段仅支持纯文本对话，不包含 Tool Calling、文件操作、命令执行、代码编辑、会话持久化或 Agent 循环。

## Web 项目基线

```bash
npm run dev
```

浏览器访问 [http://localhost:3000](http://localhost:3000)。

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

复制 `.env.example` 为 `.env`，只填写本地 API Key；模型名和服务地址写在未入库的 `orbitcode.yaml`。任何 API Key 都不得提交到 Git、写入 YAML 或作为命令行参数传递。

## 下一阶段

- 本地工具注册和执行
- Tool Calling 智能体循环
- 上下文压缩、终止条件与错误处理
