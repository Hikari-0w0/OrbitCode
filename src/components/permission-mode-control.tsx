"use client";

import type { PermissionMode } from "@/core/permissions/types";

type PermissionModeControlProps = {
  readonly mode: PermissionMode;
  readonly disabled: boolean;
  readonly updating: boolean;
  readonly onChange: (mode: PermissionMode) => void;
};

const modes: readonly {
  readonly value: PermissionMode;
  readonly label: string;
  readonly detail: string;
}[] = [
  { value: "strict", label: "严格", detail: "所有工具默认询问" },
  { value: "default", label: "默认", detail: "读取直行，写入与命令询问" },
  { value: "permissive", label: "放行", detail: "默认允许，硬边界仍生效" },
];

export function PermissionModeControl({
  mode,
  disabled,
  updating,
  onChange,
}: PermissionModeControlProps) {
  return (
    <section className="permissionModeSection">
      <div className="permissionModeHeading">
        <label>PERMISSION MODE</label>
        <span>{updating ? "更新中" : "服务端生效"}</span>
      </div>
      <div className="permissionModeButtons" role="radiogroup" aria-label="权限模式">
        {modes.map((candidate) => (
          <button
            key={candidate.value}
            type="button"
            role="radio"
            aria-checked={mode === candidate.value}
            className={mode === candidate.value ? "permissionModeButton permissionModeButton--active" : "permissionModeButton"}
            disabled={disabled || updating}
            onClick={() => onChange(candidate.value)}
          >
            <strong>{candidate.label}</strong>
            <span>{candidate.detail}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
