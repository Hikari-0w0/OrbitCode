"use client";

import type { VisiblePermissionRequest } from "@/components/message-list";
import type { PermissionUserDecision } from "@/core/permissions/approval";

type PermissionRequestCardProps = {
  readonly request: VisiblePermissionRequest;
  readonly onDecision: (
    requestId: string,
    decision: PermissionUserDecision,
  ) => void;
};

const decisions: readonly {
  readonly value: PermissionUserDecision;
  readonly label: string;
  readonly className: string;
}[] = [
  { value: "allow-once", label: "本次允许", className: "permissionButton--primary" },
  { value: "allow-session", label: "本会话允许", className: "" },
  { value: "allow-permanent", label: "永久允许（本机）", className: "" },
  { value: "deny", label: "拒绝", className: "permissionButton--deny" },
];

export function PermissionRequestCard({
  request,
  onDecision,
}: PermissionRequestCardProps) {
  const interactive = request.state === "awaiting";
  const pending = request.state === "submitting" || request.state === "submitted";
  return (
    <section
      className={`permissionCard permissionCard--${request.prompt.risk.level}`}
      aria-label="工具授权请求"
    >
      <div className="permissionCardHeader">
        <div>
          <span>PERMISSION REQUIRED</span>
          <strong>{request.prompt.toolName}</strong>
        </div>
        <span className={`riskBadge riskBadge--${request.prompt.risk.level}`}>
          {riskLabel(request.prompt.risk.level)}风险
        </span>
      </div>
      <dl className="permissionSummary">
        {Object.entries(request.prompt.summary).map(([key, value]) => (
          <div key={key}>
            <dt>{summaryLabel(key)}</dt>
            <dd>{String(value)}</dd>
          </div>
        ))}
        <div>
          <dt>Workspace</dt>
          <dd>{request.prompt.workspace.name}</dd>
        </div>
        <div>
          <dt>判断来源</dt>
          <dd>{request.prompt.source === "rules" ? "配置规则" : "权限模式默认值"}</dd>
        </div>
        <div>
          <dt>永久层级</dt>
          <dd>本地级</dd>
        </div>
      </dl>
      <p className="permissionRiskMessage">{request.prompt.risk.message}</p>
      <p className="permissionExpiry">
        有效期至 {new Date(request.prompt.expiresAt).toLocaleTimeString()}
      </p>
      {request.error && <p className="permissionError" role="alert">{request.error}</p>}
      {(interactive || pending) && (
        <div className="permissionActions" role="group" aria-label="授权决定">
          {decisions.map((decision) => (
            <button
              key={decision.value}
              className={decision.className}
              type="button"
              disabled={!interactive}
              onClick={() => onDecision(request.prompt.requestId, decision.value)}
            >
              {request.state === "submitting" ? "提交中…" : decision.label}
            </button>
          ))}
        </div>
      )}
      {!interactive && !pending && (
        <p className={`permissionOutcome permissionOutcome--${request.state}`}>
          {permissionStateLabel(request)}
        </p>
      )}
      {request.state === "submitted" && (
        <p className="permissionOutcome">决定已提交，等待服务端复检。</p>
      )}
    </section>
  );
}

function riskLabel(level: VisiblePermissionRequest["prompt"]["risk"]["level"]): string {
  if (level === "high") return "高";
  if (level === "medium") return "中";
  return "低";
}

function summaryLabel(key: string): string {
  if (key === "operation") return "操作";
  if (key === "path") return "路径";
  if (key === "command") return "命令";
  if (key === "cwd") return "工作目录";
  if (key === "bytes") return "字节数";
  return key;
}

function permissionStateLabel(request: VisiblePermissionRequest): string {
  if (request.state === "allowed") {
    if (request.scope === "session") return "已允许：仅当前会话同一目标";
    if (request.scope === "permanent") return "已允许：本机本地级规则";
    return "已允许：仅本次调用";
  }
  if (request.state === "denied") return "已拒绝，工具未执行";
  if (request.state === "expired") return "请求已过期，工具未执行";
  if (request.state === "cancelled") return "请求已取消，工具未执行";
  return "授权已失效，工具未执行";
}
