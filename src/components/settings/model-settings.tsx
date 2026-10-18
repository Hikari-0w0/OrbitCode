"use client";
import type { useSettings } from "./use-settings";
export function ModelSettings({ controller }: {
    readonly controller: ReturnType<typeof useSettings>;
}) {
    const { state, busy, probeStatus, modelName, setModelName, modelId, setModelId, apiUrl, setApiUrl, keyKind, setKeyKind, keyValue, setKeyValue, windowTokens, setWindowTokens, editingProviderId, setEditingProviderId, apply, probeProvider, submitModel } = controller;
    if (state.kind !== "ready")
        return null;
    return <section className="settingsCard" aria-labelledby="model-heading">
        <h2 id="model-heading">模型</h2>
        <p>API 地址使用 OpenAI 兼容协议。密钥只保存在本机或从环境变量读取。</p>
        <ul>{state.settings.providers.map((provider) => <li key={provider.id}>
          <strong>{provider.displayName}</strong> <span>{provider.model}</span> <small>{provider.credential.kind === "environment" ? `环境变量 ${provider.credential.variable}` : provider.credential.kind === "local" ? "本机密钥已保存" : "未配置凭据，模型已停用"}</small>
          <button disabled={busy || controller.dirty || !provider.enabled} onClick={() => void probeProvider(provider.id)}>{probeStatus[provider.id] === "测试中…" ? "取消测试" : "测试连接"}</button>
          <small role="status">{probeStatus[provider.id] ?? "未测试"}</small>
          <button disabled={busy || controller.dirty} onClick={() => {
                setEditingProviderId(provider.id);
                setModelName(provider.displayName);
                setModelId(provider.model);
                setApiUrl(provider.baseUrl);
                setWindowTokens(provider.context.windowTokens);
                setKeyKind(provider.credential.kind === "local" ? "local" : "environment");
                setKeyValue("");
            }}>编辑</button>
          {provider.credential.kind !== "none" && <button disabled={busy || controller.dirty} onClick={() => void apply({ type: "provider-edit", id: provider.id, credential: { kind: "none" } })}>清除凭据并停用</button>}
          <button disabled={busy || controller.dirty || !provider.enabled || state.settings.defaultProviderId === provider.id} onClick={() => void apply({ type: "provider-default", id: provider.id })}>设为默认</button>
          <button disabled={busy || controller.dirty} onClick={() => void apply({ type: "provider-enable", id: provider.id, enabled: !provider.enabled })}>{provider.enabled ? "停用" : "启用"}</button>
        </li>)}</ul>
        <details className="settingsEditor" open={Boolean(editingProviderId)}><summary>添加或编辑模型</summary><form onSubmit={submitModel} className="settingsForm">
          <label>显示名称<input required value={modelName} onChange={(event) => setModelName(event.target.value)}/></label>
          <label>模型 ID<input required value={modelId} onChange={(event) => setModelId(event.target.value)}/></label>
          <label>API 地址<input required type="url" placeholder="https://example.com/v1" value={apiUrl} onChange={(event) => setApiUrl(event.target.value)}/></label>
          <label>凭据来源<select value={keyKind} onChange={(event) => setKeyKind(event.target.value === "local" ? "local" : "environment")}><option value="environment">环境变量</option><option value="local">本机保存</option></select></label>
          <label>{keyKind === "local" ? "API Key" : "环境变量名"}<input required={!editingProviderId} type={keyKind === "local" ? "password" : "text"} autoComplete="off" placeholder={editingProviderId ? "留空保留原凭据" : undefined} value={keyValue} onChange={(event) => setKeyValue(event.target.value)}/></label>
          <label>上下文窗口 Tokens<input required type="number" min={16000} max={10000000} value={windowTokens} onChange={(event) => setWindowTokens(Number(event.target.value))}/></label>
          <button disabled={busy} type="submit">{editingProviderId ? "保存模型" : "添加模型"}</button>
          {editingProviderId && <button type="button" onClick={() => void controller.confirmLeave().then(ok => { if (ok)
        controller.resetForm(); })}>取消编辑</button>}
        </form></details>
      </section>;
}
