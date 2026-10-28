"use client";

import { EVALUATION_COMMAND_SECURITY, parseCommandSecurity } from "@/tools/command-security";
import type { useSettings } from "./use-settings";

const budgets = [
  ["maxCommandChars", "命令最大字符数", 128, 65536],
  ["outputLimitBytes", "命令每路输出最多字节", 1024, 16777216],
  ["maxProcesses", "本轮受管进程数量上限", 1, 64],
  ["processLogBytes", "每个受管进程日志最多字节", 1024, 16777216],
  ["defaultReadyTimeoutMs", "进程默认就绪等待（毫秒）", 100, 1800000],
  ["maxReadyTimeoutMs", "进程最长就绪等待（毫秒）", 100, 1800000],
] as const;

function directories(fields: FormData, key: string): string[] {
  return String(fields.get(key) ?? "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

export function CommandSecuritySettings({ controller }: { readonly controller: ReturnType<typeof useSettings> }) {
  if (controller.state.kind !== "ready") return null;
  const settings = parseCommandSecurity(controller.state.settings.commandSecurity);
  return <form key={controller.state.settings.revision} className="settingsForm commandSecurityForm" aria-labelledby="command-security-heading" onChange={() => controller.setDirty(true)} onSubmit={event => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    try {
      const config = parseCommandSecurity({
        network: fields.get("network"),
        defaultTimeoutMs: Number(fields.get("defaultTimeoutSeconds")) * 1000,
        maxTimeoutMs: Number(fields.get("maxTimeoutSeconds")) * 1000,
        maxScanEntries: Number(fields.get("maxScanEntries")),
        temporaryDirectory: fields.get("temporaryDirectory"),
        readOnlyRoots: directories(fields, "readOnlyRoots"), writableRoots: directories(fields, "writableRoots"),
        commandPreflight: fields.get("commandPreflight"), npmrcAccess: fields.get("npmrcAccess"), environmentFileAccess: fields.get("environmentFileAccess"), macosAncestorDirectoryAccess: fields.get("macosAncestorDirectoryAccess"), preferFileTools: fields.get("preferFileTools") === "on",
        ...Object.fromEntries(budgets.map(([key]) => [key, Number(fields.get(key))])),
      });
      void controller.apply({ type: "command-security-set", config });
    } catch (error) { controller.setNotice(error instanceof Error ? error.message : "命令安全配置无效。"); }
  }}>
    <h3 id="command-security-heading">命令安全与沙箱</h3>
    <p>Web、CLI、子 Agent 与独立 Skill 共用；保存后从下一轮生效，正在执行的任务保留原配置。</p>
    <label className="commandSecurityWide">命令网络<select name="network" defaultValue={settings.network}>
      <option value="allow">允许联网（不预设域名白名单）</option><option value="deny">禁止命令联网</option>
    </select></label>
    <p>网络开关只作用于命令执行，不影响模型请求。启动时设置的 ORBITCODE_SANDBOX_NETWORK 和 ORBITCODE_SANDBOX_READ_ROOTS 优先于这里的对应选项。</p>
    <label className="commandSecurityWide">命令格式预检<select name="commandPreflight" defaultValue={settings.commandPreflight}>
      <option value="strict">启用格式预检（兼容原行为）</option><option value="off">关闭格式预检，直接由 shell 执行</option>
    </select></label>
    <p>关闭后允许冗余 cd、整体引号等写法；参数类型、工作区边界、时限与取消仍生效。shell 报错会原样返回。</p>
    <label className="commandSecurityWide">项目 .npmrc 读取<select name="npmrcAccess" defaultValue={settings.npmrcAccess}>
      <option value="blocked">保持保护</option><option value="public-only">允许无认证信息的公开配置（只读）</option>
    </select></label>
    <p>公开模式逐条命令重新检查文件；含 token、认证字段、环境插值或凭据 URL 的配置继续保护，符号链接不开放。私有包认证需在评测环境外预先准备。</p>
    <label><input name="preferFileTools" type="checkbox" defaultChecked={settings.preferFileTools}/>提示模型优先使用专用文件工具</label>
    <label className="commandSecurityWide">命令访问环境文件<select name="environmentFileAccess" defaultValue={settings.environmentFileAccess}>
      <option value="blocked">保护 .env 与 .env.*</option><option value="allow">允许授权目录内 .env 与 .env.* 读写</option>
    </select></label>
    <p>用于隔离工作区中的测试配置。允许模式会向命令开放工作区及额外可写目录内现有的环境文件；请在无私人凭据的评测目录使用。专用文件工具仍保持配置文件保护，其他凭据和目录授权不变。</p>
    <label className="commandSecurityWide">macOS 路径祖先目录<select name="macosAncestorDirectoryAccess" defaultValue={settings.macosAncestorDirectoryAccess}>
      <option value="metadata">只允许读取目录元信息</option><option value="read">允许打开祖先目录（兼容 Bun 等运行时）</option>
    </select></label>
    <p>允许模式可能看到祖先目录中的名称，不开放未授权文件内容；仅作用于 macOS。用于需要逐级打开目录来确定 cwd 的运行时。</p>
    <p>取消此偏好后允许模型按任务选择 shell 管道进行文件操作；实际路径权限不变。</p>
    <label>命令默认时限（秒）<input name="defaultTimeoutSeconds" type="number" min={0.1} step={0.1} max={86400} required defaultValue={settings.defaultTimeoutMs / 1000}/></label>
    <label>命令最长时限（秒）<input name="maxTimeoutSeconds" type="number" min={0.1} step={0.1} max={86400} required defaultValue={settings.maxTimeoutMs / 1000}/></label>
    <p>默认时限不能超过最长时限；命令始终受本轮总运行时限与手动停止约束。</p>
    <label className="commandSecurityWide">临时文件<select name="temporaryDirectory" defaultValue={settings.temporaryDirectory}>
      <option value="short">工作区专属短目录（IPC兼容、复用缓存）</option><option value="isolated">每条命令独立，结束后清理</option><option value="workspace">工作区内保留，支持跨命令复用</option>
    </select></label>
    <p>命令通过 $TMPDIR 使用临时目录。工作区模式写入 .orbitcode-tmp；短目录模式写入系统临时目录中当前用户的工作区专属0700目录。持久模式通过 $TMPDIR/cache 复用 npm、pnpm 和 Bun 缓存，请按需清理。</p>
    <label>安全扫描最多文件项<input name="maxScanEntries" type="number" min={1000} max={5000000} required defaultValue={settings.maxScanEntries}/></label>
    <p>大型依赖目录可提高容量；扫描仍会检查敏感文件与链接，不会跳过依赖目录。</p>
    <label className="commandSecurityWide">额外只读工具链目录（绝对路径，每行一个）<textarea name="readOnlyRoots" rows={3} defaultValue={settings.readOnlyRoots.join("\n")} placeholder="/opt/homebrew"/></label>
    <p>用于访问工作区外的 Node、Python 等工具链。凭据文件、用户记忆和未授权目录仍受隔离保护。</p>
    <label className="commandSecurityWide">额外可写构建或缓存目录（绝对路径，每行一个）<textarea name="writableRoots" rows={3} defaultValue={settings.writableRoots.join("\n")} placeholder="/tmp/orbitcode-eval-build"/></label>
    <p>目录须预先创建；仅授权具体目录，不允许整个用户目录、系统目录、设置目录或只读工具链。目录内凭据与跨目录硬链接仍保护。评测时勿授权 gold、题目数据或原始克隆目录。</p>
    <fieldset className="commandSecurityWide settingsFields"><legend>高级命令与进程预算</legend>{budgets.map(([key,label,min,max]) =>
      <label key={key}>{label}<input name={key} type="number" min={min} max={max} required defaultValue={settings[key]}/></label>
    )}</fieldset>
    <p>提高输出容量不改变模型自身上下文预算；进程仍在本轮结束时回收，端口探测不等于应用测试通过。</p>
    <button type="submit" disabled={controller.busy}>保存命令安全设置</button>
    <button type="button" disabled={controller.busy} onClick={event => {
      const form=event.currentTarget.form;if(!form)return;const fields=new FormData(form);
      void controller.apply({ type:"command-security-set",config:{...EVALUATION_COMMAND_SECURITY,readOnlyRoots:directories(fields,"readOnlyRoots"),writableRoots:directories(fields,"writableRoots")} });
    }}>保存命令评测预设</button>
    <p>评测预设会允许联网、关闭格式预检、开放公开 .npmrc 和授权目录内环境文件、启用 macOS 祖先目录兼容，并放宽命令和进程预算；请仅用于隔离评测工作区。目录授权保留当前填写值。本轮总时限、模型轮数和共享请求额度仍在上方运行偏好中配置。</p>
  </form>;
}
