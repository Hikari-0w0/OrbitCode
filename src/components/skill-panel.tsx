"use client";
import { useEffect, useState } from "react";
import type { AgentRuntime } from "@/runtime/agent-runtime";
type Catalog = Awaited<ReturnType<AgentRuntime["inspectSkills"]>>;
export function SkillPanel({ conversationId, revision, disabled, onRun, onChanged }: {
    conversationId: string;
    revision: number;
    disabled: boolean;
    onRun: (command: string, catalogRevision?: string) => void;
    onChanged: () => Promise<unknown>;
}) {
    const [catalog, setCatalog] = useState<Catalog>();
    const [error, setError] = useState("");
    const [argument, setArgument] = useState("");
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        if (!conversationId)
            return;
        const controller = new AbortController();
        fetch(`/api/conversations/${conversationId}/skills`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
            if (!response.ok)
                throw new Error("无法读取 Skill 列表。");
            return response.json() as Promise<Catalog>;
        }).then(value => { setCatalog(value); setError(""); }).catch(() => {
            if (!controller.signal.aborted)
                setError("无法读取 Skill 列表。");
        });
        return () => controller.abort();
    }, [conversationId, revision, disabled]);
    async function mutate(action: "refresh" | "deactivate", name?: string) {
        setBusy(true);
        setError("");
        try {
            const response = await fetch(`/api/conversations/${conversationId}/skills`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, name, expectedRevision: revision, catalogRevision: catalog?.revision }) });
            if (!response.ok)
                throw new Error("Skill 操作失败，请刷新会话后重试。");
            setCatalog(await response.json() as Catalog);
            if (action === "deactivate")
                await onChanged();
        }
        catch (error) {
            setError(error instanceof Error ? error.message : "操作失败。");
        }
        finally {
            setBusy(false);
        }
    }
    if (!conversationId)
        return null;
    return <details className="skillPanel" open><summary>Skills（{catalog?.entries.length ?? 0}）</summary>
    <p>按名称和简介选择流程，需要时加载完整指令。</p>
    <button type="button" disabled={busy} onClick={() => void mutate("refresh")}>刷新 Skill 定义</button>
    <label>Skill 参数 <input value={argument} disabled={disabled || busy} onChange={event => setArgument(event.target.value)} placeholder="可选参数，支持引号"/></label>
    {error && <p role="alert">{error}</p>}
    {catalog?.diagnostics.map((item, index) => <p key={`${item.source}:${item.file}:${index}`} role="status">{item.source}/{item.file}：{item.detail}</p>)}
    {catalog?.overridden?.map(item => <p key={`${item.name}:${item.source}`}>{item.name}：{item.source} 定义已被更高优先级来源覆盖。</p>)}
    <ul>{catalog?.entries.map(item => <li key={item.name}><strong>{item.name}</strong> — {item.description}（{item.source} · {item.mode} · {item.availability}）{item.active ? " 已激活" : ""}{item.updateAvailable ? "，可更新" : ""} <button type="button" disabled={disabled || busy || item.availability === "blocked"} onClick={() => onRun(`/skill run ${item.name}${argument ? ` ${argument}` : ""}`, catalog?.revision)}>调用</button></li>)}</ul>
    {catalog?.active.map(item => <p key={item.name}>已激活：{item.name} <button type="button" disabled={disabled || busy} onClick={() => void mutate("deactivate", item.name)}>停用</button></p>)}
    <p>命令：/skills · /skills refresh · /skill run 名称 参数 · /skill deactivate 名称</p>
  </details>;
}
