"use client";
import { useState } from "react";
type Candidate = {
    id: string;
    title: string;
    updatedAt: string;
    revision: number;
    eligible: boolean;
    reason: string;
};
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function ConversationCleanupPanel({ onChanged }: {
    onChanged: (deletedIds: readonly string[]) => void;
}) {
    const [candidates, setCandidates] = useState<Candidate[]>([]), [selected, setSelected] = useState<string[]>([]), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
    async function preview() { setBusy(true); try {
        const response = await fetch("/api/conversations/cleanup", { cache: "no-store" });
        const raw: unknown = await response.json();
        if (!response.ok || !record(raw) || !Array.isArray(raw.candidates))
            throw new Error("无法预览。");
        setCandidates(raw.candidates.map(x => { if (!record(x) || !record(x.summary) || typeof x.summary.id !== "string" || typeof x.summary.title !== "string" || typeof x.summary.updatedAt !== "string" || typeof x.summary.revision !== "number" || typeof x.eligible !== "boolean" || typeof x.reason !== "string")
            throw new Error("候选无效。"); return { id: x.summary.id, title: x.summary.title, updatedAt: x.summary.updatedAt, revision: x.summary.revision, eligible: x.eligible, reason: x.reason }; }));
        setSelected([]);
        setMessage("");
    }
    catch {
        setMessage("预览失败，请检查会话状态。");
    }
    finally {
        setBusy(false);
    } }
    async function execute() { if (!selected.length || !window.confirm(`删除选定的 ${selected.length} 个过期会话？`))
        return; setBusy(true); try {
        const response = await fetch("/api/conversations/cleanup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ candidates: candidates.filter(x => selected.includes(x.id)).map(x => ({ id: x.id, expectedRevision: x.revision })) }) });
        const raw: unknown = await response.json();
        if (!response.ok || !record(raw) || !Array.isArray(raw.results))
            throw new Error();
        setMessage(raw.results.map(x => record(x) && typeof x.id === "string" && typeof x.reason === "string" ? `${x.id}：${x.reason}` : "结果无效").join("\n"));
        setSelected([]);
        setCandidates([]);
        onChanged(raw.results.flatMap(item => record(item) && item.status === "deleted" && typeof item.id === "string" ? [item.id] : []));
    }
    catch {
        setMessage("清理失败；已处理项目请重新预览确认。");
    }
    finally {
        setBusy(false);
    } }
    return <details className="rounded-lg border border-white/10 p-3 text-sm"><summary>检查过期会话（30 天）</summary><button type="button" disabled={busy} onClick={() => void preview()} className="underline">预览</button>{candidates.map(item => <label key={item.id} className="block"><input type="checkbox" disabled={!item.eligible || busy} checked={selected.includes(item.id)} onChange={event => setSelected(event.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id))}/>{item.title} · {item.updatedAt} · {item.reason}</label>)}<button type="button" disabled={busy || !selected.length || selected.length > 100} onClick={() => void execute()}>删除选定会话</button><pre className="whitespace-pre-wrap" role="status">{message}</pre></details>;
}
