"use client";
import type { useSettings } from "./use-settings";
export function WorkspaceSettings({ controller }: {
    readonly controller: ReturnType<typeof useSettings>;
}) {
    const { state, busy, workspaceName, setWorkspaceName, workspacePath, setWorkspacePath, renamingWorkspaceId, setRenamingWorkspaceId, apply, submitWorkspace } = controller;
    if (state.kind !== "ready")
        return null;
    return <section className="settingsCard" aria-labelledby="workspace-heading">
        <h2 id="workspace-heading">工作区</h2><p>填写运行 OrbitCode 的这台电脑上的绝对路径。</p>
        <ul>{state.settings.workspaces.map((workspace) => <li key={workspace.id}>
          <strong>{workspace.name}</strong> <code>{workspace.rootPath}</code>
          <button disabled={busy || controller.dirty} onClick={() => { setRenamingWorkspaceId(workspace.id); setWorkspaceName(workspace.name); setWorkspacePath(workspace.rootPath); }}>改名</button>
          <button disabled={busy || controller.dirty || !workspace.enabled || state.settings.defaultWorkspaceId === workspace.id} onClick={() => void apply({ type: "workspace-default", id: workspace.id })}>设为默认</button>
          <button disabled={busy || controller.dirty} onClick={() => void apply({ type: "workspace-enable", id: workspace.id, enabled: !workspace.enabled })}>{workspace.enabled ? "停用" : "启用"}</button>
          <button disabled={busy || controller.dirty} onClick={() => void apply({ type: "workspace-remove", id: workspace.id })}>移除记录（不删除目录）</button>
        </li>)}</ul>
        <details className="settingsEditor" open={Boolean(renamingWorkspaceId)}><summary>添加或重命名工作区</summary><form onSubmit={submitWorkspace} className="settingsForm">
          <label>名称<input required value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)}/></label>
          <label>本机目录<input required readOnly={Boolean(renamingWorkspaceId)} value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder="/Users/name/project"/></label>
          <button disabled={busy} type="submit">{renamingWorkspaceId ? "保存名称" : "添加工作区"}</button>
          {renamingWorkspaceId && <button type="button" onClick={() => void controller.confirmLeave().then(ok => { if (ok)
        controller.resetForm(); })}>取消改名</button>}
        </form></details>
      </section>;
}
