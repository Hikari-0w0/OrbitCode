"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { runSettingsOperation } from "@/components/settings/settings-operation";
import type { PublicSettings } from "@/runtime/settings-types";
import type { SettingsAction } from "@/runtime/settings-service";
import { useDialogRequest } from "../ui/use-dialog-request";
import { useBeforeUnload } from "../navigation-guard";
type ViewState = {
    readonly kind: "loading";
} | {
    readonly kind: "error";
    readonly message: string;
    readonly token?: string;
    readonly recoverable?: boolean;
} | {
    readonly kind: "ready";
    readonly settings: PublicSettings;
    readonly token: string;
};
export function useSettings() {
    const { ask, dialog } = useDialogRequest();
    const [dirty, setDirty] = useState(false);
    useBeforeUnload(dirty);
    const [state, setState] = useState<ViewState>({ kind: "loading" });
    const [busy, setBusy] = useState(false);
    const saving = useRef(false);
    const [notice, setNotice] = useState("");
    const [probeStatus, setProbeStatus] = useState<Readonly<Record<string, string>>>({});
    const probeControllers = useRef(new Map<string, AbortController>());
    const [mcpStatus, setMcpStatus] = useState<Readonly<Record<string, string>>>({});
    const mcpControllers = useRef(new Map<string, AbortController>());
    const [importPreview, setImportPreview] = useState<{
        readonly previewId: string;
        readonly providers: readonly string[];
        readonly workspaces: readonly string[];
        readonly mcpServers: readonly string[];
        readonly missingCredentials: readonly string[];
    }>();
    const [modelName, setModelName] = useState("");
    const [editingProviderId, setEditingProviderId] = useState<string>();
    const [modelId, setModelId] = useState("");
    const [apiUrl, setApiUrl] = useState("");
    const [keyKind, setKeyKind] = useState<"local" | "environment">("environment");
    const [keyValue, setKeyValue] = useState("");
    const [windowTokens, setWindowTokens] = useState(128000);
    const [maxOutputTokens, setMaxOutputTokens] = useState("");
    const [thinkingMode, setThinkingMode] = useState<"default" | "enabled" | "disabled">("default");
    const [thinkingApiStyle, setThinkingApiStyle] = useState<"siliconflow" | "deepseek">("siliconflow");
    const [thinkingBudget, setThinkingBudget] = useState("");
    const [workspaceName, setWorkspaceName] = useState("");
    const [renamingWorkspaceId, setRenamingWorkspaceId] = useState<string>();
    const [workspacePath, setWorkspacePath] = useState("");
    const [mcpName, setMcpName] = useState("");
    const [mcpType, setMcpType] = useState<"http" | "stdio">("http");
    const [mcpTarget, setMcpTarget] = useState("");
    const [mcpArgs, setMcpArgs] = useState("[]");
    const [mcpVariables, setMcpVariables] = useState("{}");
    const [mcpWorkspace, setMcpWorkspace] = useState("");
    const [maxIterations, setMaxIterations] = useState(8);
    const [maxRuntimeMinutes, setMaxRuntimeMinutes] = useState(60);
    const [defaultPermissionMode, setDefaultPermissionMode] = useState<"strict" | "default" | "permissive">("default");
    const refresh = useCallback(async () => {
        try {
            const response = await fetch("/api/settings", { cache: "no-store" });
            const token = response.headers.get("x-orbitcode-settings-token");
            const value: unknown = await response.json();
            if (!response.ok && token && isInvalidSettings(value)) {
                setState({ kind: "error", message: errorMessage(value, "设置文件无效。"), token, recoverable: true });
                return;
            }
            if (!response.ok || !token || !isSettings(value))
                throw new Error(errorMessage(value, "无法加载设置。"));
            setMaxIterations(value.maxIterations ?? 8);
            setMaxRuntimeMinutes(value.maxRuntimeMinutes ?? 60);
            setDefaultPermissionMode(value.defaultPermissionMode ?? "default");
            setState({ kind: "ready", settings: value, token });
        }
        catch (error) {
            setState({ kind: "error", message: error instanceof Error ? error.message : "无法加载设置。" });
        }
    }, []);
    useEffect(() => {
        const controllers = probeControllers.current;
        const mcpPending = mcpControllers.current;
        const initialRequest = new AbortController();
        void fetch("/api/settings", { cache: "no-store", signal: initialRequest.signal }).then(async (response) => {
            const token = response.headers.get("x-orbitcode-settings-token");
            const value: unknown = await response.json();
            if (!response.ok && token && isInvalidSettings(value)) {
                setState({ kind: "error", message: errorMessage(value, "设置文件无效。"), token, recoverable: true });
                return;
            }
            if (!response.ok || !token || !isSettings(value))
                throw new Error(errorMessage(value, "无法加载设置。"));
            setMaxIterations(value.maxIterations ?? 8);
            setMaxRuntimeMinutes(value.maxRuntimeMinutes ?? 60);
            setDefaultPermissionMode(value.defaultPermissionMode ?? "default");
            setState({ kind: "ready", settings: value, token });
        }).catch((error: unknown) => {
            if (!initialRequest.signal.aborted)
                setState({ kind: "error", message: error instanceof Error ? error.message : "无法加载设置。" });
        });
        return () => {
            initialRequest.abort();
            for (const controller of controllers.values())
                controller.abort();
            controllers.clear();
            for (const controller of mcpPending.values())
                controller.abort();
            mcpPending.clear();
        };
    }, []);
    async function apply(action: SettingsAction): Promise<void> {
        if (state.kind !== "ready" || saving.current)
            return;
        if (action.type === "workspace-remove" || action.type === "mcp-remove" || (action.type === "provider-edit" && action.credential?.kind === "none")) {
            if (!await ask({ title: "确认设置变更", description: action.type === "workspace-remove" ? "只移除工作区记录，不会删除磁盘目录。是否继续？" : action.type === "mcp-remove" ? "移除这项 MCP 配置？" : "清除已保存凭据并停用模型？", danger: true }))
                return;
        }
        if (saving.current) return;
        saving.current = true;
        setBusy(true);
        setNotice("");
        try {
            const response = await fetch("/api/settings", {
                method: "PATCH",
                headers: { "content-type": "application/json", "x-orbitcode-settings-token": state.token },
                body: JSON.stringify({ expectedRevision: state.settings.revision, action }),
            });
            const value: unknown = await response.json();
            if (!response.ok || !isSettings(value))
                throw new Error(errorMessage(value, "保存设置失败。"));
            setState({ kind: "ready", settings: value, token: state.token });
            setNotice("warning" in value && typeof value.warning === "string" ? value.warning : "设置已保存，新一轮对话将使用更新后的配置。");
            setDirty(false);
            setKeyValue("");
            setMcpVariables("{}");
            setEditingProviderId(undefined);
            setMaxOutputTokens("");
            setThinkingMode("default");
            setThinkingApiStyle("siliconflow");
            setThinkingBudget("");
            setRenamingWorkspaceId(undefined);
            for (const controller of probeControllers.current.values())
                controller.abort();
            probeControllers.current.clear();
            for (const controller of mcpControllers.current.values())
                controller.abort();
            mcpControllers.current.clear();
            setProbeStatus({});
            setMcpStatus({});
        }
        catch (error) {
            setNotice(error instanceof Error ? error.message : "保存设置失败。");
            try {
                const response = await fetch("/api/settings", { cache: "no-store" });
                const latest: unknown = await response.json();
                if (response.ok && isSettings(latest))
                    setState({ kind: "ready", settings: latest, token: state.token });
            }
            catch { /* 保留原表单与可读错误，等待显式重试。 */ }
        }
        finally {
            saving.current = false;
            setBusy(false);
        }
    }
    async function importLegacy(action: "preview" | "commit"): Promise<void> {
        if (state.kind !== "ready")
            return;
        setBusy(true);
        setNotice("");
        try {
            const response = await fetch("/api/settings/import", { method: "POST",
                headers: { "content-type": "application/json", "x-orbitcode-settings-token": state.token },
                body: JSON.stringify(action === "preview" ? { action } : { action, previewId: importPreview?.previewId, expectedRevision: state.settings.revision }) });
            const value: unknown = await response.json();
            if (!response.ok)
                throw new Error(errorMessage(value, "导入失败。"));
            if (action === "preview") {
                if (!isImportPreview(value))
                    throw new Error("导入预览无效。");
                setImportPreview(value);
            }
            else {
                if (!isSettings(value))
                    throw new Error("导入结果无效。");
                setState({ kind: "ready", settings: value, token: state.token });
                setImportPreview(undefined);
                setNotice("旧配置已导入；原文件未改动。");
            }
        }
        catch (error) {
            setNotice(error instanceof Error ? error.message : "导入失败。");
        }
        finally {
            setBusy(false);
        }
    }
    async function recoverInvalidSettings(token: string): Promise<void> {
        if (!await ask({ title: "恢复设置", description: "将先备份损坏的设置文件，再建立空配置。原文件可从备份恢复。", danger: true }))
            return;
        setBusy(true);
        try {
            const response = await fetch("/api/settings/recovery", { method: "POST",
                headers: { "content-type": "application/json", "x-orbitcode-settings-token": token },
                body: JSON.stringify({ action: "backup-and-reset" }) });
            const value: unknown = await response.json();
            if (!response.ok || !isRecovery(value))
                throw new Error(errorMessage(value, "恢复失败。"));
            setNotice(`损坏设置已备份为 ${value.backup}，现在可以重新配置。`);
            await refresh();
        }
        catch (error) {
            setState({ kind: "error", message: error instanceof Error ? error.message : "恢复失败。", token, recoverable: true });
        }
        finally {
            setBusy(false);
        }
    }
    async function probeProvider(providerId: string): Promise<void> {
        if (state.kind !== "ready")
            return;
        const pending = probeControllers.current.get(providerId);
        if (pending) {
            pending.abort();
            probeControllers.current.delete(providerId);
            setProbeStatus((current) => ({ ...current, [providerId]: "已取消本次测试" }));
            return;
        }
        const controller = new AbortController();
        probeControllers.current.set(providerId, controller);
        setProbeStatus((current) => ({ ...current, [providerId]: "测试中…" }));
        try {
            const { result: value, ok } = await runSettingsOperation({ type: "provider-probe", providerId,
                expectedRevision: state.settings.revision }, state.token, controller.signal);
            if (!controller.signal.aborted)
                setProbeStatus((current) => ({ ...current,
                    [providerId]: `${detailMessage(value, ok ? "本次测试通过" : "连接失败")}（${new Date().toLocaleString()}）` }));
        }
        catch {
            if (!controller.signal.aborted)
                setProbeStatus((current) => ({ ...current, [providerId]: "连接失败" }));
        }
        finally {
            if (probeControllers.current.get(providerId) === controller)
                probeControllers.current.delete(providerId);
        }
    }
    async function manageMcp(server: PublicSettings["mcpServers"][number], action: "connect" | "disconnect"): Promise<void> {
        if (state.kind !== "ready")
            return;
        const workspaceId = server.workspaceId ?? state.settings.defaultWorkspaceId;
        if (!workspaceId) {
            setNotice("请先添加工作区。");
            return;
        }
        if (server.scope === "user" && state.settings.mcpServers.some((item) => item.scope === "workspace" && item.workspaceId === workspaceId && item.name === server.name)) {
            setNotice("默认工作区存在同名配置，请在对应工作区配置项中执行连接操作。");
            return;
        }
        const key = `${server.scope}:${server.workspaceId ?? ""}:${server.name}`;
        const pending = mcpControllers.current.get(key);
        if (pending && action === "connect") {
            pending.abort();
            mcpControllers.current.delete(key);
            setMcpStatus((current) => ({ ...current, [key]: "已取消本次连接" }));
            return;
        }
        const controller = new AbortController();
        mcpControllers.current.set(key, controller);
        setMcpStatus((current) => ({ ...current, [key]: action === "connect" ? "连接中…" : "断开中…" }));
        try {
            let value: unknown;
            let ok: boolean;
            if (action === "connect") {
                const operation = await runSettingsOperation({ type: "mcp-connect", serverName: server.name, workspaceId,
                    expectedRevision: state.settings.revision }, state.token, controller.signal);
                value = operation.result;
                ok = operation.ok;
            }
            else {
                const response = await fetch("/api/settings/mcp", { method: "POST",
                    headers: { "content-type": "application/json", "x-orbitcode-settings-token": state.token },
                    body: JSON.stringify({ action, serverName: server.name, workspaceId, expectedRevision: state.settings.revision }), signal: controller.signal });
                value = await response.json();
                ok = response.ok;
            }
            if (!controller.signal.aborted)
                setMcpStatus((current) => ({ ...current, [key]: mcpDetail(value, ok ? "操作完成" : "连接失败") }));
        }
        catch {
            if (!controller.signal.aborted)
                setMcpStatus((current) => ({ ...current, [key]: "连接失败" }));
        }
        finally {
            if (mcpControllers.current.get(key) === controller)
                mcpControllers.current.delete(key);
        }
    }
    function submitModel(event: FormEvent<HTMLFormElement>): void {
        event.preventDefault();
        const advanced = { maxOutputTokens: maxOutputTokens === "" ? null : Number(maxOutputTokens),
            thinking: thinkingMode === "default" ? null : { enabled: thinkingMode === "enabled", apiStyle: thinkingApiStyle,
                ...(thinkingMode === "enabled" && thinkingApiStyle === "siliconflow" && thinkingBudget !== "" ? { budgetTokens: Number(thinkingBudget) } : {}) } };
        const credential = keyValue ? keyKind === "local" ? { kind: "local" as const, value: keyValue } : { kind: "environment" as const, variable: keyValue } : undefined;
        if (editingProviderId)
            void apply({ type: "provider-edit", id: editingProviderId, displayName: modelName, model: modelId,
                baseUrl: apiUrl, windowTokens, ...advanced, ...(credential ? { credential } : {}) });
        else if (credential)
            void apply({ type: "provider-add", displayName: modelName, model: modelId, baseUrl: apiUrl, windowTokens, credential, ...advanced });
    }
    function submitWorkspace(event: FormEvent<HTMLFormElement>): void {
        event.preventDefault();
        if (renamingWorkspaceId)
            void apply({ type: "workspace-rename", id: renamingWorkspaceId, name: workspaceName });
        else
            void apply({ type: "workspace-add", name: workspaceName, rootPath: workspacePath });
    }
    function submitMcp(event: FormEvent<HTMLFormElement>): void {
        event.preventDefault();
        let variables: Record<string, string>;
        let args: string[];
        try {
            variables = parseStringMap(mcpVariables);
            args = parseStringArray(mcpArgs);
        }
        catch {
            setNotice("MCP Headers/环境变量须为字符串键值 JSON 对象，参数须为字符串 JSON 数组。");
            return;
        }
        void apply({ type: "mcp-upsert", name: mcpName, scope: mcpWorkspace ? "workspace" : "user",
            ...(mcpWorkspace ? { workspaceId: mcpWorkspace } : {}),
            config: mcpType === "http"
                ? { type: "http", url: mcpTarget, headers: variables }
                : { type: "stdio", command: mcpTarget, args, env: variables } });
    }
    async function confirmLeave(): Promise<boolean> {
        if (busy || saving.current) return false;
        if (!dirty)
            return true;
        if (!await ask({ title: "未保存的修改", description: "确认放弃当前编辑并离开？选择取消可继续编辑。" }))
            return false;
        resetForm();
        return true;
    }
    function resetForm() {
        setDirty(false);
        setKeyValue("");
        setModelName("");
        setMaxOutputTokens("");
        setThinkingMode("default");
        setThinkingApiStyle("siliconflow");
        setThinkingBudget("");
        setModelId("");
        setApiUrl("");
        setEditingProviderId(undefined);
        setWorkspaceName("");
        setWorkspacePath("");
        setRenamingWorkspaceId(undefined);
        setMcpName("");
        setMcpTarget("");
        setMcpArgs("[]");
        setMcpVariables("{}");
        if (state.kind === "ready") {
            setMaxIterations(state.settings.maxIterations ?? 8);
            setMaxRuntimeMinutes(state.settings.maxRuntimeMinutes ?? 60);
            setDefaultPermissionMode(state.settings.defaultPermissionMode ?? "default");
        }
    }
    return { maxOutputTokens, setMaxOutputTokens, thinkingMode, setThinkingMode, thinkingApiStyle, setThinkingApiStyle, thinkingBudget, setThinkingBudget, state, busy, notice, probeStatus, mcpStatus, importPreview, modelName, setModelName, modelId, setModelId, apiUrl, setApiUrl, keyKind, setKeyKind, keyValue, setKeyValue, windowTokens, setWindowTokens, editingProviderId, setEditingProviderId, workspaceName, setWorkspaceName, workspacePath, setWorkspacePath, renamingWorkspaceId, setRenamingWorkspaceId, mcpName, setMcpName, mcpType, setMcpType, mcpWorkspace, setMcpWorkspace, mcpTarget, setMcpTarget, mcpArgs, setMcpArgs, mcpVariables, setMcpVariables, maxIterations, setMaxIterations, maxRuntimeMinutes, setMaxRuntimeMinutes, defaultPermissionMode, setDefaultPermissionMode, setNotice, refresh, apply, importLegacy, recoverInvalidSettings, probeProvider, manageMcp, submitModel, submitWorkspace, submitMcp, dirty, setDirty, dialog, confirmLeave, resetForm };
}
function isSettings(value: unknown): value is PublicSettings {
    return typeof value === "object" && value !== null && "revision" in value && typeof value.revision === "number" && "providers" in value && Array.isArray(value.providers) && "workspaces" in value && Array.isArray(value.workspaces) && "mcpServers" in value && Array.isArray(value.mcpServers);
}
function errorMessage(value: unknown, fallback: string): string {
    return typeof value === "object" && value !== null && "error" in value && typeof value.error === "string" ? value.error : fallback;
}
function isImportPreview(value: unknown): value is {
    previewId: string;
    providers: string[];
    workspaces: string[];
    mcpServers: string[];
    missingCredentials: string[];
} {
    return typeof value === "object" && value !== null && "previewId" in value && typeof value.previewId === "string" &&
        "providers" in value && Array.isArray(value.providers) && "workspaces" in value && Array.isArray(value.workspaces) &&
        "mcpServers" in value && Array.isArray(value.mcpServers) && "missingCredentials" in value && Array.isArray(value.missingCredentials);
}
function detailMessage(value: unknown, fallback: string): string { return typeof value === "object" && value !== null && "detail" in value && typeof value.detail === "string" ? value.detail : fallback; }
function mcpDetail(value: unknown, fallback: string): string {
    const detail = detailMessage(value, fallback);
    if (typeof value !== "object" || value === null || !("tools" in value) || !Array.isArray(value.tools) || !value.tools.every((item: unknown) => typeof item === "string"))
        return detail;
    return `${detail} 工具：${value.tools.length ? value.tools.join("、") : "无"}`;
}
function isInvalidSettings(value: unknown): boolean { return typeof value === "object" && value !== null && "code" in value && value.code === "invalid"; }
function isRecovery(value: unknown): value is {
    backup: string;
    settings: PublicSettings;
} { return typeof value === "object" && value !== null && "backup" in value && typeof value.backup === "string" && "settings" in value && isSettings(value.settings); }
function parseStringMap(source: string): Record<string, string> {
    const value: unknown = JSON.parse(source);
    if (typeof value !== "object" || value === null || Array.isArray(value) || Object.values(value).some((item) => typeof item !== "string"))
        throw new Error("invalid-map");
    return value as Record<string, string>;
}
function parseStringArray(source: string): string[] {
    const value: unknown = JSON.parse(source);
    if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === "string"))
        throw new Error("invalid-array");
    return value;
}
