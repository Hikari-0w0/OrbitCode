"use client";

import type { WorkspaceSummary } from "@/web/chat-contract";

type WorkspaceSelectorProps = {
  readonly workspaces: readonly WorkspaceSummary[];
  readonly selectedWorkspaceId: string;
  readonly disabled: boolean;
  readonly onChange: (workspaceId: string) => void;
};

export function WorkspaceSelector({
  workspaces,
  selectedWorkspaceId,
  disabled,
  onChange,
}: WorkspaceSelectorProps) {
  const current = workspaces.find(
    (workspace) => workspace.id === selectedWorkspaceId,
  );
  return (
    <div className="workspaceSection">
      <label htmlFor="workspace-select">LOCAL WORKSPACE</label>
      <div className="selectWrap">
        <select
          id="workspace-select"
          aria-label="LOCAL WORKSPACE"
          value={selectedWorkspaceId}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {workspaces.length === 0 && <option value="">等待配置</option>}
          {workspaces.map((workspace) => (
            <option
              key={workspace.id}
              value={workspace.id}
              disabled={!workspace.available}
            >
              {workspace.name}
              {workspace.isDefault ? "（默认）" : ""}
              {workspace.available ? "" : "（不可用）"}
            </option>
          ))}
        </select>
        <ChevronIcon />
      </div>
      <div className="workspaceMeta">
        <span className={current?.available ? "statusDot" : "statusDot statusDot--off"} />
        <span>{current ? "所有工具严格限制在此目录内" : "等待服务端授权目录"}</span>
      </div>
    </div>
  );
}

function ChevronIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4" /></svg>;
}
