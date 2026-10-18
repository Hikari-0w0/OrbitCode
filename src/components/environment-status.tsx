import type { ComposerAvailability } from "./ui-state";
export function EnvironmentStatus({ availability, detail, onSettings, onReload, onRetry }: {
    readonly availability: ComposerAvailability;
    readonly detail?: string;
    readonly onSettings: () => void;
    readonly onReload: () => void;
    readonly onRetry: () => void;
}) {
    if (availability.kind !== "blocked" && !detail)
        return null;
    return <div className="environmentStatus" role="status"><div><strong>{availability.kind === "blocked" ? availability.message : "工作台提示"}</strong>{detail && <p>{detail}</p>}</div>{availability.kind === "blocked" && availability.recovery !== "none" && <button type="button" onClick={availability.recovery === "settings" ? onSettings : availability.recovery === "retry-save" ? onRetry : onReload}>{availability.recovery === "settings" ? "配置工作环境" : availability.recovery === "retry-save" ? "重试保存" : "重新连接"}</button>}</div>;
}
