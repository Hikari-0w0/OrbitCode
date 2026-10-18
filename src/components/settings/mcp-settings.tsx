"use client";
import type { useSettings } from "./use-settings";
export function McpSettings({ controller }: {
    readonly controller: ReturnType<typeof useSettings>;
}) {
    const { state, busy, mcpStatus, mcpName, setMcpName, mcpType, setMcpType, mcpWorkspace, setMcpWorkspace, mcpTarget, setMcpTarget, mcpArgs, setMcpArgs, mcpVariables, setMcpVariables, setNotice, apply, manageMcp, submitMcp } = controller;
    if (state.kind !== "ready")
        return null;
    return <section className="settingsCard" aria-labelledby="mcp-heading">
        <h2 id="mcp-heading">MCP Server</h2><p>保存配置不会自动连接或运行本地命令。对话使用时仍会请求相应授权。同名、同作用域保存会替换原配置。</p>
        <ul>{state.settings.mcpServers.map((server) => <li key={`${server.scope}:${server.workspaceId ?? ""}:${server.name}`}>
          <strong>{server.name}</strong> <span>{server.scope === "user" ? "用户级" : `工作区 ${server.workspaceId}`}</span> <span>{server.type}</span> <small>{server.endpoint}</small>
          <button disabled={busy || controller.dirty} onClick={() => { setMcpName(server.name); setMcpType(server.type); setMcpWorkspace(server.workspaceId ?? ""); setMcpTarget(""); setMcpArgs("[]"); setMcpVariables("{}"); setNotice("请填写完整替换配置；已保存的凭据不会返回表单。"); }}>替换配置</button>
          {server.enabled && <button disabled={busy || controller.dirty} onClick={() => void manageMcp(server, "connect")}>{mcpStatus[`${server.scope}:${server.workspaceId ?? ""}:${server.name}`] === "连接中…" ? "取消连接" : "连接并发现工具"}</button>}
          {server.enabled && <button disabled={busy || mcpStatus[`${server.scope}:${server.workspaceId ?? ""}:${server.name}`] === "连接中…"} onClick={() => void manageMcp(server, "disconnect")}>断开连接</button>}
          {mcpStatus[`${server.scope}:${server.workspaceId ?? ""}:${server.name}`] && <small role="status">{mcpStatus[`${server.scope}:${server.workspaceId ?? ""}:${server.name}`]}</small>}
          <button disabled={busy || controller.dirty} onClick={() => void apply({ type: "mcp-enable", name: server.name, scope: server.scope, ...(server.workspaceId ? { workspaceId: server.workspaceId } : {}), enabled: !server.enabled })}>{server.enabled ? "停用" : "启用"}</button>
          <button disabled={busy || controller.dirty} onClick={() => void apply({ type: "mcp-remove", name: server.name, scope: server.scope, ...(server.workspaceId ? { workspaceId: server.workspaceId } : {}) })}>移除配置</button>
        </li>)}</ul>
        <details className="settingsEditor" open={Boolean(mcpName)}><summary>添加或替换 MCP 配置</summary><form onSubmit={submitMcp} className="settingsForm">
          <label>名称<input required value={mcpName} onChange={(event) => setMcpName(event.target.value)}/></label>
          <label>类型<select value={mcpType} onChange={(event) => setMcpType(event.target.value === "stdio" ? "stdio" : "http")}><option value="http">HTTP</option><option value="stdio">本地命令</option></select></label>
          <label>{mcpType === "http" ? "服务地址" : "命令"}<input required value={mcpTarget} onChange={(event) => setMcpTarget(event.target.value)}/></label>
          {mcpType === "stdio" && <label>参数（JSON 数组）<input value={mcpArgs} onChange={(event) => setMcpArgs(event.target.value)} placeholder={'["--port", "3000"]'}/></label>}
          <label>{mcpType === "http" ? "Headers（JSON 对象）" : "环境变量（JSON 对象）"}<textarea rows={3} value={mcpVariables} onChange={(event) => setMcpVariables(event.target.value)}/></label>
          <label>作用范围<select value={mcpWorkspace} onChange={(event) => setMcpWorkspace(event.target.value)}><option value="">所有工作区</option>{state.settings.workspaces.filter((workspace) => workspace.enabled).map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>
          <button disabled={busy} type="submit">保存 MCP 配置</button>
        </form></details>
      </section>;
}
