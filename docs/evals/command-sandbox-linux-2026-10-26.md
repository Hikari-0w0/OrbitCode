# 跨平台命令沙箱：PR 前验证（2026-10-26）

## 结论与范围

本次 Linux 支持及跨平台安全修复已通过下述功能回归，可作为功能 PR 提交。macOS 主动脱离进程组的后代回收不作保证，Linux 文件遮蔽基于启动时快照；PR 必须保留这些边界，不能声称能完全隔离任意恶意代码。

代码基线为 `8865aedab2e263b4c288138357de2d8c555e4113`，验证针对该基线上的本PR源码改动。新增 Linux bubblewrap 后端、平台工厂、共用文件扫描、命令预算和进程收尾，接入 Web、交互/单次 CLI；子执行继承同一沙箱。默认保留联网、依赖安装、编译测试和开发服务，没有新增 npm 依赖或命令白名单。

未开展 SWE-bench 选题或判分，未调用真实模型。CLI 测试使用本地 OpenAI 协议替身与真实 CLI 子进程，不代表真实模型修复能力。安装条件和保护边界见[使用文档](../command-sandbox.md)。

## 最终检查

| 环境 / 检查 | 结果 |
| --- | --- |
| macOS arm64 全仓，公网补测独立运行 | 862项：846通过，16项按平台/公网开关跳过，0失败 |
| Linux arm64，Debian 12 / Node 24.19.0 / bwrap 0.8.0 | root 28通过；UID/GID 1000:1000 28通过；禁止namespace 1通过，合计57次通过 |
| Linux amd64，Debian 12 / Node 24.22.1 / bwrap 0.8.0，ARM Mac上的Docker仿真 | root 28通过；UID/GID 1000:1000 28通过；禁止namespace 1通过，合计57次通过 |
| macOS 合成环境、链接、联网等扩展用例，含公网 | 14项通过；另有原生父进程环境正反对照用例在全仓中通过 |
| lint → typecheck → build | 按顺序通过 |
| git diff --check | 通过 |

每个 Linux 正向组均显式跳过仅用于禁止 namespace 场景的反向用例，该用例之后以专用 seccomp 策略单独通过；跳过不算通过。macOS 全仓的16个跳过项包含15个Linux用例与1个公网开关用例，分别由独立矩阵与macOS显式公网补测补足。amd64 是 Docker 仿真结果，未在独立原生 amd64 主机上复测；不是所有发行版或内核策略的兼容性声明。

Docker 正向验证容器明确允许嵌套 namespace 和 proc 初始化，未使用 privileged 或挂载 Docker socket。反向测试显式禁止 user namespace，不依赖某版 Docker 的默认策略。其他运行中的应用容器未被停止或修改。

执行入口：

```bash
npm test
ORBITCODE_SANDBOX_PUBLIC_NETWORK_TEST=1 npm test -- src/tools/sandbox-security.test.ts
npm run lint
npm run typecheck
npm run build
ORBITCODE_SANDBOX_PUBLIC_NETWORK_TEST=1 npm run test:linux-sandbox -- orbitcode-sandbox-test:20261026
ORBITCODE_SANDBOX_TEST_PLATFORM=linux/amd64 ORBITCODE_SANDBOX_PUBLIC_NETWORK_TEST=1 npm run test:linux-sandbox -- orbitcode-sandbox-test-amd64:20261026
```

arm64 基础镜像复用了本地 Debian Node 镜像；amd64 最初使用官方 `node:24-bookworm-slim`，最终复用其已安装工具链的本地镜像，避开Docker Hub临时EOF。两端 Node 版本不同，不据此比较性能。Linux 专项也在独立 tmux 会话内执行，真实 CLI 经标准输入接收请求、调用本地协议替身、执行工具并保存和导出运行记录。

## 扩大测试发现并修复的问题

1. **macOS 敏感文件别名与依赖目录漏扫。** 合成密钥可经硬链接读取，原扫描又跳过依赖和构建目录。两端改用共用扫描，覆盖这些目录、敏感文件硬链接、敏感符号链接的工作区内真实目标，并使用目录子树规则保护受保护目录。没有读取或输出真实凭据。
2. **macOS 普通后台进程残留。** 短命令或长驻命令的主进程退出后，关闭输出、忽略 TERM 的同组后代仍可写入。共用收尾在主进程退出时回收其进程组，正常退出、超时和停止路径的回归通过。
3. **Linux 父子路径重复遮蔽。** 敏感链接指向含敏感文件的目录时，父目录遮蔽后继续挂载子路径导致正常命令启动失败。遮蔽集合移除已被父目录覆盖的子项，目录外的硬链接别名仍保留保护。
4. **准备阶段不受命令时限控制。** 工具入口的额外探测、后端探测等待和文件扫描现在使用同一命令预算，并响应取消；新增工具入口回归验证探测超时后绝不启动命令；共享能力探测有独立5秒上限，取消一个等待者不终止其他调用者的共享探测。
5. **真实仓库中的探测误报。** 将新5秒上限用于原探测后，反复扫描整个 OrbitCode 仓库导致约5005ms后拒绝执行。探测改用受控临时工作区，实际用户命令仍完整扫描授权工作区；探测使用绝对系统工具路径，不运行项目同名 shim。实测本仓库探测约63ms，单条命令连同安全扫描约2.1秒；这是单次观察，不作普遍性能保证。有界批量 stat 保留扫描完整性。
6. **会话测试请求数偶发失败。** 中间全仓曾出现“配置失效历史仍可读、导出，执行不能静默换绑”请求数2而不是1。独立夹具延迟观察确认第2次来自长期笔记提取器。仅在该用例关闭后台记忆，仍保留历史导出、配置错误与主请求次数断言；未修改生产记忆行为。

7. **只读工具链的大范围目录别名。** macOS的 `/tmp` 规范化为 `/private/tmp`，原规则只比较原字符串，可能接受过宽目录。现在同时检查系统目录、用户目录、临时目录及其真实路径；具体工具链子目录仍可授权。
8. **macOS祖先目录改名绕过。** 真实回归证明敏感文件父目录改名后可读取内容。新增祖先目录unlink/改名保护，覆盖普通名称与 `..nested` 等合法名称；同目录公开文件仍可读，Linux挂载遮蔽也通过该回归。
9. **macOS父进程环境查询绕过。** 仅清空继承环境不足以保密。测试只在显式合成环境启动的隔离supervisor上调用原生 `kern.procargs2`，未读取真实进程凭据，也不输出参数或环境正文。加入进程参数读取与跨进程信息约束后，同一原生助手的未隔离正对照返回0、沙箱父查询返回2（拒绝）、自身查询返回0。C助手只作为测试夹具编译，不是生产运行时依赖。

中间的SDK权限兼容性用例曾在约3.2秒后输出为空，独立复测通过；该功能用例改用10秒测试预算并断言完整执行状态，独立的短时限与取消用例保留，产品默认预算未改变。公网npm安装另出现过一次ECONNRESET，Docker Hub元数据请求出现过EOF，均保留为外部服务异常，不能当成功结果。公网补测允许一次250ms短重试且整体限定25秒；最终macOS与Linux公网补测通过。

更早的一次全仓曾出现 RAG 索引锁文件 ENOENT，所属文件单独10/10通过，随后全仓通过；未修改其生产实现，具体时序原因未确定。最终通过不抹去中间失败。

## 覆盖的行为

- 中文、空格、单/双引号、换行、shell字符路径按数据处理；正常项目工具仍可执行，探测不受项目同名工具干扰。
- 工作区外文件与环境哨兵不可见；敏感文件、用户记忆目录、依赖目录密钥、硬/符号链接、后续命令前新增敏感文件的保护。
- 默认网络、本机HTTP、公网DNS/TLS及固定版本npm包安装；显式禁网只影响命令，不影响主进程模型请求。
- Node/npm、Git、C++编译、Python、额外只读工具链；不授予额外目录写权限。
- 非零退出、stdout/stderr洪泛与截断、超时、运行前/中取消、准备阶段取消、多个工作区并发、独立HOME。
- 普通后台后代、忽略TERM后代、长驻命令自行退出；Linux主动脱组后代与CLI强杀后的命令回收。强杀测试先观察命令启动标记，再发送SIGKILL，确认延迟副作用未发生。
- Linux proc根目录、嵌套namespace、chmod/移动挂载点等尝试不能揭开敏感文件遮蔽；macOS原生接口不能读取受控父进程环境，敏感文件祖先目录改名被拒绝。
- CLI正常命令、命令失败、无效参数、工具超时、最大轮数、不可用沙箱；终态、运行日志、检查点与上下文导出。

## 保留的边界

- 实测 macOS 命令主动创建新会话、脱离进程组后仍能在父命令结束后写合成文件。该有限测试后代已自行结束并清理。Seatbelt 文件与网络规则仍继承，但不能声明 PID namespace 级别的生命周期回收，CLI被强杀时也不提供同等父死亡联动。需要这种保证时应在 Linux PID namespace 内运行整个 CLI。
- Linux 遮蔽基于启动时文件树；不要由外部进程在命令运行期间向新的未遮蔽路径写入秘密。额外只读工具链目录是明确授权的可读内容，不能存放私人凭据。
- 当前没有每命令CPU/内存/磁盘/cgroup配额、域名访问白名单或题目容器生命周期管理。网络默认开启，不是网络防泄漏策略。

## 证据与提交范围

原始输出在被Git忽略的 `tmp/linux-sandbox-build/`，不提交日志：

- `security-before.log`、`linux-security-before.log`：新增回归修复前的失败。
- `pr-linux-arm64.log`、`pr-linux-amd64.log`：提交前最新架构、UID与反向矩阵。
- `pr-tests.log`、`pr-{lint,types,build}.log`：提交前最后一次全仓与顺序检查。
- `security-tmux.log`、`security-tmux.exit`：tmux专项复跑及退出码。
- `security-full-latest.log`：中间请求数失败；独立合成夹具确认后台提取的记录未作为真实模型结果。
- `security-rename-before.log`：祖先目录改名前的复现失败。
- `security-public-macos-final.log`、`security-parent-environment.log`：macOS专项与受控原生进程查询测试。
- `security-public-network-reset.log`、`security-dockerhub-eof.log`：公网与镜像服务中间异常。

验证容器退出后不保留运行中的测试服务；本地验证镜像保留供复用。未清理用户原有镜像或缓存。

提交应包含本次沙箱模块、平台入口、专项脚本、测试与文档。原有未跟踪的 `docs/evals/history-evidence-2026-10-26.md`、`docs/evals/resume-evidence-supplement-2026-10-26.md` 不属于本次改动；不要混入PR，也不要提交 `tmp/` 产物。
