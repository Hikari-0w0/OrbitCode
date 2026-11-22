"use client";
import { useRef, useState } from "react";
import type { ConversationSummary } from "@/core/conversations/types";
export function ConversationList({ conversations, selectedId, disabled, actionsDisabled = false, onSelect, onCreate, onRename, onDelete }: {
    readonly conversations: readonly ConversationSummary[];
    readonly selectedId: string;
    readonly disabled: boolean;
    readonly actionsDisabled?: boolean;
    readonly onSelect: (id: string) => void;
    readonly onCreate: () => void;
    readonly onRename: () => void;
    readonly onDelete: () => void;
}) {
    const [search, setSearch] = useState("");
    const searchInput = useRef<HTMLInputElement>(null);
    const query = search.trim().toLocaleLowerCase();
    const visible = conversations.filter(item => item.title.toLocaleLowerCase().includes(query));
    const selectionActionsDisabled = disabled || actionsDisabled || !visible.some(item => item.id === selectedId);
    function clearSearch() {
        setSearch("");
        searchInput.current?.focus();
    }
    return (
        <section className="conversationNavigation" aria-label="本地会话">
            <button type="button" className="newConversation" disabled={disabled || actionsDisabled} onClick={onCreate}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>
                新建对话
            </button>
            <div className="conversationSearch">
                <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="4.5" /><path d="m12 12 4 4" /></svg>
                <input ref={searchInput} aria-label="搜索会话" type="search" placeholder="搜索对话…" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => {
                    if (event.key === "Escape" && search && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        event.stopPropagation();
                        clearSearch();
                    }
                }}/>
                {search && <button type="button" className="clearSearch" aria-label="清除搜索" onClick={clearSearch}>×</button>}
            </div>
            <div className="conversationListHeading"><span className="sectionLabel" role="status">{query ? `搜索结果 · ${visible.length}` : "最近对话"}</span></div>
            <div className="conversationItems">
                {visible.length === 0 && <p className="fieldHint">{search ? "没有匹配的会话" : "从一个新对话开始"}</p>}
                {visible.map(item => {
                    const selected = item.id === selectedId;
                    return (
                        <button
                            key={item.id}
                            type="button"
                            className={selected ? "conversationItem conversationItem--active" : "conversationItem"}
                            aria-current={selected ? "page" : undefined}
                            disabled={disabled}
                            onClick={() => onSelect(item.id)}
                        >
                            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 4.5h13v9h-8L5 16v-2.5H3.5z" /></svg>
                            <span>{item.title}</span>
                        </button>
                    );
                })}
            </div>
            <div className="conversationActions">
                <button type="button" disabled={selectionActionsDisabled} onClick={onRename}>重命名</button>
                <button type="button" disabled={selectionActionsDisabled} onClick={onDelete}>删除</button>
            </div>
        </section>
    );
}
