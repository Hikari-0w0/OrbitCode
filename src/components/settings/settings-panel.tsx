"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSettings } from "./use-settings";
import { ModelSettings } from "./model-settings";
import { WorkspaceSettings } from "./workspace-settings";
import { McpSettings } from "./mcp-settings";
import { RuntimeSettings } from "./runtime-settings";
import { RecoverySettings } from "./recovery-settings";
import { ThemeControl } from "../theme-control";
import type { SettingsSection } from "../ui-state";
const sections: readonly {
    id: SettingsSection;
    label: string;
    description: string;
}[] = [
    { id: "models", label: "模型", description: "连接你选择的模型服务。" }, { id: "workspaces", label: "工作区", description: "管理 OrbitCode 可以访问的本机项目。" }, { id: "mcp", label: "MCP", description: "扩展工具，连接外部能力。" }, { id: "runtime", label: "运行偏好", description: "控制执行边界与默认审批。" }, { id: "recovery", label: "配置恢复", description: "导入旧配置与恢复本机设置。" }, { id: "appearance", label: "外观", description: "让工作台适合你的阅读习惯。" },
];
export function SettingsPanel({ initialSection = "models" }: {
    readonly initialSection?: SettingsSection;
}) {
    const controller = useSettings();
    const router = useRouter();
    const [section, setSection] = useState<SettingsSection>(initialSection);
    async function navigate(id: SettingsSection) { if (id === section || !await controller.confirmLeave())
        return; setSection(id); window.history.replaceState(null, "", `/settings?section=${id}`); }
    const { state } = controller;
    return <main className="settingsPage"><header className="settingsHeader"><div><button type="button" className="backButton" disabled={controller.busy} onClick={async () => { if (await controller.confirmLeave())
        router.push("/"); }}>← 返回对话</button><h1>设置</h1><p>把工作环境调整到顺手的状态。配置变更从下一轮生效。</p></div></header><div className="settingsLayout"><nav className="settingsNavigation" aria-label="设置分类">{sections.map(item => <button key={item.id} type="button" aria-current={section === item.id ? "page" : undefined} disabled={controller.busy} onClick={() => void navigate(item.id)}>{item.label}</button>)}</nav><div className="settingsContent" onChangeCapture={event => { if (event.target instanceof Element && event.target.closest("form"))
        controller.setDirty(true); }}>
    {controller.notice && <p className="settingsNotice" role="status">{controller.notice}</p>}
    {state.kind === "loading" && <p role="status">正在加载设置…</p>}
    {state.kind === "error" && <div className="settingsCard" role="alert"><h2>配置暂不可用</h2><p>{state.message}</p><button type="button" onClick={() => void controller.refresh()}>重试</button>{state.recoverable && state.token && <button type="button" disabled={controller.busy} onClick={() => { if (state.token)
        void controller.recoverInvalidSettings(state.token); }}>备份损坏文件并重新配置</button>}</div>}
    {state.kind === "ready" && <fieldset className="settingsFields" disabled={controller.busy}><p className="settingsDescription">{sections.find(item => item.id === section)?.description}</p>{section === "models" && <ModelSettings controller={controller}/>}{section === "workspaces" && <WorkspaceSettings controller={controller}/>}{section === "mcp" && <McpSettings controller={controller}/>}{section === "runtime" && <RuntimeSettings controller={controller}/>}{section === "recovery" && (state.settings.source !== "managed" ? <RecoverySettings controller={controller}/> : <section className="settingsCard"><h2>本机配置正常</h2><p>当前已使用界面管理的设置。模型、工作区和 MCP 可在左侧分类中维护。</p></section>)}</fieldset>}
    {section === "appearance" && <section className="settingsCard" onChangeCapture={event => event.stopPropagation()}><h2>外观</h2><p>选择浅色、深色，或随系统自动切换。</p><ThemeControl /></section>}
    {controller.dirty && <div className="unsavedBar" role="status">有未保存的编辑 <button type="button" disabled={controller.busy} onClick={async () => { await controller.confirmLeave(); }}>放弃编辑</button></div>}
  </div></div>{controller.dialog}</main>;
}
