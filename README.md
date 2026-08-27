# OrbitCode

OrbitCode 是一个使用 TypeScript 自主实现的编程智能体，目标是通过大语言模型完成本地文件读写、命令执行和编程任务循环。目前仓库已完成 Next.js 项目初始化。

## 本地启动

环境要求：Node.js 20.9 或更高版本。

```bash
npm install
npm run dev
```

浏览器访问 [http://localhost:3000](http://localhost:3000)。

## 可用命令

```bash
npm run dev       # 启动开发服务器
npm run build     # 生成生产构建
npm run start     # 启动生产服务器
npm run lint      # 运行 ESLint
npm run typecheck # 运行 TypeScript 类型检查
npm run check     # 依次执行 lint、类型检查和生产构建
```

## 环境变量

复制 `.env.example` 为 `.env.local`，再填写本地模型配置。任何 API Key 都不得提交到 Git。

## 下一阶段

- 模型客户端与对话历史
- 本地工具注册和执行
- Tool Calling 智能体循环
- 上下文压缩、终止条件与错误处理
