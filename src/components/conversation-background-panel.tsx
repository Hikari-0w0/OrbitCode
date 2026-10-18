"use client";
import { useEffect, useState } from "react";
import { useBeforeUnload } from "./navigation-guard";
type View = {
    background: {
        sources: {
            source: string;
            files: string[];
        }[];
        diagnostics: {
            source: string;
            detail: string;
        }[];
    };
    enabled: boolean;
    jobs: {
        status: string;
        detail: string;
    }[];
    scopes: {
        scope: "user" | "project";
        revision: string;
        notes: {
            id: string;
            title: string;
            markdown: string;
        }[];
    }[];
};
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function parseView(value: unknown): View {
    if (!record(value) || typeof value.enabled !== "boolean" || !record(value.background) || !Array.isArray(value.background.sources) || !Array.isArray(value.background.diagnostics) || !Array.isArray(value.jobs) || !Array.isArray(value.scopes))
        throw new Error("背景响应无效。");
    const sources = value.background.sources.map(x => {
        if (!record(x) || typeof x.source !== "string" || !Array.isArray(x.files) || !x.files.every((file: unknown) => typeof file === "string"))
            throw new Error("来源无效。");
        return { source: x.source, files: x.files.filter((file: unknown): file is string => typeof file === "string") };
    });
    const diagnostics = value.background.diagnostics.map(x => {
        if (!record(x) || typeof x.source !== "string" || typeof x.detail !== "string")
            throw new Error("诊断无效。");
        return { source: x.source, detail: x.detail };
    });
    const jobs = value.jobs.map(x => {
        if (!record(x) || typeof x.status !== "string" || typeof x.detail !== "string")
            throw new Error("状态无效。");
        return { status: x.status, detail: x.detail };
    });
    const scopes = value.scopes.map(x => {
        if (!record(x) || (x.scope !== "user" && x.scope !== "project") || typeof x.revision !== "string" || !Array.isArray(x.notes))
            throw new Error("作用域无效。");
        const scope: "user" | "project" = x.scope;
        const notes = x.notes.map(n => {
            if (!record(n) || typeof n.id !== "string" || typeof n.title !== "string" || typeof n.markdown !== "string")
                throw new Error("笔记无效。");
            return { id: n.id, title: n.title, markdown: n.markdown };
        });
        return { scope, revision: x.revision, notes };
    });
    return { background: { sources, diagnostics }, enabled: value.enabled, jobs, scopes };
}
export function ConversationBackgroundPanel({ conversationId, disabled = false, onDirtyChange }: {
    conversationId: string | null;
    disabled?: boolean;
    onDirtyChange?: (dirty: boolean) => void;
}) {
    const [view, setView] = useState<View>(), [message, setMessage] = useState(""), [busy, setBusy] = useState(false), [editing, setEditing] = useState<{
        scope: "user" | "project";
        revision: string;
        id: string;
        text: string;
    }>();
    useBeforeUnload(Boolean(editing));
    useEffect(() => { onDirtyChange?.(Boolean(editing)); return () => onDirtyChange?.(false); }, [editing, onDirtyChange]);
    const [deleteTarget, setDeleteTarget] = useState<{
        scope: "user" | "project";
        id: string;
        revision: string;
    }>();
    async function load() {
        if (!conversationId)
            return;
        setBusy(true);
        try {
            const response = await fetch(`/api/conversations/${conversationId}/background`, { cache: "no-store" });
            if (!response.ok)
                throw new Error("无法加载背景，请检查指令及配置。");
            setView(parseView(await response.json()));
            setMessage("");
        }
        catch (error) {
            setMessage(error instanceof Error ? error.message : "加载失败。");
        }
        finally {
            setBusy(false);
        }
    }
    async function mutate(body: unknown) {
        setBusy(true);
        try {
            const response = await fetch("/api/memory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
            if (!response.ok)
                throw new Error("保存失败，请重新加载并检查笔记内容。");
            setEditing(undefined);
            await load();
        }
        catch (error) {
            setMessage(error instanceof Error ? error.message : "操作失败。");
        }
        finally {
            setBusy(false);
        }
    }
    return <details className="managementSection" open><summary>项目背景与长期记忆</summary><button type="button" disabled={disabled || busy || !conversationId} onClick={() => void load()} className="mt-2 underline">检查 / 刷新</button>{message && <p role="alert">{message}</p>}{view && <div className="managementStack"><label><input type="checkbox" checked={view.enabled} disabled={disabled || busy || Boolean(editing)} onChange={event => void mutate({ action: "enabled", enabled: event.target.checked })}/> 自动提取长期笔记</label><ul>{view.background.sources.map(source => <li key={source.source}>{source.source}：{source.files.join("、")}</li>)}</ul>{view.background.diagnostics.map((item, i) => <p key={i}>{item.source}：{item.detail}</p>)}{view.jobs.map((job, i) => <p key={i}>{job.status}：{job.detail}</p>)}{view.scopes.map(scope => <section key={scope.scope}><strong>{scope.scope === "user" ? "用户笔记" : "项目笔记"}</strong>{scope.notes.length === 0 && <p>暂无有效笔记</p>}{scope.notes.map(note => <details key={note.id}><summary>{note.title}</summary><pre className="noteContent">{note.markdown}</pre><button type="button" disabled={disabled || busy || Boolean(editing)} onClick={() => setEditing({ scope: scope.scope, revision: scope.revision, id: note.id, text: note.markdown })}>编辑</button>{" "}<button type="button" disabled={disabled || busy || Boolean(editing)} onClick={() => setDeleteTarget({ scope: scope.scope, id: note.id, revision: scope.revision })}>删除</button></details>)}</section>)}{deleteTarget && <div className="inlineConfirm" role="alert"><p>删除这条长期笔记？此操作不可撤销。</p><button type="button" disabled={busy} onClick={() => setDeleteTarget(undefined)}>取消</button><button type="button" disabled={busy} onClick={() => { void mutate({ action: "delete", conversationId, scope: deleteTarget.scope, id: deleteTarget.id, expectedRevision: deleteTarget.revision }); setDeleteTarget(undefined); }}>确认删除笔记</button></div>}{editing && <div><label>笔记 Markdown<textarea className="noteEditor" disabled={busy} rows={10} value={editing.text} onChange={event => setEditing({ ...editing, text: event.target.value })}/></label><button type="button" disabled={disabled || busy} onClick={() => void mutate({ action: "update", conversationId, scope: editing.scope, id: editing.id, expectedRevision: editing.revision, markdown: editing.text })}>保存笔记</button><button type="button" disabled={busy} onClick={() => { setEditing(undefined); }}>取消编辑</button></div>}</div>}</details>;
}
