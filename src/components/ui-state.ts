export type ManagementView = "agents" | "skills" | "background" | "cleanup" | "environment";
export type SettingsSection = "knowledge" | "models" | "workspaces" | "mcp" | "runtime" | "recovery" | "appearance";
export type OperationState<T> = {
    kind: "idle";
} | {
    kind: "pending";
} | {
    kind: "succeeded";
    value: T;
} | {
    kind: "failed";
    message: string;
    retryable: boolean;
};
export type ComposerAvailability = {
    kind: "ready";
} | {
    kind: "busy";
    phase: "streaming" | "stopping";
} | {
    kind: "blocked";
    message: string;
    recovery: "settings" | "reload" | "retry-save" | "none";
};
export function composerAvailability(input: {
    request: "idle" | "streaming" | "stopping";
    catalog: string;
    permission: string;
    conversation: string;
    availability: string;
    unsaved: boolean;
}): ComposerAvailability {
    if (input.request !== "idle")
        return { kind: "busy", phase: input.request };
    if (input.unsaved)
        return { kind: "blocked", message: "上一轮尚未保存，请先重试保存。", recovery: "retry-save" };
    if (input.catalog === "config-error")
        return { kind: "blocked", message: "工作环境尚未就绪，请检查模型与工作区设置。", recovery: "settings" };
    if (input.availability === "read-only")
        return { kind: "blocked", message: "当前为只读历史，可查看或导出；新建会话以继续。", recovery: "none" };
    if (input.catalog === "loading" || input.conversation === "loading" || input.permission === "loading")
        return { kind: "blocked", message: "正在加载工作环境与会话…", recovery: "none" };
    if (input.permission !== "ready")
        return { kind: "blocked", message: "权限会话不可用，请重新连接。", recovery: "reload" };
    if (input.conversation !== "ready")
        return { kind: "blocked", message: "无法加载会话，请重新加载。", recovery: "reload" };
    return { kind: "ready" };
}
