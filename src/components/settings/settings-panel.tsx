"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { runSettingsOperation } from "@/components/settings/settings-operation";
import type { PublicSettings } from "@/runtime/settings-types";
import type { SettingsAction } from "@/runtime/settings-service";

type ViewState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string; readonly token?: string; readonly recoverable?: boolean }
  | { readonly kind: "ready"; readonly settings: PublicSettings; readonly token: string };

export function SettingsPanel() {
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [probeStatus, setProbeStatus] = useState<Readonly<Record<string, string>>>({});
  const probeControllers = useRef(new Map<string, AbortController>());
  const [mcpStatus, setMcpStatus] = useState<Readonly<Record<string, string>>>({});
  const mcpControllers = useRef(new Map<string, AbortController>());
  const [importPreview, setImportPreview] = useState<{ readonly previewId: string; readonly providers: readonly string[]; readonly workspaces: readonly string[]; readonly mcpServers: readonly string[]; readonly missingCredentials: readonly string[] }>();
  const [modelName, setModelName] = useState("");
  const [editingProviderId, setEditingProviderId] = useState<string>();
  const [modelId, setModelId] = useState("");
  const [apiUrl, setApiUrl] = useState("");
  const [keyKind, setKeyKind] = useState<"local" | "environment">("environment");
  const [keyValue, setKeyValue] = useState("");
  const [windowTokens, setWindowTokens] = useState(128000);
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
      if (!response.ok && token && isInvalidSettings(value)) { setState({ kind: "error", message: errorMessage(value, "设置文件无效。"), token, recoverable: true }); return; }
      if (!response.ok || !token || !isSettings(value)) throw new Error(errorMessage(value, "无法加载设置。"));
      setMaxIterations(value.maxIterations ?? 8);
      setMaxRuntimeMinutes(value.maxRuntimeMinutes ?? 60);
      setDefaultPermissionMode(value.defaultPermissionMode ?? "default");
      setState({ kind: "ready", settings: value, token });
    } catch (error) { setState({ kind: "error", message: error instanceof Error ? error.message : "无法加载设置。" }); }
  }, []);
  useEffect(() => {
    const controllers = probeControllers.current;
    const mcpPending = mcpControllers.current;
    void fetch("/api/settings", { cache: "no-store" }).then(async (response) => {
      const token = response.headers.get("x-orbitcode-settings-token");
      const value: unknown = await response.json();
      if (!response.ok && token && isInvalidSettings(value)) { setState({ kind: "error", message: errorMessage(value, "设置文件无效。"), token, recoverable: true }); return; }
      if (!response.ok || !token || !isSettings(value)) throw new Error(errorMessage(value, "无法加载设置。"));
      setMaxIterations(value.maxIterations ?? 8);
      setMaxRuntimeMinutes(value.maxRuntimeMinutes ?? 60);
      setDefaultPermissionMode(value.defaultPermissionMode ?? "default");
      setState({ kind: "ready", settings: value, token });
    }).catch((error: unknown) => setState({ kind: "error", message: error instanceof Error ? error.message : "无法加载设置。" }));
    return () => { for (const controller of controllers.values()) controller.abort(); controllers.clear();
      for (const controller of mcpPending.values()) controller.abort(); mcpPending.clear(); };
  }, []);

  async function apply(action: SettingsAction): Promise<void> {
    if (state.kind !== "ready") return;
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-orbitcode-settings-token": state.token },
        body: JSON.stringify({ expectedRevision: state.settings.revision, action }),
      });
      const value: unknown = await response.json();
      if (!response.ok || !isSettings(value)) throw new Error(errorMessage(value, "保存设置失败。"));
      setState({ kind: "ready", settings: value, token: state.token });
      setNotice("warning" in value && typeof value.warning === "string" ? value.warning : "设置已保存，新一轮对话将使用更新后的配置。");
      setKeyValue("");
      setMcpVariables("{}");
      setEditingProviderId(undefined);
      setRenamingWorkspaceId(undefined);
      for (const controller of probeControllers.current.values()) controller.abort();
      probeControllers.current.clear();
      for (const controller of mcpControllers.current.values()) controller.abort();
      mcpControllers.current.clear();
      setProbeStatus({});
      setMcpStatus({});
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "保存设置失败。");
      await refresh();
    } finally { setBusy(false); }
  }
  async function importLegacy(action: "preview" | "commit"): Promise<void> {
    if (state.kind !== "ready") return;
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/settings/import", { method: "POST",
        headers: { "content-type": "application/json", "x-orbitcode-settings-token": state.token },
        body: JSON.stringify(action === "preview" ? { action } : { action, previewId: importPreview?.previewId, expectedRevision: state.settings.revision }) });
      const value: unknown = await response.json();
      if (!response.ok) throw new Error(errorMessage(value, "导入失败。"));
      if (action === "preview") {
        if (!isImportPreview(value)) throw new Error("导入预览无效。");
        setImportPreview(value);
      } else {
        if (!isSettings(value)) throw new Error("导入结果无效。");
        setState({ kind: "ready", settings: value, token: state.token });
        setImportPreview(undefined);
        setNotice("旧配置已导入；原文件未改动。");
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : "导入失败。"); }
    finally { setBusy(false); }
  }
  async function recoverInvalidSettings(token: string): Promise<void> {
    setBusy(true);
    try {
      const response = await fetch("/api/settings/recovery", { method: "POST",
        headers: { "content-type": "application/json", "x-orbitcode-settings-token": token },
        body: JSON.stringify({ action: "backup-and-reset" }) });
      const value: unknown = await response.json();
      if (!response.ok || !isRecovery(value)) throw new Error(errorMessage(value, "恢复失败。"));
      setNotice(`损坏设置已备份为 ${value.backup}，现在可以重新配置。`);
      await refresh();
    } catch (error) { setState({ kind: "error", message: error instanceof Error ? error.message : "恢复失败。", token, recoverable: true }); }
    finally { setBusy(false); }
  }
  async function probeProvider(providerId: string): Promise<void> {
    if (state.kind !== "ready") return;
    const pending = probeControllers.current.get(providerId);
    if (pending) { pending.abort(); probeControllers.current.delete(providerId);
      setProbeStatus((current) => ({ ...current, [providerId]: "已取消本次测试" })); return; }
    const controller = new AbortController();
    probeControllers.current.set(providerId, controller);
    setProbeStatus((current) => ({ ...current, [providerId]: "测试中…" }));
    try {
      const { result: value, ok } = await runSettingsOperation({ type: "provider-probe", providerId,
        expectedRevision: state.settings.revision }, state.token, controller.signal);
      if (!controller.signal.aborted) setProbeStatus((current) => ({ ...current,
        [providerId]: `${detailMessage(value, ok ? "本次测试通过" : "连接失败")}（${new Date().toLocaleString()}）` }));
    } catch { if (!controller.signal.aborted) setProbeStatus((current) => ({ ...current, [providerId]: "连接失败" })); }
    finally { if (probeControllers.current.get(providerId) === controller) probeControllers.current.delete(providerId); }
  }
  async function manageMcp(server: PublicSettings["mcpServers"][number], action: "connect" | "disconnect"): Promise<void> {
    if (state.kind !== "ready") return;
    const workspaceId = server.workspaceId ?? state.settings.defaultWorkspaceId;
    if (!workspaceId) { setNotice("请先添加工作区。") ; return; }
    if (server.scope === "user" && state.settings.mcpServers.some((item) => item.scope === "workspace" && item.workspaceId === workspaceId && item.name === server.name)) {
      setNotice("默认工作区存在同名配置，请在对应工作区配置项中执行连接操作。"); return;
    }
    const key = `${server.scope}:${server.workspaceId ?? ""}:${server.name}`;
    const pending = mcpControllers.current.get(key);
    if (pending && action === "connect") { pending.abort(); mcpControllers.current.delete(key);
      setMcpStatus((current) => ({ ...current, [key]: "已取消本次连接" })); return; }
    const controller = new AbortController();
    mcpControllers.current.set(key, controller);
    setMcpStatus((current) => ({ ...current, [key]: action === "connect" ? "连接中…" : "断开中…" }));
    try {
      let value: unknown;
      let ok: boolean;
      if (action === "connect") {
        const operation = await runSettingsOperation({ type: "mcp-connect", serverName: server.name, workspaceId,
          expectedRevision: state.settings.revision }, state.token, controller.signal);
        value = operation.result; ok = operation.ok;
      } else {
        const response = await fetch("/api/settings/mcp", { method: "POST",
          headers: { "content-type": "application/json", "x-orbitcode-settings-token": state.token },
          body: JSON.stringify({ action, serverName: server.name, workspaceId, expectedRevision: state.settings.revision }), signal: controller.signal });
        value = await response.json(); ok = response.ok;
      }
      if (!controller.signal.aborted) setMcpStatus((current) => ({ ...current, [key]: mcpDetail(value, ok ? "操作完成" : "连接失败") }));
    } catch { if (!controller.signal.aborted) setMcpStatus((current) => ({ ...current, [key]: "连接失败" })); }
    finally { if (mcpControllers.current.get(key) === controller) mcpControllers.current.delete(key); }
  }
  function submitModel(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const credential = keyValue ? keyKind === "local" ? { kind: "local" as const, value: keyValue } : { kind: "environment" as const, variable: keyValue } : undefined;
    if (editingProviderId) void apply({ type: "provider-edit", id: editingProviderId, displayName: modelName, model: modelId,
      baseUrl: apiUrl, windowTokens, ...(credential ? { credential } : {}) });
    else if (credential) void apply({ type: "provider-add", displayName: modelName, model: modelId, baseUrl: apiUrl, windowTokens, credential });
  }
  function submitWorkspace(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (renamingWorkspaceId) void apply({ type: "workspace-rename", id: renamingWorkspaceId, name: workspaceName });
    else void apply({ type: "workspace-add", name: workspaceName, rootPath: workspacePath });
  }
  function submitMcp(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    let variables: Record<string, string>;
    let args: string[];
    try { variables = parseStringMap(mcpVariables); args = parseStringArray(mcpArgs); }
    catch { setNotice("MCP Headers/环境变量须为字符串键值 JSON 对象，参数须为字符串 JSON 数组。"); return; }
    void apply({ type: "mcp-upsert", name: mcpName, scope: mcpWorkspace ? "workspace" : "user",
      ...(mcpWorkspace ? { workspaceId: mcpWorkspace } : {}),
      config: mcpType === "http"
        ? { type: "http", url: mcpTarget, headers: variables }
        : { type: "stdio", command: mcpTarget, args, env: variables } });
  }

  return <main className="settingsPage">
    <header className="settingsHeader"><div><Link href="/">← 返回对话</Link><h1>设置</h1><p>管理模型、工作区和 MCP。保存后从下一轮开始生效。</p></div></header>
    {state.kind === "loading" && <p role="status">正在加载设置…</p>}
    {state.kind === "error" && <div role="alert"><p>{state.message}</p><button onClick={() => void refresh()}>重试</button>
      {state.recoverable && state.token && <button disabled={busy} onClick={() => void recoverInvalidSettings(state.token!)}>备份损坏文件并重新配置</button>}</div>}
    {state.kind === "ready" && <>
      {notice && <p className="settingsNotice" role="status">{notice}</p>}
      {state.settings.source !== "managed" && <section className="settingsCard" aria-labelledby="import-heading">
        <h2 id="import-heading">旧配置导入</h2>
        <p>从当前项目的旧模型和工作区文件以及 MCP 配置读取预览；确认后写入本机设置。原文件保留。</p>
        <button disabled={busy} onClick={() => void importLegacy("preview")}>预览旧配置</button>
        {importPreview && <div role="status">
          <p>模型：{importPreview.providers.join("、") || "无"}；工作区：{importPreview.workspaces.join("、") || "无"}；MCP：{importPreview.mcpServers.join("、") || "无"}</p>
          {importPreview.missingCredentials.length > 0 && <p>缺少环境凭据：{importPreview.missingCredentials.join("、")}</p>}
          <button disabled={busy} onClick={() => void importLegacy("commit")}>确认导入</button>
        </div>}
      </section>}
      <section className="settingsCard" aria-labelledby="model-heading">
        <h2 id="model-heading">模型</h2>
        <p>API 地址使用 OpenAI 兼容协议。密钥只保存在本机或从环境变量读取。</p>
        <ul>{state.settings.providers.map((provider) => <li key={provider.id}>
          <strong>{provider.displayName}</strong> <span>{provider.model}</span> <small>{provider.credential.kind === "environment" ? `环境变量 ${provider.credential.variable}` : provider.credential.kind === "local" ? "本机密钥已保存" : "未配置凭据，模型已停用"}</small>
          <button disabled={busy || !provider.enabled} onClick={() => void probeProvider(provider.id)}>{probeStatus[provider.id] === "测试中…" ? "取消测试" : "测试连接"}</button>
          <small role="status">{probeStatus[provider.id] ?? "未测试"}</small>
          <button disabled={busy} onClick={() => { setEditingProviderId(provider.id); setModelName(provider.displayName); setModelId(provider.model);
            setApiUrl(provider.baseUrl); setWindowTokens(provider.context.windowTokens);
            setKeyKind(provider.credential.kind === "local" ? "local" : "environment"); setKeyValue(""); }}>编辑</button>
          {provider.credential.kind !== "none" && <button disabled={busy} onClick={() => void apply({ type: "provider-edit", id: provider.id, credential: { kind: "none" } })}>清除凭据并停用</button>}
          <button disabled={busy || !provider.enabled || state.settings.defaultProviderId === provider.id} onClick={() => void apply({ type: "provider-default", id: provider.id })}>设为默认</button>
          <button disabled={busy} onClick={() => void apply({ type: "provider-enable", id: provider.id, enabled: !provider.enabled })}>{provider.enabled ? "停用" : "启用"}</button>
        </li>)}</ul>
        <form onSubmit={submitModel} className="settingsForm">
          <label>显示名称<input required value={modelName} onChange={(event) => setModelName(event.target.value)} /></label>
          <label>模型 ID<input required value={modelId} onChange={(event) => setModelId(event.target.value)} /></label>
          <label>API 地址<input required type="url" placeholder="https://example.com/v1" value={apiUrl} onChange={(event) => setApiUrl(event.target.value)} /></label>
          <label>凭据来源<select value={keyKind} onChange={(event) => setKeyKind(event.target.value === "local" ? "local" : "environment")}><option value="environment">环境变量</option><option value="local">本机保存</option></select></label>
          <label>{keyKind === "local" ? "API Key" : "环境变量名"}<input required={!editingProviderId} type={keyKind === "local" ? "password" : "text"} autoComplete="off" placeholder={editingProviderId ? "留空保留原凭据" : undefined} value={keyValue} onChange={(event) => setKeyValue(event.target.value)} /></label>
          <label>上下文窗口 Tokens<input required type="number" min={16000} max={10000000} value={windowTokens} onChange={(event) => setWindowTokens(Number(event.target.value))} /></label>
          <button disabled={busy} type="submit">{editingProviderId ? "保存模型" : "添加模型"}</button>
          {editingProviderId && <button type="button" onClick={() => { setEditingProviderId(undefined); setKeyValue(""); }}>取消编辑</button>}
        </form>
      </section>
      <section className="settingsCard" aria-labelledby="workspace-heading">
        <h2 id="workspace-heading">工作区</h2><p>填写运行 OrbitCode 的这台电脑上的绝对路径。</p>
        <ul>{state.settings.workspaces.map((workspace) => <li key={workspace.id}>
          <strong>{workspace.name}</strong> <code>{workspace.rootPath}</code>
          <button disabled={busy} onClick={() => { setRenamingWorkspaceId(workspace.id); setWorkspaceName(workspace.name); setWorkspacePath(workspace.rootPath); }}>改名</button>
          <button disabled={busy || !workspace.enabled || state.settings.defaultWorkspaceId === workspace.id} onClick={() => void apply({ type: "workspace-default", id: workspace.id })}>设为默认</button>
          <button disabled={busy} onClick={() => void apply({ type: "workspace-enable", id: workspace.id, enabled: !workspace.enabled })}>{workspace.enabled ? "停用" : "启用"}</button>
          <button disabled={busy} onClick={() => void apply({ type: "workspace-remove", id: workspace.id })}>移除记录（不删除目录）</button>
        </li>)}</ul>
        <form onSubmit={submitWorkspace} className="settingsForm">
          <label>名称<input required value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} /></label>
          <label>本机目录<input required readOnly={Boolean(renamingWorkspaceId)} value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder="/Users/name/project" /></label>
          <button disabled={busy} type="submit">{renamingWorkspaceId ? "保存名称" : "添加工作区"}</button>
          {renamingWorkspaceId && <button type="button" onClick={() => setRenamingWorkspaceId(undefined)}>取消改名</button>}
        </form>
      </section>
      <section className="settingsCard" aria-labelledby="mcp-heading">
        <h2 id="mcp-heading">MCP Server</h2><p>保存配置不会自动连接或运行本地命令。对话使用时仍会请求相应授权。同名、同作用域保存会替换原配置。</p>
        <ul>{state.settings.mcpServers.map((server) => <li key={`${server.scope}:${server.workspaceId ?? ""}:${server.name}`}>
          <strong>{server.name}</strong> <span>{server.scope === "user" ? "用户级" : `工作区 ${server.workspaceId}`}</span> <span>{server.type}</span> <small>{server.endpoint}</small>
          <button disabled={busy} onClick={() => { setMcpName(server.name); setMcpType(server.type); setMcpWorkspace(server.workspaceId ?? ""); setMcpTarget(""); setMcpArgs("[]"); setMcpVariables("{}"); setNotice("请填写完整替换配置；已保存的凭据不会返回表单。"); }}>替换配置</button>
          {server.enabled && <button disabled={busy} onClick={() => void manageMcp(server, "connect")}>{mcpStatus[`${server.scope}:${server.workspaceId ?? ""}:${server.name}`] === "连接中…" ? "取消连接" : "连接并发现工具"}</button>}
          {server.enabled && <button disabled={busy || mcpStatus[`${server.scope}:${server.workspaceId ?? ""}:${server.name}`] === "连接中…"} onClick={() => void manageMcp(server, "disconnect")}>断开连接</button>}
          {mcpStatus[`${server.scope}:${server.workspaceId ?? ""}:${server.name}`] && <small role="status">{mcpStatus[`${server.scope}:${server.workspaceId ?? ""}:${server.name}`]}</small>}
          <button disabled={busy} onClick={() => void apply({ type: "mcp-enable", name: server.name, scope: server.scope, ...(server.workspaceId ? { workspaceId: server.workspaceId } : {}), enabled: !server.enabled })}>{server.enabled ? "停用" : "启用"}</button>
          <button disabled={busy} onClick={() => void apply({ type: "mcp-remove", name: server.name, scope: server.scope, ...(server.workspaceId ? { workspaceId: server.workspaceId } : {}) })}>移除配置</button>
        </li>)}</ul>
        <form onSubmit={submitMcp} className="settingsForm">
          <label>名称<input required value={mcpName} onChange={(event) => setMcpName(event.target.value)} /></label>
          <label>类型<select value={mcpType} onChange={(event) => setMcpType(event.target.value === "stdio" ? "stdio" : "http")}><option value="http">HTTP</option><option value="stdio">本地命令</option></select></label>
          <label>{mcpType === "http" ? "服务地址" : "命令"}<input required value={mcpTarget} onChange={(event) => setMcpTarget(event.target.value)} /></label>
          {mcpType === "stdio" && <label>参数（JSON 数组）<input value={mcpArgs} onChange={(event) => setMcpArgs(event.target.value)} placeholder={'["--port", "3000"]'} /></label>}
          <label>{mcpType === "http" ? "Headers（JSON 对象）" : "环境变量（JSON 对象）"}<textarea rows={3} value={mcpVariables} onChange={(event) => setMcpVariables(event.target.value)} /></label>
          <label>作用范围<select value={mcpWorkspace} onChange={(event) => setMcpWorkspace(event.target.value)}><option value="">所有工作区</option>{state.settings.workspaces.filter((workspace) => workspace.enabled).map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>
          <button disabled={busy} type="submit">保存 MCP 配置</button>
        </form>
      </section>
      <section className="settingsCard" aria-labelledby="preferences-heading">
        <h2 id="preferences-heading">运行偏好</h2>
        <p>新权限会话使用默认模式；最大轮数和总时限从下一轮对话开始生效。</p>
        <form className="settingsForm" onSubmit={(event) => { event.preventDefault(); void apply({ type: "preferences-set", maxIterations, maxRuntimeMinutes, defaultPermissionMode }); }}>
          <label>默认权限模式<select value={defaultPermissionMode} onChange={(event) => {
            const value = event.target.value;
            if (value === "strict" || value === "default" || value === "permissive") setDefaultPermissionMode(value);
          }}>
            <option value="strict">严格</option><option value="default">默认</option><option value="permissive">放行</option>
          </select></label>
          <label>最大模型轮数<input type="number" min={1} max={32} required value={maxIterations} onChange={(event) => setMaxIterations(Number(event.target.value))} /></label>
          <label>单轮最长运行分钟<input type="number" min={1} max={1440} required value={maxRuntimeMinutes} onChange={(event) => setMaxRuntimeMinutes(Number(event.target.value))} /></label>
          <button disabled={busy} type="submit">保存运行偏好</button>
        </form>
      </section>
    </>}
  </main>;
}

function isSettings(value: unknown): value is PublicSettings {
  return typeof value === "object" && value !== null && "revision" in value && typeof value.revision === "number" && "providers" in value && Array.isArray(value.providers) && "workspaces" in value && Array.isArray(value.workspaces) && "mcpServers" in value && Array.isArray(value.mcpServers);
}
function errorMessage(value: unknown, fallback: string): string {
  return typeof value === "object" && value !== null && "error" in value && typeof value.error === "string" ? value.error : fallback;
}
function isImportPreview(value: unknown): value is { previewId: string; providers: string[]; workspaces: string[]; mcpServers: string[]; missingCredentials: string[] } {
  return typeof value === "object" && value !== null && "previewId" in value && typeof value.previewId === "string" &&
    "providers" in value && Array.isArray(value.providers) && "workspaces" in value && Array.isArray(value.workspaces) &&
    "mcpServers" in value && Array.isArray(value.mcpServers) && "missingCredentials" in value && Array.isArray(value.missingCredentials);
}

function detailMessage(value: unknown, fallback: string): string { return typeof value === "object" && value !== null && "detail" in value && typeof value.detail === "string" ? value.detail : fallback; }
function mcpDetail(value: unknown, fallback: string): string {
  const detail = detailMessage(value, fallback);
  if (typeof value !== "object" || value === null || !("tools" in value) || !Array.isArray(value.tools) || !value.tools.every((item: unknown) => typeof item === "string")) return detail;
  return `${detail} 工具：${value.tools.length ? value.tools.join("、") : "无"}`;
}
function isInvalidSettings(value: unknown): boolean { return typeof value === "object" && value !== null && "code" in value && value.code === "invalid"; }
function isRecovery(value: unknown): value is { backup: string; settings: PublicSettings } { return typeof value === "object" && value !== null && "backup" in value && typeof value.backup === "string" && "settings" in value && isSettings(value.settings); }

function parseStringMap(source: string): Record<string, string> {
  const value: unknown = JSON.parse(source);
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.values(value).some((item) => typeof item !== "string")) throw new Error("invalid-map");
  return value as Record<string, string>;
}
function parseStringArray(source: string): string[] {
  const value: unknown = JSON.parse(source);
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === "string")) throw new Error("invalid-array");
  return value;
}
