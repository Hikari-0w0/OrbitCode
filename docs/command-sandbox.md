# 跨平台命令沙箱

Web、交互 CLI、非交互 CLI 和子执行共用 `CommandSandbox`。macOS 使用 Seatbelt，Linux 使用 bubblewrap；其他平台或隔离探测失败时返回 `sandbox-unavailable`，不降级为裸 shell。

## 默认能力

- 默认允许联网，包括包源、外部开发接口及本机开发服务；没有新增命令白名单。
- 工作区保持真实路径，文件修改可直接被文件工具和 Git 观察；包安装、编译、测试和长驻服务使用相同文件树。
- 保留 stdout、stderr、退出码、信号、超时、取消及输出截断信息。命令总时限包含能力探测等待与文件扫描；共享探测另有5秒上限，取消一个等待者不取消其他调用者的探测。长驻进程仍由当前轮的进程控制器管理，轮结束时回收其进程组。
- 子进程使用最小环境，不继承模型凭据、完整服务端环境、SSH agent 或 Docker socket。HOME 与临时缓存按命令隔离；需要持久缓存或虚拟环境时放在 Workspace 内，并显式指定工具的缓存路径或激活环境。

## Linux 安装与运行

使用发行版的系统软件包安装 bubblewrap，例如 Debian/Ubuntu：

```bash
sudo apt-get install bubblewrap
```

当前寻找固定路径 `/usr/bin/bwrap`。Node/npm 等项目依赖按正常方式安装；不增加 npm 运行时依赖，也不使用 Agent 框架。

Linux 主机必须允许非特权 user namespace，以及 PID、mount、IPC 等隔离功能。AppArmor、seccomp、管理员策略或外层容器都可能阻止这些能力；安装 bwrap 并不等于探测一定通过。调整系统策略后重新启动 OrbitCode，让能力探测重新执行。

Docker 默认策略可能阻止嵌套 namespace 或新的 proc 挂载。本仓库验证容器使用：

```bash
docker run --rm \
  --security-opt seccomp=unconfined \
  --security-opt systempaths=unconfined \
  <已准备好的运行镜像> <启动命令>
```

这些选项放宽的是外层验证容器策略，以便内部 bwrap 建立隔离，并不等于 Docker 的默认安全策略已经支持此用法。部署时应由管理员按系统条件提供适当策略；不要为了通过探测直接授予 Agent `--privileged` 或挂载 Docker socket。

运行镜像应包含所需工具链；本后端复用所在 Linux 环境的系统工具，不会自动创建题目容器、安装工具链或把宿主机命令转发至容器。整个 CLI 在既有 Linux 容器中运行时，文件工具与命令工具才会自然使用同一工作区。

## 可选配置

在启动 OrbitCode 的进程环境中设置，Web 与 CLI 均适用；不要把这些参数交给模型控制。

```bash
# 默认就是 allow，无需设置。
export ORBITCODE_SANDBOX_NETWORK=allow

# 可选：授予额外工具链目录只读权限，并将其 bin 目录加入命令 PATH。
export ORBITCODE_SANDBOX_READ_ROOTS='["/opt/venv", "/opt/rust"]'
```

`ORBITCODE_SANDBOX_NETWORK=deny` 显式关闭命令网络；不影响 OrbitCode 自身请求模型。禁网模式下不能通过宿主机端口探测检查隔离网络内的服务，通常开发服务应保留默认联网模式。

额外只读目录必须已存在且不与 Workspace 重叠，不允许授权整个 `/`、用户目录根、`/etc`、`/tmp` 等大范围目录。子目录可以按需授权，例如具体的虚拟环境或工具链安装目录。目录内的所有内容都属于主动授权的可读数据，不能包含私人凭据；“只读”不等于“保密”。

CLI 从传入的进程环境取得沙箱配置，不从目标题目或项目自己的 `.env` 读取沙箱策略。主 Agent、子 Agent 和独立 Skill 继承同一个沙箱实例，不能在子执行时自行放宽网络策略。

## 隔离与生命周期边界

两端启动命令前共用安全扫描，覆盖依赖和构建目录、敏感文件硬链接、敏感符号链接在工作区内的真实目标。无法完成扫描时拒绝执行，不跳过无法验证的目录。macOS 使用 Seatbelt 的目录/文件拒绝规则；Linux 使用挂载遮蔽。

macOS 会阻止通过进程参数与其他进程查询接口读取未隔离父进程的环境，保留自身查询；包含敏感文件的祖先目录不能通过改名绕开保护，同目录普通文件仍可读取。

macOS 的生命周期管理使用进程组：主进程正常退出、超时或取消时，回收同组普通后代，即使后代关闭输出或忽略 TERM。主动创建新会话或进程组的后代不保证被回收，CLI 被强杀时也不提供内核级父死亡联动。脱组进程仍受继承的 Seatbelt 文件、进程查询与网络规则约束。需要强制回收任意后代时，应在支持 PID namespace 的 Linux 环境运行整个 CLI。

Linux 的具体边界：

- 从空挂载空间开始，只读映射系统运行库、当前 Node 运行时、公开的 DNS/CA 配置和明确授权的额外工具链。
- Workspace 可读写；`/tmp`、`/var/tmp`、HOME、设备和 proc 使用独立视图。沙箱在临时目录创建同名文件不会修改宿主对应路径。
- 使用独立 user/PID/IPC/UTS namespace、清空 capabilities、新会话和父进程死亡联动，防止读取宿主进程环境并回收命令后代。默认网络共享，仅显式禁网时隔离网络 namespace。
- 每次命令启动前重新扫描 Workspace，遮蔽已有敏感文件、受保护目录和 `.orbitcode` 目录；扫描涵盖依赖与构建目录，同时遮蔽已发现的敏感文件硬链接别名。超过250000个目录项或无法完成扫描时拒绝执行，不静默漏扫。
- Linux 的遮蔽基于本次启动时的文件树，不提供任意未来路径名称的内核拒绝规则。不要在命令运行期间，由外部进程向新的未遮蔽路径写入凭据或其他秘密；用户级运行数据应放在 Workspace 外。额外工具链也必须保持为可信只读内容。
- 当前不提供每条命令的 CPU、内存、磁盘或进程数量配额；仍有现有超时、输出限额与长驻进程数量限制。需要资源配额时在外层容器/cgroup 配置，避免对正常开发任务新增过紧的默认限制。

这保护的是本地工具执行边界，不能替代针对内核漏洞、同用户外部恶意进程、硬件侧信道等威胁的完整安全方案；默认联网也不是网络防泄漏策略。

## 验证

macOS 执行 `npm test` 运行本机回归。Linux 专项包含真实 bwrap、安全边界、联网/禁网、工具链、短命令与长驻进程、CLI 持久化和导出测试；模型端使用本地 OpenAI 协议替身，不调用真实模型：

```bash
npm run test:linux-sandbox
```

该命令需要 Docker，会准备独立测试镜像（默认 `node:24-bookworm-slim`）、安装仅用于验证的 Git/C++/Python/bubblewrap 工具链，依次运行 root 与普通 UID 用例，再以显式禁止 namespace 的 seccomp 策略验证拒绝执行，不依赖某个 Docker 版本的默认策略。测试镜像仅包含测试 bundle 和仓库内置角色/Skill 资源，不包含 `.env`、用户配置或目标评测题数据。

可以传入已有的兼容 Debian Node 镜像以复用本地工具链：

```bash
npm run test:linux-sandbox -- <本地基础镜像标签>
```

显式启用公网 DNS/TLS 与真实 npm 包安装补测，或指定另一架构：

```bash
ORBITCODE_SANDBOX_PUBLIC_NETWORK_TEST=1 npm run test:linux-sandbox
ORBITCODE_SANDBOX_TEST_PLATFORM=linux/amd64 npm run test:linux-sandbox
```

公网补测仅在临时工作区安装固定版本的测试包，不修改 OrbitCode 依赖；默认自动化测试使用本地包，避免依赖公网可用性。指定不同架构需要 Docker 的相应运行支持，成功构建镜像本身不代表沙箱或 CLI 验收通过。

Linux 用例在 macOS 的普通测试中显式跳过，不能把这些跳过项称为 Linux 验证通过；以专项容器测试结果为准。原生 Linux 上也可在满足条件后定向运行这些测试文件。
