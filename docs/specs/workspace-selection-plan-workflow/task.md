# Workspace 选择与 Plan 执行工作流 Tasks

状态：已批准
依据：已批准的 `spec.md` 与 `plan.md`

## 文件清单

| 操作 | 文件 | 职责 | 对应需求 |
| --- | --- | --- | --- |
| 新建 | `orbitcode.workspaces.example.yaml` | 提供不含用户真实目录的可提交配置示例 | F1、F2 |
| 修改 | `.gitignore` | 忽略本地 `orbitcode.workspaces.yaml` | F1、F2 |
| 修改 | `README.md` | 说明 Workspace 配置、选择和 Plan 执行工作流 | F1、F7–F10、F13 |
| 新建 | `src/web/workspace-config.ts` | 解析、限制、摘要化并按 ID 解析 Workspace Catalog | F1、F2、F5、F13 |
| 新建 | `src/web/workspace-config.test.ts` | 验证配置缺失、非法配置、上限、不泄漏和请求级重新解析 | F1、F2、F5、F13 |
| 新建 | `src/app/api/workspaces/route.ts` | 返回安全的 Workspace Catalog 与默认 ID | F1、F2、F13 |
| 修改 | `src/web/chat-contract.ts` | 增加 `workspaceId` 请求字段与 Workspace Catalog 响应解析 | F1、F5 |
| 修改 | `src/web/chat-contract.test.ts` | 验证精确字段、ID 限制、路径注入拒绝和目录响应 | F1、F5 |
| 修改 | `src/app/api/chat/route.ts` | 将 workspace ID 服务端解析为请求专属边界后组装 Agent | F5、F6、F8、F13 |
| 新建 | `src/components/chat-session-state.ts` | 用纯 reducer 统一表达 workspace、Provider、模式、请求和计划候选状态 | F4、F7、F9–F12 |
| 新建 | `src/components/chat-session-state.test.ts` | 覆盖所有会话转换不变量和竞态 | F4、F7、F9–F12 |
| 新建 | `src/components/workspace-selector.tsx` | 显示当前 workspace、可用项、加载/禁用状态 | F3、F13 |
| 修改 | `src/components/chat-composer.tsx` | 提供可点击 Plan/Do 控件和准确只读说明 | F7、F8 |
| 修改 | `src/components/message-list.tsx` | 对最新成功 Plan 回复显示“按此计划执行” | F9–F11 |
| 修改 | `src/components/chat-workspace.tsx` | 并行加载目录、调度状态转换、发送 workspace ID 和执行计划 | F3–F5、F7、F9–F13 |
| 修改 | `src/components/chat-workspace.test.tsx` | 验证新控件、文案、禁用和无路径泄漏 | F3、F7、F10、F13 |
| 修改 | `src/app/globals.css` | 完成 Workspace、模式和计划操作的响应式、焦点和禁用样式 | F3、F7、F10 |
| 修改 | `tests/web-tool-agent.e2e.test.ts` | 用双临时 workspace 验证 Agent 工具隔离、Plan 只读与 Do 执行 | F5、F6、F8–F11 |

## T1：建立服务端 Workspace Catalog

- 对应：F1、F2、F5、F13，`plan.md` 的「Workspace 本地配置与目录」
- 文件：`src/web/workspace-config.ts`、`src/web/workspace-config.test.ts`
- 依赖：无

步骤：

1. 定义服务端配置、公开摘要、目录结果和错误类型，固定 workspace 数量、ID 和名称长度上限。
2. 使用现有 `yaml` 严格解析 `orbitcode.workspaces.yaml`，拒绝 alias、重复键、未知字段、重复 ID、空值、非绝对路径和超限配置。
3. 区分配置文件不存在与其他 I/O 失败：仅前者返回启动目录的默认项。
4. 复用 `createWorkspaceBoundary` 规范化和检查目录；列表时形成安全摘要，聊天时按 ID 重新加载与验证，禁止任何回退。
5. 测试正常、缺失、不可读、非目录、重复/超限、从列表到请求间失效，并用哨兵路径/凭据确认错误不泄漏。

验证：

- 运行：`npm test -- src/web/workspace-config.test.ts`
- 期望：退出码 0，所有配置与安全分支通过。

## T2：扩展 Web 合约与 Workspace Catalog API

- 对应：F1、F2、F5、F13，`plan.md` 的「Workspace Web API 与聊天组装」
- 文件：`src/web/chat-contract.ts`、`src/web/chat-contract.test.ts`、`src/app/api/workspaces/route.ts`
- 依赖：T1

步骤：

1. 为 `WebChatRequest` 增加有界的 `workspaceId`，继续使用精确字段校验，拒绝客户端附加路径或 cwd。
2. 增加 Workspace Catalog 响应类型及浏览器端运行时解析，验证默认 ID 必须对应唯一的可用项。
3. 实现 `GET /api/workspaces`，加载目录、返回 `no-store` 响应，并把配置错误映射为不含路径的安全错误。
4. 扩展合约测试，覆盖正常目录、不完整摘要、未知字段、超长 ID 和伪造路径。

验证：

- 运行：`npm test -- src/web/chat-contract.test.ts src/web/workspace-config.test.ts`
- 期望：退出码 0，浏览器合约中不存在 workspace 真实路径。

## T3：将 Workspace 选择接入 Agent 组装层

- 对应：F5、F6、F8、F13，`plan.md` 的「Workspace Web API 与聊天组装」和「安全与权限边界」
- 文件：`src/app/api/chat/route.ts`、`tests/web-tool-agent.e2e.test.ts`
- 依赖：T1、T2

步骤：

1. 在聊天 Route Handler 中移除固定 `process.cwd()` 边界，先按请求 `workspaceId` 加载和解析授权项。
2. 将解析出的请求专属 `WorkspaceBoundary` 注入现有 `AgentLoop`，保持 Provider、ModeToolPolicy、AbortController、迭代上限和 SSE 调度不变。
3. 将未知 ID、失效目录和配置失败映射到安全的 400/503 响应，确保错误发生在模型请求与工具副作用之前。
4. 使用两个含同名文件的临时 workspace 扩展 Agent 集成测试，证明读取、搜索、写入、命令与 Plan 拒绝均使用当前边界。

验证：

- 运行：`npm test -- tests/web-tool-agent.e2e.test.ts src/tools/workspace.test.ts src/tools/mode-policy.test.ts src/tools/macos-seatbelt-sandbox.test.ts`
- 期望：退出码 0，双 workspace 不串读、不串写、不串用沙箱，Plan 无副作用。

## T4：以纯 reducer 固定 Web 会话状态机

- 对应：F4、F7、F9、F10、F11、F12，`plan.md` 的「Web 会话状态」与「状态与交互」
- 文件：`src/components/chat-session-state.ts`、`src/components/chat-session-state.test.ts`
- 依赖：T2

步骤：

1. 从 `ChatWorkspace` 现有分散状态中提取不依赖 React 的 `ChatSessionState` 与判别联合 action。
2. 实现 workspace 改变、Provider 改变、清空、模式切换、请求开始/成功/失败/取消和计划执行的原子转换。
3. 保证只有当前 workspace 中最新、成功的 Plan 助手回复可执行；新 Plan 提交、模式改变、会话重置和 workspace 改变均使旧候选失效。
4. 单元测试相同 workspace 重选不重置、Provider/清空保留 workspace、请求期间事件拒绝、失败/取消不生成计划候选。

验证：

- 运行：`npm test -- src/components/chat-session-state.test.ts`
- 期望：退出码 0，每个状态转换的 workspace、Mode、History 和 Plan 不变量均有断言。

## T5：接入 Workspace 目录与可见模式控件

- 对应：F3、F4、F7、F8、F12、F13，`plan.md` 的「Workspace、模式与计划控件」
- 文件：`src/components/workspace-selector.tsx`、`src/components/chat-workspace.tsx`、`src/components/chat-composer.tsx`、`src/components/chat-workspace.test.tsx`、`src/app/globals.css`
- 依赖：T2、T4

步骤：

1. 并行加载 Provider 与 Workspace Catalog，独立保存加载/错误状态，只在两者都可用时允许提交。
2. 在侧栏加入带 label、当前名称、可用性和请求期间禁用状态的 Workspace 选择器，仅把 ID 交给状态层。
3. 将 `ChatWorkspace` 迁移到 reducer，让清空、Provider 和 workspace 切换使用同一状态转换，聊天请求加入当前 `workspaceId` 快照。
4. 在 Composer 中增加键盘可达的 Plan/Do 分段控件，与 `/plan`、`/do` 共用一个转换入口，并明示 Plan 只有三个只读工具。
5. 加入桌面和窄屏样式，确保 focus-visible、原生 disabled、文字截断和错误重试可见。
6. 组件测试断言 workspace 与模式控件的标签、文案和禁用语义，且静态标记中不包含配置路径。

验证：

- 运行：`npm test -- src/components/chat-workspace.test.tsx src/components/chat-session-state.test.ts src/web/chat-contract.test.ts`
- 期望：退出码 0，Workspace 和 Plan/Do 控件契约与状态语义通过。

## T6：完成 Plan 澄清与显式执行闭环

- 对应：F9、F10、F11、F12，`plan.md` 的「状态与交互」第 4–7 步
- 文件：`src/components/chat-workspace.tsx`、`src/components/message-list.tsx`、`src/components/chat-session-state.ts`、对应测试
- 依赖：T3、T4、T5

步骤：

1. 让每次提交捕获明确的 workspace、Provider、Mode 和 History 快照，Plan 成功时记录唯一可执行的助手消息 ID。
2. 为 `MessageList` 增加类型化的执行回调，仅在当前候选上显示“按此计划执行”，请求中、过期、失败或取消时不可用。
3. 点击后校验候选，清除其可重入状态，显示新用户执行消息，并以显式 Do 快照调用和普通提交共用的请求函数。
4. 验证普通多轮 Plan 澄清保持历史与模式，模型文本、工具结果或 Plan 最终停止不会自动执行。
5. 增加快速连续点击、执行前 workspace 切换、新 Plan 请求、SSE 失败和取消的状态测试。

验证：

- 运行：`npm test -- src/components/chat-session-state.test.ts src/components/chat-workspace.test.tsx src/web/chat-handler.test.ts`
- 期望：退出码 0，只有最新成功 Plan 可由一次用户操作转为 Do 请求。

## T7：补齐本地配置示例、文档与整体回归

- 对应：F1、F2、F7–F10、F13，`plan.md` 的「依赖决策」和「验证策略」
- 文件：`orbitcode.workspaces.example.yaml`、`.gitignore`、`README.md`、全部相关测试
- 依赖：T1–T6

步骤：

1. 新增通用的 Workspace YAML 示例并忽略真实本地配置；示例不使用开发者真实用户名或路径。
2. 更新 README 的启动步骤、配置格式、缺失回退、切换重置语义、Plan 只读边界和“按此计划执行”操作。
3. 更新需要显式 `workspaceId` 的旧合约、Route 和 E2E 固定数据，不修改 CLI 工作目录行为。
4. 运行全量单元/集成测试，修复范围内回归，检查无新运行时依赖。

验证：

- 运行：`npm run test`
- 期望：退出码 0，包括 Agent Loop、Provider、工具、沙箱、Web 和 CLI 在内的旧用例全部通过。

## T8：完成静态、构建、浏览器与真实 Agent 验证

- 对应：F1–F13，`plan.md` 的「验证策略」
- 文件：不新增功能文件；只在发现范围内缺陷时修改对应实现或测试
- 依赖：T7

步骤：

1. 依次运行 lint、严格类型检查和生产构建，不通过降低安全校验或放宽类型解决错误。
2. 启动开发服务，使用两个安全临时 workspace 在真实浏览器中检查桌面/窄屏、键盘、焦点、禁用、清空、重载、错误覆盖层和控制台。
3. 检查 Network 请求、DOM、notice 和开发日志，确认不出现 API Key、受保护内容或 workspace 规范路径。
4. 在 tmux 中使用用户已提供且未入库的真实模型配置，执行 Workspace A 选择 → Plan 澄清/计划 → 显式执行 → 写入后读回 → 切换 Workspace B 的闭环，另验证 workspace 失效和取消。
5. 停止浏览器、开发服务、tmux 会话和子进程，清理测试临时目录，按 `checklist.md` 记录实际证据。

验证：

- 运行：`npm run lint`
- 运行：`npm run typecheck`
- 运行：`npm run build`
- 可观察：真实浏览器和 tmux Agent 闭环完成，并无遗留进程、临时文件或敏感输出。

## 执行顺序

```text
T1 → T2 → T3
      └─→ T4 → T5 → T6
                    └────┘
                           ↓
                          T7 → T8
```

T3 与 T4 在 T2 完成后可并行；T5 依赖合约和 reducer，T6 再合并服务端与 UI 链路。本任务清单不包含提交、推送、PR 或部署操作。
