# OrbitCode

OrbitCode 是一个使用 TypeScript 自主实现的编程智能体，目标类似简化版 Claude Code 或 Codex。当前仓库使用 Next.js App Router 搭建项目基线；后续 Agent 核心应保持为与页面组件解耦的 TypeScript 模块，以便同时支持 Web 界面和终端入口。

## 沟通与代码风格

- 使用中文回答，提交说明和项目文档使用中文。
- 使用 TypeScript，保持严格类型，避免无必要的 `any` 和类型断言。
- 注释使用中文，只解释设计原因、约束和非显然行为，不复述代码。
- 优先小而清晰的模块；页面组件只负责展示与交互，不承载 Agent 循环、工具执行等核心逻辑。
- 命名应体现领域含义，例如 `conversation`、`toolCall`、`agentLoop`、`executionResult`，避免含糊缩写。

## 题目硬性约束

- 不得使用 LangChain、LlamaIndex、OpenAI Agents SDK、Claude Agent SDK、AutoGen、CrewAI 等 Agent 框架或 SDK。
- 可以使用模型厂商 API 客户端、OpenAI 兼容接口及模型原生 Tool Calling。
- 不得依赖 API 服务端托管的代码执行或文件工具，例如 Code Interpreter、Files API。
- 对话历史、上下文管理、工具定义、本地执行、模型输出解析、Agent 循环、终止条件和错误处理必须自行实现。
- API Key 和其他凭据只能通过环境变量或未入库的本地配置提供，不得写入代码、文档、日志、截图或视频。

## 当前技术栈

- Next.js 16，App Router
- React 19
- TypeScript 严格模式
- ESLint
- npm 与 `package-lock.json`
- Node.js 20.9 或更高版本

不要擅自引入新的运行时依赖。添加依赖前先确认标准库或现有依赖无法合理完成任务，并说明引入原因；尤其不得通过依赖间接引入 Agent 框架。

## 推荐代码边界

后续新增代码时遵循以下职责划分；目录可按实际开发逐步创建，不要提前生成空模块：

- `src/app/`：Next.js 路由、页面、布局和接口入口。
- `src/core/`：Agent 循环、会话状态、终止条件和错误模型，不依赖 React。
- `src/models/`：模型提供商适配、请求构造、流式响应和 Tool Calling 解析。
- `src/tools/`：工具定义、参数校验、权限边界和本地执行。
- `src/lib/`：不属于领域核心的通用基础设施。
- `src/components/`：纯 UI 组件及客户端交互。

核心依赖方向应保持为“界面/入口调用核心，核心调用模型和工具抽象”。`src/core/` 不得导入 React 或 Next.js 页面代码。

## Agent 实现原则

- 对话消息和工具调用结果使用明确的判别联合类型建模。
- 每次循环都必须有可解释的继续或终止条件，并设置最大轮数等安全上限。
- 工具参数在执行前完成运行时校验；不要信任模型生成的路径、命令或 JSON。
- 文件工具默认限制在用户授权的工作目录内，防止路径穿越和越界访问。
- 命令工具保留 stdout、stderr、退出码和超时信息，并处理进程取消。
- 错误返回结构化结果供模型判断；可恢复错误与致命错误应明确区分。
- 日志不得输出 API Key、完整环境变量或其他敏感信息。
- 优先保证最小闭环可运行，再增加流式输出、上下文压缩、审批机制等增强功能。

## 常用命令

```bash
npm run dev
npm run build
npm run lint
npm run typecheck
npm run check
```

## 测试

每次代码变更至少运行与改动相关的检查；功能开发完成后依次执行：

1. `npm run lint`
2. `npm run typecheck`
3. `npm run build`

涉及页面时，启动开发服务器并使用 `agent-browser` 检查页面内容、错误覆盖层和控制台错误，测试结束后关闭浏览器并停止开发服务器。

Agent 主流程可运行后，使用 tmux 做真实端到端测试：

1. 在 tmux 中启动 OrbitCode
2. 输入一段真实的对话请求
3. 观察模型请求、工具调用、本地执行和最终回复是否形成完整闭环
4. 覆盖工具失败、无效参数、命令超时和达到最大循环次数等异常路径

不要为通过测试而弱化安全限制，也不要在测试中使用真实密钥或把密钥写入录屏内容。

## Git 与交付

- 本文件必须保持为仓库根目录的 `AGENTS.md`，以便 Codex 在新任务中自动加载；不要改名为 `Claude.md` 或 `CLAUDE.md`。
- 保留清晰、可解释的提交历史，不重写已经推送的历史。
- 不提交 `.env.local`、日志、测试截图、视频、压缩包和题目 PDF。
- 不修改或删除用户已有的无关变更。
- 截止时间后不得继续向提交仓库推送。
