"use client";
import type { useSettings } from "./use-settings";
export function RecoverySettings({ controller }: {
    readonly controller: ReturnType<typeof useSettings>;
}) {
    const { busy, importPreview, importLegacy } = controller;
    if (controller.state.kind !== "ready")
        return null;
    return <section className="settingsCard" aria-labelledby="import-heading">
        <h2 id="import-heading">旧配置导入</h2>
        <p>从当前项目的旧模型和工作区文件以及 MCP 配置读取预览；确认后写入本机设置。原文件保留。</p>
        <button disabled={busy} onClick={() => void importLegacy("preview")}>预览旧配置</button>
        {importPreview && <div role="status">
          <p>模型：{importPreview.providers.join("、") || "无"}；工作区：{importPreview.workspaces.join("、") || "无"}；MCP：{importPreview.mcpServers.join("、") || "无"}</p>
          {importPreview.missingCredentials.length > 0 && <p>缺少环境凭据：{importPreview.missingCredentials.join("、")}</p>}
          <button disabled={busy} onClick={() => void importLegacy("commit")}>确认导入</button>
        </div>}
      </section>;
}
