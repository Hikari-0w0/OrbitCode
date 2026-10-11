# MCP 客户端 Plan

状态：已批准
依据：[已批准的 spec.md](spec.md)。用户已统一批准四份文档并授权开始开发；真实 Provider 验证使用 tertiary。

## 架构概览

协议放在独立的 `src/mcp/`，只依赖 Node.js 标准库及协议自身类型，不依赖工具、运行编排或展示层。`src/runtime/` 加载配置、取得连接授权、管理连接生命周期；`src/tools/` 将已发现工具适配为现有 Tool，并接入权限网关。Web 与 CLI 注入各自宿主拥有的同一种连接管理器，不共享跨进程连接。

当前 `AgentRuntime.prepare()` 在 Web 返回 SSE Response 之前运行，而审批通过 SSE 呈现。不能在 prepare 中等待 MCP 审批。保留 prepare 的请求、会话、工作区与修订校验，将 MCP 初始化放入 `runAgentTurn()` 消费的惰性初始化生成器：先建立事件流，再产生初始化审批，再创建带 MCP 工具的 AgentLoop。

```text
Web SSE / CLI renderer
        ↑ 初始化事件、审批、Agent 事件
runAgentTurn → AgentRuntime → McpConnectionManager → src/mcp
        ↓                          ↓ 授权后取得工具快照
    AgentLoop → ToolRegistry → MCP Tool Adapter → 已授权连接
                    ↓
             PermissionGateway → PermissionApprovalBroker
```

## 需求映射

| 需求 | 负责模块／交互 | 设计落点 |
| --- | --- | --- |
| F1、F2 | runtime/mcp-config | 两层加载、整项覆盖、环境展开、逐 Server 错误 |
| F3 | runtime/mcp-initialization、权限网关 | 建连前独立授权与执行前配置复检 |
| F4 | mcp/stdio-transport | 有界按行解码、直接 spawn、进程释放 |
| F5 | mcp/http-transport、sse | POST JSON／SSE、GET 通知流、会话头、关闭 |
| F6 | mcp/rpc-peer、messages | 消息校验、pending map、取消、超时、错误 |
| F7 | mcp/client、runtime/mcp-connections | 协商、完整分页、版本化工具目录 |
| F8、F9 | tools/mcp-tool、mcp-json-schema | 命名、Tool 适配、受限 Schema 校验 |
| F10 | tools/mcp-result | 内容转换、结构化错误、副作用状态 |
| F11、F12 | core/permissions、tools/permission-gateway、双端审批 | MCP 目标、独立规则、审批复检、Plan 禁止 |
| F13 | runtime 事件与记录、现有上下文及会话存储 | 安全元数据、初始化记录、结果压缩、历史兼容 |
| F14、F15 | runtime/mcp-connections、mcp-host | 并发初始化去重、租约、失效、故障隔离与退出 |

## 配置契约

用户级为 `~/.orbitcode/mcp.yaml`，项目级为 `<workspace>/.orbitcode/mcp.yaml`。两者根节点均只接受 `mcpServers` map，文件不存在等价于空 map；根节点空值或 YAML 错误不是空配置。项目路径以已授权工作区的真实路径为基准，不以 Web 进程 cwd 代替。

```yaml
mcpServers:
  local-demo:
    type: stdio
    command: node
    args: [./scripts/mcp-demo.mjs]
    env:
      DEMO_TOKEN: ${DEMO_TOKEN}
  remote-demo:
    type: http
    url: https://example.com/mcp
    headers:
      Authorization: Bearer ${DEMO_TOKEN}
```

此示例只说明格式，不承诺仓库已有 demo 脚本。stdio 的 args、env 和 HTTP 的 headers 可省略，分别默认为空数组与空 map；type、command／url 必填。Server 名使用 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`。拒绝未知字段、重复键、YAML alias、非字符串参数或 map 值、NUL、HTTP header 换行与非法 header 名；header 名按不区分大小写去重。

先按 Server 名选中整项，再校验与展开，只展开选中项的 env／headers 字符串；不递归展开，也不解释 shell 表达式。变量语法为 `${[A-Za-z_][A-Za-z0-9_]*}`，未定义时报字段级错误，已定义空字符串保留。环境来源使用共用运行环境已加载的服务端 Environment，不从浏览器接收环境变量。

HTTP 仅接受 http／https，拒绝 URL userinfo、fragment；审批显示 origin、脱敏路径，隐藏 query 值。禁止用户覆盖 Host、Content-Length、Connection、Accept、Content-Type、MCP-Session-Id、MCP-Protocol-Version。凭据应放 env／headers，不放 command、args 或 URL；已知秘密仍须在任何摘要中脱敏。

逐项错误只禁用对应 Server。用户级整文件无效时忽略用户层但仍可使用有效项目层；项目级整文件无法解析时，因无法确定覆盖名称，关闭该工作区全部 MCP，保留本地工具。无效项目同名项不能回落到用户项。

项目 mcp.yaml 默认加入 `.gitignore`，提供可入库的 `mcp.example.yaml`。将真实配置加入本地工具受保护路径；用户应在编辑器修改，不能由 Agent 越过配置保护。复用两层格式，不新增第三层 MCP 配置。

## 核心类型与接口

以下为设计契约，不是本轮实现代码；已有类型只列扩展部分。

```ts
type McpServerConfig =
  | { readonly type: "stdio"; readonly command: string;
      readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> }
  | { readonly type: "http"; readonly url: string;
      readonly headers: Readonly<Record<string, string>> };

type McpRequestOptions = { readonly signal: AbortSignal; readonly deadlineMs: number };
interface McpTransport {
  start(handlers: McpTransportHandlers, signal: AbortSignal): Promise<void>;
  send(message: McpMessage, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
interface McpClient {
  initialize(options: McpRequestOptions): Promise<McpServerInfo>;
  listTools(options: McpRequestOptions): Promise<readonly McpToolDefinition[]>;
  callTool(name: string, argumentsValue: McpJsonObject,
    options: McpRequestOptions): Promise<McpCallResult>;
  close(): Promise<void>;
}

type McpToolName = `mcp__${string}`;
type ToolName = LocalToolName | McpToolName;
type McpPermissionTarget = {
  readonly kind: "mcp";
  readonly operation: "connect" | "call";
  readonly serverName: string;
  readonly configurationId: string;
  readonly toolIdentity?: {
    readonly originalName: string;
    readonly schemaId: string;
    readonly argumentsId: string;
  };
};

type McpConnectionState =
  | "idle" | "connecting" | "ready" | "failed" | "draining" | "closed";
interface McpWorkspaceLease {
  readonly tools: readonly RegisteredTool[];
  release(): Promise<void>;
}
interface McpConnectionManager {
  acquire(input: AuthorizedMcpConnectionInput): Promise<McpConnectionLease>;
  invalidate(workspaceRoot: string, serverName: string): Promise<void>;
  close(): Promise<void>;
}
type RuntimeInitializationEvent =
  | { readonly type: "runtime-permission-requested"; readonly prompt: PermissionPrompt }
  | { readonly type: "runtime-permission-resolved"; readonly requestId: string;
      readonly status: PermissionResolutionStatus }
  | { readonly type: "mcp-status"; readonly serverName: string;
      readonly phase: "connecting" | "ready" | "unavailable";
      readonly detail: string };
```

`McpMessage` 是经过校验的 request／notification／success／error 判别联合；`McpJsonObject` 为协议自有 JSON 类型，不能从 tools 反向导入。`McpTransportHandlers` 提供消息及断开回调；`AuthorizedMcpConnectionInput` 是运行层内部能力对象，绑定有效配置与当前权限会话，只能由初始化授权流程创建，配置加载不能生成它。类型约束不替代运行时复检。

`ToolMutability` 新增 `external`，使调度器串行执行并采用外部调用超时，不伪装为文件写入或本地命令。`LocalToolName` 保留原固定联合；`mcp_connect` 只作为运行时授权操作名称，不加入模型工具列表。

## 模块设计

### 协议与双传输

`messages.ts` 校验 JSON-RPC 外壳及各方法结果；id 使用单连接内递增安全整数，数字与字符串 id 分开比较，不复用旧 id。消息不得同时包含 result 与 error，拒绝 batch；错误只输出类型与安全摘要。单条畸形协议消息使对应连接 failed，清空全部 pending，避免继续使用不同步的 stdio 流。

`rpc-peer.ts` 拥有 pending map、计时器和 AbortSignal listener。登记请求后发送，发送失败也清理；以“尚未发送／可能已发送”跟踪副作用。通知不占 pending，未知通知忽略且不打印原文。支持响应服务端 ping（被动响应，不主动做健康检查）；其他未实现的服务端方法返回 -32601。不接受服务端提出的采样、文件访问或授权请求。

stdio 用 `spawn(command, args, { shell: false, cwd: workspaceRoot, env })`。默认只继承 PATH、HOME、TMPDIR、LANG、LC_ALL（存在时），配置 env 显式覆盖；最终环境计入配置身份。stdout 增量 UTF-8 解码并按 LF 分帧；stderr 持续排空但不记录原文。关闭 stdin 后等待 1 秒，未退出则 SIGTERM，再等 1 秒后 SIGKILL 并等待回收。macOS／POSIX 对本轮启动的进程组清理，不按名称扫描其他进程；逃离进程组的恶意后台程序不在通用沙箱承诺内。

HTTP 用标准 fetch，`redirect: "error"`，每条消息独立 POST。SSE 解码器处理分块、CRLF、多行 data、注释、空 data 与结束边界；传输拥有每个请求的 reader/controller。初始化后尝试一次独立 GET，405 表示无独立通知流，其他断流标为 failed；不轮询。收到对应请求响应即可释放该 POST 流，GET 流不能完成当前 POST 的响应。会话 id 仅保存在服务端连接对象，所有后续请求携带相应会话与版本；DELETE 清理允许 405。

协议细节按 [MCP 传输规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)实现。本轮按已批准范围不恢复 SSE 或自动重建失效会话，因此不宣称完整覆盖其恢复行为；404 后连接终止，只有用户重新初始化应用或变更配置，才经授权开启新会话，绝不重放原调用。

取消普通请求时尽力发送 `notifications/cancelled`，通知自身最多等待 1 秒；清理不等待对端确认。取消 initialize 通过关闭连接实现，不发取消该请求的通知。依据 [MCP 取消规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation)。

### 初始化与工具目录

只声明本轮实际实现的客户端能力，initialize 请求使用 `2025-11-25`，接受同版本且工具能力有效的响应，再发送 initialized。忽略 Server instructions，不拼接进系统提示词。工具分页累积到临时集合，全部成功后发布不可变快照；重复原始工具名、重复 cursor、过量页数为该 Server 发现失败。

输入 Schema 不支持时仅跳过该工具并记录安全原因；这是明确的适配拒绝，不等同于分页中途失败。工具需异步 tasks 才能运行时拒绝注册；兼容普通 tools/call 的工具照常使用。结果及目录外壳不合法属于协议错误。

list_changed 只标记 dirty，不在通知回调里循环请求。下次已授权 Do 回合刷新；同连接刷新合并为一个 promise，新快照只用于后续回合。正在审批或执行的调用继续绑定旧快照，不因列表变化自动换成新定义。刷新失败不向新回合暴露旧目录，旧调用允许自然结束；连接进入 failed 后不自动重试。

### 命名与参数校验

模型名称采用 `mcp__<server前12位规范名>__<tool前12位规范名>__<24位摘要>`，摘要来自原始 Server 与工具名的稳定编码，最长 59 个 ASCII 字符。保留完整映射；同模型名映射到不同原始身份时显式拒绝冲突，不静默覆盖。列表顺序不影响名称，配置变化不改变名称但改变授权身份。

已有 `tools/schema.ts` 是手写本地工具 Schema 构造器，不能直接解释任意外部 JSON Schema。本轮新增专用有界解释器，**不声称支持完整 JSON Schema**。默认及显式方言仅接受 2020-12；根必须为 `type: object`。支持范围如下，所有关键字及值先进行 Schema 自身校验。

| 类别 | 支持内容 |
| --- | --- |
| 类型与相等 | type（单值或非空去重数组）、enum、const；有限 JSON 数值、结构深比较 |
| 对象 | properties、required、additionalProperties（布尔或 Schema）、minProperties、maxProperties |
| 数组 | items（Schema）、minItems、maxItems、uniqueItems |
| 字符串 | minLength、maxLength，按 Unicode code point 计数 |
| 数值 | minimum、maximum、exclusiveMinimum、exclusiveMaximum；integer 不进行字符串转换 |
| 组合 | allOf、anyOf、oneOf、not，受统一访问预算约束 |
| 引用 | `$defs`、仅文档内 `#/$defs/...` 的 `$ref`，支持 JSON Pointer 转义；拒绝循环引用，兄弟关键字仍参与校验 |
| 注释 | title、description、default、examples、deprecated、readOnly、writeOnly、`$comment`；校验类型但不改变输入或授权 |

其余关键字一律拒绝，包含 pattern、patternProperties、format、multipleOf、if／then／else、unevaluated*、远程 `$ref` 和自定义方言。不在 Node 主线程执行来自外部的任意正则，不联网解析引用。支持的组合须遵循原语义，不能因其他关键字未支持就忽略；不填默认值、不删额外属性、不强制类型转换。数值与字符串语义参照 [JSON Schema validation](https://json-schema.org/draft/2020-12/json-schema-validation)。

编译时固定原始 Schema 与 schemaId，准备调用时复制并深冻结 JSON 参数，再验证与生成 argumentsId；批准后的 execute 使用同一份值。输出 Schema 在同一子集内则校验 structuredContent，不符合时返回协议错误；不支持的输出 Schema 仅标注未验证，不宣称已验证输出，也不影响输入校验严格性。输入 Schema 含已知配置秘密时拒绝注册，不通过修改约束来“脱敏”。

### 权限与 Plan Mode

扩展 `ToolPermissionTarget`、`PermissionSubject` 和 `PermissionTargetKind`，新增 `mcp`，目标含 operation、serverName、configurationId；call 额外含原始工具、schemaId、argumentsId。摘要明确外部访问不受本地文件沙箱保证，显示脱敏参数、传输与目标，不把 MCP 路径参数当成本地 WorkspaceBoundary 已验证路径。

沿用现有“操作名(模式)”规则语法，新增两个固定规则入口 `mcp_connect`、`mcp_call`。二者为规则名称，非模型工具：外部调用 prompt.toolName 仍是实际模型工具名，规则匹配通过独立映射到 mcp_call。将这两个入口加入规则解析的固定目标表，避免 Server 离线或工具未发现时，历史 MCP 规则被误判未知工具而阻断本地工具。

规范目标字符串为 `server/<编码名称>/config/<configurationId>`；调用追加 `/tool/<编码原名>/schema/<schemaId>/args/<argumentsId>`。名称逐段编码，编码包括 glob 元字符和分隔符。configurationId 为有效传输配置、最终 stdio 环境、真实 workspace root 的规范序列化 SHA-256；只持久化摘要，不记录计算输入。schemaId 包括工具名、描述、Schema 和影响调用语义的元数据。具体工具的“本会话／永久允许”默认只覆盖该配置、定义与参数；手写 MCP glob 才显式扩大范围。

规则合并仍为 deny > ask > allow；MCP 无匹配规则在所有权限模式默认 ask。既有 run_command 或 path 规则不匹配 MCP。启动与调用各检查自己的规则：手写永久工具允许不能省略连接授权。授权后在实际发起连接／调用前重新加载配置与规则；已出现配置身份变化或 deny 时拒绝发送，不替换目标后继续。

连接操作用独立运行时授权方法复用 PermissionGateway 的评估、broker、持久化和复检内核，不伪造模型 ToolCall。每权限会话只保留一个 pending，Server 审批按配置名稳定顺序串行提出。连接“本次允许”作用于当前回合持有的租约；跨轮缓存可以保持物理连接，但新的回合／会话仍检查授权，不能拿旧租约调用。工具“本次允许”只覆盖该 PreparedToolCall。

Plan 不创建或刷新 MCP 连接，不取得外部工具租约，模型工具列表不包含 MCP；模式策略与网关分别拒绝 external。所有外部工具均为 external，annotations 不降低风险。初始化连接可能已启动进程，因此即使随后调用被拒绝，本轮总体副作用仍至少为 possible。

### 连接缓存与宿主生命周期

缓存 key 为 workspace 真实路径、Server 名、configurationId。条目保存状态、初始化 promise、client、目录版本及引用计数；授权不放进共享条目。每个调用持有当前回合租约与发送前复检器。配置快照读取每回合一次，并在授权后及发请求前复检，配置文件变更无需文件 watcher。

`idle → connecting → ready`；握手或传输故障进入 failed，保留同 key 故障记录，后续回合只报告不可用，不重启。配置变化使旧条目 draining，禁止新调用，当前已发送调用自然完成；引用计数清零后关闭。拒绝授权只影响该会话／回合，不把共享连接标为 failed。

同 key 并发初始化由 manager 的独立 controller 持有；一个等待者取消只撤销自身租约，最后一个等待者取消才中止尚未成功的初始化，避免关闭其他会话的连接。成功 ready 在零引用时保留以供后续回合复用；超出容量只淘汰零引用的 ready 条目，不主动淘汰 failed 后重试。

`AgentRuntime.close()` 关闭宿主拥有的 manager。CLI 顶层 finally await close，不能只同步 session.close。Web 用 `mcp-host.ts` 的进程级单例与幂等 SIGINT／SIGTERM 清理注册，兼容开发热重载重复加载；模块加载只创建惰性管理器，不读取或启动 Server。退出采用最多 5 秒的有界关闭，尊重宿主信号退出语义，不吞掉退出；不用异步 process exit listener 假装完成清理。必须实际验证生产 Next.js 子进程收到信号后的清理，不将设计视为保证。

### 运行事件、结果与持久化

`PreparedAgentTurn` 扩展为互斥的“直接 agent”或“初始化生成器”输入，保持当前直接传 AgentSession 的测试入口。初始化生成器 yield RuntimeInitializationEvent，return `{ agent, lease, startupSideEffect }`。`runAgentTurn` 在建立 tracker 后消费它，再调用 AgentLoop；其 finally 无论初始化成功、拒绝、异常或取消都释放租约、权限 turn 与会话操作。回合标记在可产生外部副作用之前落盘。

初始化事件添加到 RuntimeTurnEvent 与 WebChatEvent，双端复用同一 PermissionPrompt 和 decisions API；不使用 iteration=0 的假工具事件。启动审批不计入模型轮数和工具完成证据。初始化取消仍产生 stopped 与持久化结果，合并 startupSideEffect，避免已启动 Server 却报告 none。maxRuntime 从运行初始化开始统一计时，将剩余预算传入 AgentLoop；人工审批沿用现有 TTL，不能让多个 Server 的串行等待无限延长回合。

MCP Tool 结果输出保存 `{ serverName, toolName, content, structuredContent?, outputValidation? }`。文本和嵌入的文本作为数据；图片、音频、二进制资源、未知内容保存类型／mime／原始尺寸与未展示说明，不保存 base64，不跟随链接。文本资源不意味着开放 resources/read。正常返回及 Server isError 在请求已发送时均使用 possible；发送前的参数错误／权限拒绝为 none，发送后取消／超时不能回滚。

新增 `mcp-transport`、`mcp-protocol`、`mcp-tool-error` 错误 kind，保持 timeout、cancelled、invalid-arguments 等已有分类；同步 Web 严格解析器和持久化校验。工具错误保留脱敏的可操作内容，协议／网络异常不透传底层 message、stack、response body。工具错误允许模型调整参数后再作新调用，传输自动重试始终关闭。

已知配置秘密在描述、结果和状态进入事件、模型上下文、日志之前统一替换；错误不携带原始 env／headers。HTTP 会话 id、非安全 headers 和 stderr 不进入可见数据。结果达到预览阈值后复用现有 ContextManager 的工具结果压缩与 read_context 引用；低于硬上限的脱敏文本仍可在完整记录中取回，超过硬上限返回 limit-exceeded，不能声称完整结果已保存。

AgentRunTracker 与本地 run log 增加可选 MCP 身份和独立初始化摘要，不记录参数值或秘密。会话展示增加可选初始化记录（审批状态、Server 状态、耗时），不混进模型消息／工具调用配对。同步 conversation types、validation、display-timeline、导出与 Web contract；新增字段读取时可缺省，日志写新版本、保留旧版本读取，禁止用放宽任意字段校验代替迁移。

## 资源限制与错误分类

| 边界 | 本轮默认硬上限／超时 |
| --- | --- |
| 每层配置／合并 Server 数 | 256 KiB／32 个 |
| command、URL、单 env/header 值／args | 4 KiB、8 KiB、16 KiB／128 项，每项 4 KiB |
| 单消息／SSE 未完成事件／单结果 | 各 2 MiB UTF-8；按实际读取字节计数 |
| 初始化／完整分页发现 | 各 10 秒绝对 deadline，不能逐页重置 |
| 工具调用／关闭／取消通知 | 60 秒／5 秒／1 秒，均不超过回合剩余预算 |
| 单 Server／单工作区工具数 | 128／256 个；溢出目录不发布 |
| 每 Server 分页数／pending 请求 | 32 页／32 个 |
| 单输入 Schema／深度／节点数 | 64 KiB／32 层／4096 节点 |
| 单次校验访问预算／issues | 100000 次／20 条，超限明确拒绝 |
| 参数 | 不超过已有 MAX_TOOL_ARGUMENTS_JSON_CHARS，同时受校验深度与访问预算限制 |
| 工具描述／工作区定义总量 | 每工具 4 KiB／512 KiB；仍计入模型上下文预算 |
| 宿主缓存 | 最多 128 个配置条目；无可淘汰条目时仅拒绝新连接 |

目录容量超过上限时报告该 Server 无法注册，保留先前已完成注册的其他 Server 与本地工具；顺序按 Server 名稳定确定。业务工具错误不关闭连接；传输／协议失败使连接 failed；权限拒绝不损坏连接；本地校验失败不发请求。所有诊断均使用有限的错误代码与安全描述。

## 文件组织

| 新建／修改 | 文件 | 职责 |
| --- | --- | --- |
| 新建 | `src/mcp/{types,messages,rpc-peer,stdio-transport,http-transport,sse,client}.ts` | 独立协议、传输与能力协商 |
| 新建 | `src/runtime/{mcp-config,mcp-connections,mcp-initialization,mcp-host}.ts` | 配置、生命周期、授权初始化与退出 |
| 新建 | `src/tools/{mcp-tool,mcp-json-schema,mcp-result}.ts` | 工具适配、参数与结果 |
| 新建 | `src/lib/mcp-redaction.ts` | 已知秘密过滤与安全摘要，协议层不依赖此模块 |
| 修改 | `src/tools/{types,registry,default-registry,mode-policy,permission-target,permission-gateway,permission-config,protected-paths}.ts` | 动态名字、外部目标、冻结准备值、规则与保护 |
| 修改 | `src/core/permissions/{types,rules,evaluator,approval}.ts` | MCP 权限领域与通用审批内核契约 |
| 修改 | `src/runtime/{agent-runtime,run-agent-turn,types,permission-session-manager,agent-run-tracker}.ts` | 惰性初始化、scope、事件与记录 |
| 修改 | `src/core/{agent-loop,tool-scheduler}.ts` | 剩余总预算、external 调度与超时 |
| 修改 | `src/core/conversations/{types,validation,display-timeline}.ts`、`src/lib/local-agent-run-log.ts`、`src/lib/local-conversation-exporter.ts`、`src/lib/local-agent-run-exporter.ts` | 新记录与旧数据兼容 |
| 修改 | `src/web/{agent-runtime,chat-handler,chat-contract}.ts`、`src/app/api/chat/route.ts` | 宿主注入、流建立与事件校验 |
| 修改 | `src/components/{chat-workspace,permission-request-card,message-list}.tsx`、`src/components/chat-session-state.ts` | 展示初始化和复用审批 |
| 修改 | `src/cli/{main,renderer,session-controller}.ts` | 流式初始化事件、终端审批、await 退出 |
| 新建／修改 | 对应 `*.test.ts`／`*.test.tsx`、`tests/fixtures/mcp/`、`tests/mcp-e2e.test.ts` | 协议替身、行为与双端集成验证 |
| 新建／修改 | `.orbitcode/mcp.example.yaml`、`.gitignore`、`README.md` | 安全示例、忽略本地配置与用户说明 |

不预先创建空模块；若相邻小模块可合并，只允许不改变职责与公开行为的机械调整，并同步文件清单。

## 依赖决策与取舍

本轮零新增运行时依赖。使用现有 yaml、Node child_process、crypto、streams 与 fetch。MCP 协议与 Agent 接入自行实现，不引入 MCP SDK 或 Agent 框架。Schema 解释器严格限制能力，换取可说明、可测试且无需新依赖的边界。

| 决策 | 采用方案 | 代价与未采用方案 |
| --- | --- | --- |
| Schema | 有界子集，不支持即拒绝 | 部分真实 Server 无法接入；完整 Ajv 支持会增加运行时依赖与外部 Schema 资源治理，本轮不选 |
| 审批时机 | 事件流建立后初始化 | 扩展 runtime 事件；prepare 中阻塞审批会死锁，不选 |
| 连接生命周期 | 宿主缓存＋回合授权租约 | 需要引用计数；每轮重启与全局共享授权均不满足规格 |
| HTTP 恢复 | 报错、等待显式新初始化 | 不支持需 SSE 恢复的服务；不通过自动重放掩盖失败 |
| 外部风险 | external，Plan 禁用 | 暂不支持外部只读工具进入 Plan；不信任 annotations 作为授权证据 |

## 验证策略

按 [task.md](task.md) 逐层测试：本地可控 stdio／HTTP Server 记录请求次数，检验“不得发送／不得启动”等负向证据；脚本 Provider 验证完整 Agent 编排、错误和上限，不依赖真实 API Key。双端集成覆盖启动审批可见性与同一工具执行链。

浏览器在开发服务器验证审批、拒绝、取消及错误展示；CLI 在 tmux 验证真实进程与审批交互，测试数据全部为临时工作区与假凭据。外部真实模型不在自动测试中调用；没有实际执行的真实模型验收明确标为未验证。退出场景另以生产 Next.js 与 CLI 子进程检查，不以单元测试中的 close() 成功替代宿主信号验证。

最后依次执行 lint、typecheck、build，并核查 [checklist.md](checklist.md) 的证据；只维护本功能四文档与授权范围内实现，不包含提交或推送。

## 实施对照（2026-09-19）

按本计划落地，未新增运行时依赖。初始化事件类型放在 `src/core/mcp-events.ts`，避免 Web 契约依赖运行层实现；HTTP／Provider 测试替身复用已有辅助模块。运行层在每个 Do 回合同步有效配置，删除配置也会使旧连接进入 draining；宿主退出时异步释放连接，并以同步进程组终止兜底处理 Next 提前退出。Web 审批状态以服务端终态为准，忽略迟到的提交状态。

MCP 运行记录使用 schemaVersion 5，原工具身份放在工具日志的 `mcp` 字段；历史版本仍可读取。最终测试和双端实测证据见 checklist，不把外部工具成功提升为本地完成验证证据。
