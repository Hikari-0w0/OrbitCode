"use client";
import { useState } from "react";
import { useChatWorkspace } from "./use-chat-workspace";
import { WorkspaceShell } from "./workspace-shell";
import { ManagementPanel } from "./management-panel";
import { EnvironmentStatus } from "./environment-status";
import { composerAvailability, type ManagementView } from "./ui-state";
import { ConversationList } from "./conversation-list";
import { ChatComposer } from "./chat-composer";
import { MessageList } from "./message-list";
import { ProviderSelector } from "./provider-selector";
import { WorkspaceSelector } from "./workspace-selector";
import { ContextCompressionControl } from "./context-compression-control";
import { AgentTaskPanel, AgentTaskIndicator } from "./agent-task-panel";
import { useAgentTasks } from "./use-agent-tasks";
import { SkillPanel } from "./skill-panel";
import { ConversationBackgroundPanel } from "./conversation-background-panel";
import { ConversationCleanupPanel } from "./conversation-cleanup-panel";
import { ThemeControl } from "./theme-control";
import { Popover } from "./ui/popover";
const managementNames: Record<ManagementView, string> = { agents: "子 Agent 与任务", skills: "Skills", background: "背景与记忆", cleanup: "历史清理", environment: "工作环境与权限" };
export function ChatWorkspace() {
    const chat = useChatWorkspace();
    const { session } = chat;
    const [panel, setPanel] = useState<ManagementView>();
    const agentTasks = useAgentTasks(session.conversationId, panel === "agents", chat.isStreaming);
    const [panelDirty, setPanelDirty] = useState(false);
    const [discardPanel, setDiscardPanel] = useState(false);
    const title = chat.conversations.find(item => item.id === session.conversationId)?.title ?? "新对话";
    const availability = composerAvailability({ request: session.requestState, catalog: chat.catalogState, permission: chat.permissionSession.status, conversation: chat.conversationState, availability: session.conversationAvailability, unsaved: session.unsavedExpectedRevision !== undefined });
    function closePanel() { if (panelDirty)
        setDiscardPanel(true);
    else
        setPanel(undefined); }
    const navigation = <><div className="brandBlock"><span className="brandSymbol" aria-hidden="true">◎</span><strong>OrbitCode</strong><span className="localBadge">LOCAL</span></div>
    <ConversationList conversations={chat.conversations} selectedId={session.conversationId} disabled={chat.isStreaming || chat.conversationState !== "ready"} actionsDisabled={chat.catalogState !== "ready"} onSelect={id => void chat.loadConversation(id)} onCreate={() => void chat.createConversation(session.selectedWorkspaceId, session.selectedProvider)} onRename={() => void chat.renameConversation()} onDelete={() => void chat.deleteConversation()}/>
    <nav className="sidebarTools" aria-label="工作台管理"><span className="sectionLabel">工作台</span>{(["agents", "skills", "background", "cleanup"] as const).map(view => <button key={view} type="button" onClick={() => setPanel(view)}><span aria-hidden="true">{view === "skills" ? "◇" : view === "background" ? "▤" : "◷"}</span>{managementNames[view]}</button>)}<details className="settingsMenu"><summary>设置</summary>{([['models', '模型'], ['workspaces', '工作区'], ['mcp', 'MCP'], ['runtime', '运行偏好'], ['recovery', '配置恢复'], ['appearance', '外观']] as const).map(([id, name]) => <button key={id} type="button" onClick={() => void chat.openSettings(id)}>{name}</button>)}</details></nav>
    <div className="sidebarBottom"><ThemeControl /><p><span className="statusDot"/> 本地工作区 · 安全边界由服务端执行</p></div></>;
    return <WorkspaceShell navigation={navigation}><section className="chatPanel" aria-label="OrbitCode 对话工作区">
    <header className="chatHeader">
      <div className="headerTitle">
        <h1>{title}</h1>
        <div className="environmentBar">
          <button type="button" onClick={() => setPanel("environment")}>
            <span>{chat.workspaces.find(item => item.id === session.selectedWorkspaceId)?.name ?? "选择工作区"} / {chat.currentProvider?.displayName ?? chat.currentProvider?.name ?? "选择模型"}</span>
            <span aria-hidden="true">⌄</span>
          </button>
          <span className="permissionBadge" aria-label="执行策略">自主执行</span>
        </div>
      </div>
      <div className="headerActions"><AgentTaskIndicator count={agentTasks.count} onOpen={()=>setPanel("agents")}/>
        <span className="connectionState" role="status"><i />{chat.isStreaming ? session.requestState === "stopping" ? "正在停止" : "Agent 运行中" : chat.catalogState === "ready" ? "准备就绪" : "等待配置"}</span>
        <Popover className="conversationMenu" label="•••" accessibleLabel="会话操作"><div><button type="button" onClick={() => void chat.renameConversation()} disabled={chat.controlsDisabled}>重命名</button><button className="exportButton" type="button" aria-label="导出完整对话" disabled={chat.conversationExporting || chat.isStreaming || !session.conversationId} onClick={() => void chat.exportConversation()}>{chat.conversationExporting ? "导出中…" : "导出对话"}</button><button type="button" onClick={() => void chat.clearConversation()} disabled={chat.isStreaming || !session.messages.length}>清空</button><button type="button" className="dangerText" onClick={() => void chat.deleteConversation()} disabled={chat.controlsDisabled}>删除会话</button></div></Popover>
      </div>
    </header>
    <div className="noticeSlot"><EnvironmentStatus availability={availability} detail={chat.notice} onSettings={() => void chat.openSettings()} onReload={chat.reload} onRetry={() => void chat.retryUnsavedTurn()}/>{chat.skillRunStatus && <p className="skillRunStatus" role="status">{chat.skillRunStatus}</p>}</div>
    <MessageList messages={session.messages} currentRunStartedAtMs={chat.isStreaming ? chat.runStartedAt : undefined} onSuggestion={chat.changeDraft} executablePlanMessageId={session.executablePlanMessageId} planActionDisabled={chat.controlsDisabled} onExecutePlan={chat.executePlan}/>
    <div className="inputDock">
      <ChatComposer
        value={session.draft}
        mode={session.mode}
        disabled={availability.kind === "blocked"}
        blockedReason={availability.kind === "blocked" ? availability.message : undefined}
        isStreaming={chat.isStreaming}
        isStopping={session.requestState === "stopping"}
        onModeChange={chat.selectMode}
        delegationKind={chat.delegationKind}
        onDelegationKindChange={chat.setDelegationKind}
        parentExecutionMode={chat.parentExecutionMode}
        onParentExecutionChange={chat.setParentExecutionMode}
        onChange={chat.changeDraft}
        onSubmit={chat.submitMessage}
        onStop={chat.stopGeneration}
        contextControl={<Popover className="composerPopover contextMenu" label={<>上下文{chat.compressionState.status === "compressing" ? " · 压缩中" : chat.compressionState.status === "failed" || chat.compressionState.status === "circuit-open" ? " · 需处理" : ""}</>}>
          <div className="composerPopoverContent">
            <ContextCompressionControl state={chat.compressionState} disabled={session.conversationAvailability !== "ready" || chat.isStreaming} onCompress={() => void chat.compressContext()}/>
          </div>
        </Popover>}
      />
    </div>
  </section><ManagementPanel title={panel ? managementNames[panel] : "管理"} open={Boolean(panel)} onClose={closePanel}>{discardPanel && <div><p>这里有未保存的编辑。放弃后将关闭面板。</p><div className="dialogActions"><button type="button" onClick={() => setDiscardPanel(false)}>继续编辑</button><button type="button" className="dangerText" onClick={() => { setDiscardPanel(false); setPanelDirty(false); setPanel(undefined); }}>放弃编辑</button></div></div>}<div hidden={discardPanel}>
    {panel === "environment" && <><WorkspaceSelector workspaces={chat.workspaces} selectedWorkspaceId={session.selectedWorkspaceId} disabled={chat.bindingControlsDisabled} onChange={chat.selectWorkspace}/><ProviderSelector providers={chat.providers} selected={session.selectedProvider} disabled={chat.bindingControlsDisabled} onChange={chat.selectProvider}/><p className="fieldHint">无需人工审批；Plan/Do 决定工具范围，工作区边界与拒绝规则继续生效。</p></>}
    {panel === "agents" && <AgentTaskPanel key={session.conversationId} conversationId={session.conversationId} tasks={agentTasks.tasks} usage={agentTasks.usage} error={agentTasks.error} onRefresh={agentTasks.refresh}/>}
    {panel === "skills" && <SkillPanel conversationId={session.conversationId} revision={session.revision} disabled={chat.isStreaming} onRun={(command, revision) => { setPanel(undefined); void chat.submitInput(command, session.mode, undefined, revision); }} onChanged={() => chat.loadConversation(session.conversationId, undefined, false)}/>}
    {panel === "background" && <ConversationBackgroundPanel key={session.conversationId} conversationId={session.conversationId} disabled={chat.isStreaming} onDirtyChange={setPanelDirty}/>}
    {panel === "cleanup" && <ConversationCleanupPanel onChanged={chat.onCleanup}/>}
  </div></ManagementPanel>{chat.dialog}</WorkspaceShell>;
}
