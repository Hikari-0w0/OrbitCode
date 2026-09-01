# Web 流式对话 Tasks

状态：已批准
依据：已批准的 `spec.md` 与 `plan.md`

## 文件清单

| 操作 | 文件 | 职责 | 对应需求 |
| --- | --- | --- | --- |
| 修改 | `src/models/config.ts`、`src/models/config.test.ts` | 列举 Provider 安全元数据并保留现有选择/凭据语义 | F2、F9、F12 |
| 新建 | `src/web/chat-contract.ts`、`src/web/chat-contract.test.ts` | Web 请求校验、限制和 SSE 事件编解码 | F4、F7、F12、F13 |
| 新建 | `src/app/api/providers/route.ts` | 返回安全 Provider 摘要 | F2、F9 |
| 新建 | `src/app/api/chat/route.ts` | 校验请求、装配核心并流式返回 | F4–F7、F12、F13 |
| 新建 | `src/components/chat-workspace.tsx` | Web 对话状态机与 API 交互 | F1–F11、F13 |
| 新建 | `src/components/message-list.tsx` | 消息、空状态和滚动交互 | F1、F4、F7、F10、F11 |
| 新建 | `src/components/chat-composer.tsx` | 输入、发送与停止控制 | F3、F6、F8、F11 |
| 修改 | `src/app/page.tsx`、`src/app/globals.css`、`src/app/layout.tsx` | 页面组合、视觉系统、响应式和元数据 | F1、F10、F11 |
| 修改 | `README.md` | Web 启动、配置、安全边界和功能范围 | F1、F2 |

## T1：扩展服务端配置与 Web 协议

- 对应：F2、F4、F7、F9、F12、F13，`plan.md` 的「Provider 配置目录」「Web 协议与请求校验」
- 文件：`src/models/config.ts`、`src/models/config.test.ts`、`src/web/chat-contract.ts`、`src/web/chat-contract.test.ts`
- 依赖：现有 CLI 阶段实现

步骤：

1. 将配置读取/验证与选择/凭据解析拆为可复用函数，保持现有 `loadProviderConfig` 行为不变。
2. 定义 Provider 安全摘要、Web 请求、Web 流事件和固定限制。
3. 从 `unknown` 校验精确请求结构、消息角色/顺序、空值、长度、数量和 Provider 名称。
4. 实现 Web SSE 事件的安全编码与增量解析，错误不包含原始负载。
5. 补充配置兼容与协议边界测试。

验证：

- 运行：`npm run test -- src/models/config.test.ts src/web/chat-contract.test.ts`
- 期望：退出码 `0`，现有 CLI 配置测试不回退，Web 非法请求均在模型调用前拒绝。

## T2：实现 Provider 与聊天 Route Handler

- 对应：F2、F4–F7、F9、F12、F13，`plan.md` 的「Next.js Route Handlers」
- 文件：`src/app/api/providers/route.ts`、`src/app/api/chat/route.ts`
- 依赖：T1

步骤：

1. Provider 接口固定从项目根配置读取，返回名称、模型和凭据可用状态，不返回地址、环境变量名或密钥。
2. 聊天接口在读取前检查请求体大小，解析并校验消息与 Provider，装配现有核心会话和 Provider。
3. 将核心文本、完成和失败事件逐个编码为浏览器 SSE，设置禁止缓存和缓冲的响应头。
4. 将请求断开与流取消连接到上游 AbortSignal，确保所有完成路径移除监听器。
5. 启动前配置/请求错误返回稳定 JSON 与合适状态码，未知错误不输出堆栈。

验证：

- 运行：`npm run typecheck` 与相关协议测试。
- 期望：Route Handler 严格编译，API Key 只出现在服务端 Provider 构造边界。

## T3：实现聊天工作区组件

- 对应：F1、F3–F11、F13，`plan.md` 的「React 聊天工作区」「状态与交互」
- 文件：`src/components/chat-workspace.tsx`、`src/components/message-list.tsx`、`src/components/chat-composer.tsx`
- 依赖：T1、T2

步骤：

1. 实现 Provider 加载、可用状态、切换清空和配置错误呈现。
2. 实现可见消息与已提交历史分离的状态机，增量更新助手消息，完成后原子提交历史。
3. 实现 Enter/Shift+Enter、发送、停止、清空、重复提交防护和卸载取消。
4. 实现消息空状态、角色/状态标签、纯文本换行、自动跟随、脱离跟随和回到底部。
5. 保证可访问标签、键盘焦点及生成状态提示完整。

验证：

- 运行：`npm run lint`、`npm run typecheck`
- 期望：无 Hook、类型或无障碍静态检查错误；客户端模块不导入 Node 配置或具体 Provider。

## T4：完成页面视觉与响应式布局

- 对应：F1、F10、F11、N6、N7、N9，`plan.md` 的「React 聊天工作区」
- 文件：`src/app/page.tsx`、`src/app/globals.css`、`src/app/layout.tsx`
- 依赖：T3

步骤：

1. 将静态基线页替换为聊天工作区入口，更新页面元数据。
2. 建立深色 IDE 风格视觉层级、消息卡片、状态点、输入面板和按钮状态。
3. 完成桌面双区和移动单列布局，处理长文本、长单词、虚拟键盘和安全区。
4. 为 focus-visible、hover、disabled、流式光标和 reduced-motion 提供明确样式。

验证：

- 运行：`npm run build`
- 期望：Next.js 页面与两个 Route Handler 构建成功，无服务端/客户端边界错误。

## T5：更新文档并完成精简验收

- 对应：全部需求，`plan.md` 的「验证策略」
- 文件：`README.md`、本目录 `checklist.md`；仅修复前述文件中验证暴露的问题
- 依赖：T1–T4

步骤：

1. 更新 README 的 Web 启动、Provider 选择、取消/清空、刷新语义和本机使用警告。
2. 运行完整测试、lint、typecheck 和 build。
3. 启动开发服务器并使用浏览器完成一次真实两轮对话、一次停止或清空，以及桌面/移动布局和控制台检查。
4. 关闭开发服务器与浏览器资源，记录简洁证据，不重复执行过度细分的异常矩阵。

验证：

- 运行：`npm run test`、`npm run lint`、`npm run typecheck`、`npm run build`
- 可观察：真实浏览器中增量回复、多轮上下文、停止/清空和响应式布局可用，控制台无错误。

## 执行顺序

```text
T1 → T2 → T3 → T4 → T5
```
