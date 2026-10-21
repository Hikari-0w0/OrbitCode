# 全运行时移除人工审批（2026-10-22）

## 授权与当前行为

用户要求删除人工审批，并明确选择“主Agent和子Agent都移除”。本次覆盖Web、CLI、前后台子任务、独立Skill和MCP连接/调用。本文替代同日较早的子任务审批生命周期方案，历史报告与原始失败记录保留。

运行时现在只进行规则判断：允许则直接执行，拒绝则返回结构化失败，不再生成审批等待、人工决定或自动批准事件。Plan、角色/Skill工具能力、工作区真实路径与敏感文件保护、危险命令规则、显式deny、取消、时限、预算及执行前复检继续生效。

旧ask规则兼容为allow，旧strict/default/permissive配置仍可读但不改变执行策略；不自动改写用户配置。旧mode更新接口只保留元数据兼容，UI已移除模式选择。历史事件/schema仍可读取，历史审批卡仅展示安全摘要；旧决定HTTP接口返回410，CLI批准命令不能产生授权。单次JSON的approvalBlocked字段兼容保留为false，completed仍只表示运行正常结束。

## 架构调整

- `PermissionEvaluation`、`PermissionAuthorization`收敛为允许/拒绝两态，删除Gateway的broker、canPrompt、persistAllow和人工/会话确认分支。规则评估器统一处理旧ask兼容，避免各入口自行模拟批准。
- `scheduleToolCalls`和MCP初始化删除审批暂停与恢复分支，继续按原目标及指纹执行前复检，批量写入检查所有目标后才开始执行。
- 子权限组合父接纳快照、当前规则及Plan约束，不再创建子审批会话。任务执行接口不再带prompt/decide，前后台仅影响等待和投递。
- Web去除审批模式、批准按钮、授权横幅、决定回调与子任务待审批计数；CLI删除批准交互和非交互审批阻塞，旧事件仅显示只读历史提示。PermissionSessionManager保留会话绑定及旧低层记录兼容，新Agent执行不调用broker.request。
- 删除旧审批模式控件和旧审批真实评测入口，新增无审批真实评测脚本；README、示例规则、当前规格和评测用法同步。

未增加运行时依赖，未改写用户配置，未提交、推送或部署。

## 验证过程与自动回归

先固定默认非交互父/子“写文件＋执行命令”的两个端到端场景：旧实现2/2失败，改动后通过。审批移除涉及原测试的行为契约变化，原先的人工允许/拒绝测试迁移为直接执行、显式deny、取消及复检测试；并保留独立的旧规则/会话解析测试。

最终完整回归 **792/792通过**，0失败、取消或跳过。覆盖：

- 默认配置父与内置general在非交互运行中直接写入、执行真实本地命令；显式后台、自动后台、手动后台、wait超时保持同一任务和原截止时间。
- 显式deny、Plan、危险命令、越界、受保护配置、批量目标拒绝、动态撤权、完整指纹变化和权限配置读取失败继续阻止执行。
- 独立Skill执行、资源变化检查、父取消真实受管进程、CLI单次JSON/JSONL、MCP连接及调用、配置变化和会话持久化。
- Web SSE不产生新审批事件，工具正文不泄漏到展示事件；旧ask不等待，也不自动持久化允许规则。
- 旧决定接口410且同源检查有效，历史卡无按钮，终端历史事件不再指导用户发送/approve命令。

迁移期间的失败输出原样保留：旧审批断言、冗余/permissions调用、两个尚未迁移的Skill场景、旧控件导入、样例规则预期，以及新增历史事件夹具缺少name导致的类型错误。这些中间输出不充当固定源码版本的对照基线；最终完整检查在修正后重新执行。没有通过放宽deny或工作区限制使测试通过。

最终lint、typecheck、build通过，git diff --check通过。构建仍有9条既有动态文件跟踪警告。

## 真实模型与浏览器

使用项目配置deepseek-flash，全部在隔离Workspace和数据目录运行。自动评测经tmux启动；实际模型API、文件、命令、Web HTTP/SSE和浏览器均真实运行。本地MCP使用可控stdio协议夹具，不代表公网服务兼容性。

| 样本 | 原始结果与依据 |
| --- | --- |
| CLI主Agent直接开发 | 通过；真实创建购物车与测试文件并执行命令，额外Node断言与node:test退出0，无子任务与审批 |
| Web前台general | 通过；default父/default内置角色，父工具只有agent；子实际开发，独立验收退出0，无审批 |
| Web后台general | 通过；同上，后台直接执行文件与命令，无父接管 |
| Web显式deny | 通过；真实permission-denied，blocked.txt不存在，不申请批准或换工具绕过 |
| CLI独立Skill | 通过；独立执行实际write_file和run_command，标记文件精确一致，父收到实际Skill工具结果，无审批 |
| Web MCP首次 | 失败；夹具只写旧YAML，而Web托管配置mcpServers为空，未发现工具，未发生MCP调用 |
| Web MCP第二次 | 失败；托管配置修正后Server确实ready；模型先传Fork background=false被拒绝，恢复时擅自增加general角色，角色白名单过滤MCP。无实际MCP工具调用，不能判通过 |
| Web MCP新样本补测 | 通过；提供完整合法Fork创建参数，background=true且无role；父仅agent，子实际echo调用，协议日志initialize/tools/list/tools/call各1，无审批 |
| 实际开发服务器浏览器父子执行 | 通过；主先写parent.txt，后台内置general写child.txt并执行node --version，标记精确、退出0、failureCount0；结果正文可读取，工作环境中无审批模式与批准按钮，页面errors为空，console仅开发信息 |

**原始分布：9次真实模型尝试，7通过、2失败；6类脚本场景最终均有通过样本，另有浏览器通过样本。** 两个失败未覆盖或删除：第一个是夹具配置问题，第二个是模型创建参数/角色选择失败。MCP补测只调整配置和明确测试输入，没有修改运行时能力或扩大general白名单。审批移除不能保证模型永远选对角色或完成所有自然语言任务。

本轮没有自动作出人工批准决定；评测也不通过预设宽松general角色模拟成功。所有模型工具日志均检查没有tool.authorization人工等待记录，Web流没有permission-requested/resolved。

## 复现与证据

```bash
node --import tsx --test tests/approval-free.e2e.test.ts tests/sub-agents-permissions.e2e.test.ts src/tools/permission-gateway.test.ts
npm run lint
npm run typecheck
npm run build
node --import tsx scripts/run-approval-free-real-evals.ts --allow-real-model --root=tmp/agent-evals/approval-free-new
```

真实评测需要当前生产构建、可用项目模型配置和新输出目录，可用--cases缩小场景。旧run-sub-agent-permission-real-evals.ts已退役。

本地忽略证据目录 `tmp/agent-evals/approval-removal-20261022/`：before.txt、tests-complete.txt、lint/typecheck/build-complete.txt、all-results.json、real及MCP两个补测目录、browser快照/原生日志与独立产物、cleanup-verification.json、mcp-cleanup-verification.json、verification.json。原始输出含运行正文，不能提交。

7个自有Web服务的PID均已退出且端口关闭，2个实际MCP stdio进程退出，测试浏览器关闭；用户原有3000端口服务未停止。当前模型凭据精确匹配扫描在本轮证据和src/scripts/docs/README文本中为0命中，排除符号链接、node_modules和.next；这不是全机凭据审计。

用户复测应重启服务并新建任务；旧运行中的闭包不保证热替换为新策略。服务重启不恢复后台任务，本轮未新增持久后台执行或跨进程隔离。
