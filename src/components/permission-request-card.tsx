"use client";
import type { VisiblePermissionRequest } from "@/components/message-list";

// 仅展示旧会话的审批事实；历史记录不再提供可操作的授权按钮。
export function PermissionRequestCard({ request }: { readonly request: VisiblePermissionRequest }) {
  return <section aria-label="历史工具授权记录"><strong>{request.prompt.toolName}</strong><p>历史授权记录：{request.state}。人工审批已移除。</p><pre>{JSON.stringify(request.prompt.summary, null, 2)}</pre></section>;
}
