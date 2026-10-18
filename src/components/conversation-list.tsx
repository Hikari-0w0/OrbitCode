"use client";
import { useState } from "react";
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
    const visible = conversations.filter(item => item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
    return <section className="conversationNavigation" aria-label="本地会话"><button type="button" className="newConversation" disabled={disabled || actionsDisabled} onClick={onCreate}><span aria-hidden="true">＋</span> 新建对话</button><label className="conversationSearch"><span className="srOnly">搜索会话</span><input type="search" placeholder="搜索对话…" value={search} onChange={event => setSearch(event.target.value)}/></label><div className="conversationListHeading"><span className="sectionLabel">最近对话</span><span>{conversations.length}</span></div><div className="conversationItems">{visible.length === 0 && <p className="fieldHint">{search ? "没有匹配的会话" : "从一个新对话开始"}</p>}{visible.map(item => <button type="button" key={item.id} className={`conversationItem${item.id === selectedId ? " conversationItem--active" : ""}`} aria-current={item.id === selectedId ? "page" : undefined} disabled={disabled} onClick={() => onSelect(item.id)}><span aria-hidden="true">◯</span><span>{item.title}</span></button>)}</div><div className="conversationActions"><button type="button" disabled={disabled || actionsDisabled || !selectedId} onClick={onRename}>重命名</button><button type="button" disabled={disabled || actionsDisabled || !selectedId} onClick={onDelete}>删除</button></div></section>;
}
