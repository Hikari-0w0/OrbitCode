"use client";

import type { ConversationSummary } from "@/core/conversations/types";

export function ConversationList({
  conversations,
  selectedId,
  disabled,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: {
  readonly conversations: readonly ConversationSummary[];
  readonly selectedId: string;
  readonly disabled: boolean;
  readonly onSelect: (conversationId: string) => void;
  readonly onCreate: () => void;
  readonly onRename: () => void;
  readonly onDelete: () => void;
}) {
  return (
    <div className="providerSection">
      <label htmlFor="conversation-select">LOCAL CONVERSATIONS</label>
      <div className="selectWrap">
        <select
          id="conversation-select"
          aria-label="LOCAL CONVERSATIONS"
          value={selectedId}
          disabled={disabled}
          onChange={(event) => onSelect(event.target.value)}
        >
          {conversations.length === 0 && <option value="">暂无会话</option>}
          {conversations.map((conversation) => (
            <option key={conversation.id} value={conversation.id}>
              {conversation.title}
            </option>
          ))}
        </select>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4" /></svg>
      </div>
      <div className="conversationActions">
        <button type="button" disabled={disabled} onClick={onCreate}>新建</button>
        <button type="button" disabled={disabled || !selectedId} onClick={onRename}>重命名</button>
        <button type="button" disabled={disabled || !selectedId} onClick={onDelete}>删除</button>
      </div>
    </div>
  );
}
