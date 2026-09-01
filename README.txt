OrbitCode——从零实现的 Web Coding Agent

Git 仓库：https://github.com/Hikari-0w0/OrbitCode

项目说明：OrbitCode 使用 TypeScript 自主实现，不依赖 Agent 框架、云端代码执行或托管文件工具。模型通过 OpenAI 兼容流式 Tool Calling 作出决策；本地 Harness 负责上下文、工具定义与执行、权限、错误恢复和终止判断。工具结果会回传模型形成“决策—行动—观察—再决策”闭环，使其能够真实读取、修改授权项目并运行构建或测试。

核心设计：Agent 核心与 Next.js/React 界面解耦；支持 Plan 只读分析与 Do 执行、单轮多工具调用、最多八个只读调用并发及副作用串行。文件操作经运行时参数校验、真实路径和符号链接检查；命令经过不可覆盖的危险操作拦截、人工审批和 macOS Seatbelt，沙箱不可用时失败关闭。系统提供三档权限及单次、会话、永久授权，批准后仍在执行前复检目标。

上下文与可靠性：完整保存用户、助手、工具调用和结果协议；会话通过 revision 冲突检查、磁盘租约和原子写入跨刷新恢复。大工具结果可卸载为会话内引用，长历史可用禁用工具的固定结构摘要压缩。迭代数、总运行时间、未知工具和连续失败均有安全停止条件。最终完成报告必须引用本轮真实工具证据，写入、构建、lint 与 HTTP 验证不能相互冒充。

运行：需要 Node.js 20.9+。执行 npm install；复制 .env.example 为 .env、orbitcode.example.yaml 为 orbitcode.yaml；API Key 只写本地 .env。运行 npm run dev 后访问 http://localhost:3000。

验证与边界：当前 314 项自动化测试全部通过，lint、TypeScript 严格检查和生产构建通过。Web 面向可信本机，命令沙箱当前仅支持 macOS；联网尚未细分域名，批量写入不是跨文件事务，真实 Provider 长任务及双标签活动竞争仍需最终人工验收。
