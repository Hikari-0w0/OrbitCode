"use client";
import { isToolFailurePolicy } from "@/core/tool-failure-policy";
import { DEFAULT_SUB_AGENT_LIMITS, type SubAgentLimits } from "@/core/sub-agents/types";
import type { useSettings } from "./use-settings";
import { CommandSecuritySettings } from "./command-security-settings";
export function RuntimeSettings({ controller }: {
    readonly controller: ReturnType<typeof useSettings>;
}) {
    const { busy, maxIterations, setMaxIterations, maxRuntimeMinutes, setMaxRuntimeMinutes, defaultPermissionMode, apply } = controller;
    if (controller.state.kind !== "ready")
        return null;
    return <section className="settingsCard" aria-labelledby="preferences-heading">
        <h2 id="preferences-heading">运行偏好</h2>
        <p>主 Agent、子任务与独立 Skill 均无需人工审批；最大轮数和总时限从下一轮对话开始生效。</p>
        <form className="settingsForm" onSubmit={(event) => { event.preventDefault(); const data=new FormData(event.currentTarget);const read=(key:keyof SubAgentLimits)=>Number(data.get(key));const failurePolicy=data.get("toolFailurePolicy");void apply({ type: "preferences-set", maxIterations, maxRuntimeMinutes, defaultPermissionMode, ...(isToolFailurePolicy(failurePolicy) ? { toolFailurePolicy: failurePolicy } : {}), subAgents:{groupTokens:read("groupTokens"),groupRequests:read("groupRequests"),perTurn:read("perTurn"),capacity:read("capacity"),concurrency:read("concurrency"),maxIterations:read("maxIterations"),maxRuntimeMinutes:read("maxRuntimeMinutes"),waitSeconds:read("waitSeconds")} }); }}>
          <label><input type="checkbox" checked={maxIterations === "unlimited"} onChange={(event) => setMaxIterations(event.target.checked ? "unlimited" : 8)}/>不限制主 Agent 模型轮数</label>
          <label>最大模型轮数<input type="number" min={1} max={32} required={maxIterations !== "unlimited"} disabled={maxIterations === "unlimited"} value={maxIterations === "unlimited" ? "" : maxIterations} placeholder={maxIterations === "unlimited" ? "不限" : undefined} onChange={(event) => setMaxIterations(Number(event.target.value))}/></label>
          <p>不限轮数时仍可手动停止；总运行时限、任务组请求预算及子任务自己的轮数限制继续生效。</p>
          <label>单轮最长运行分钟<input type="number" min={1} max={1440} required value={maxRuntimeMinutes} onChange={(event) => setMaxRuntimeMinutes(Number(event.target.value))}/></label>
          <label>工具失败处理<select name="toolFailurePolicy" defaultValue={controller.state.settings.toolFailurePolicy ?? "strict"}><option value="strict">严格：重复或同类失败达到预算后停止</option><option value="exact">仅对相同参数重复失败停止</option><option value="warn">只提醒，由模型继续诊断</option></select></label><p>只提醒模式仍受总时限、请求和轮数预算约束，适用于隔离评测；成功操作会重置相关失败计数。</p><fieldset><legend>任务组与子 Agent 预算</legend>{([
            ["groupRequests","每轮任务组模型请求上限",4096],["groupTokens","任务组token预算（0为关闭）",1000000000],["perTurn","每轮子任务数量",32],["capacity","运行时任务容量",256],["concurrency","子执行并发",8],["maxIterations","子任务模型轮数",32],["maxRuntimeMinutes","子任务时限（分钟）",1440],["waitSeconds","前台等待（秒）",300]
          ] as const).map(([key,label,max])=><label key={key}>{label}<input name={key} type="number" required min={key==="groupTokens"?0:1} max={max} defaultValue={controller.state.kind==="ready" ? controller.state.settings.subAgents?.[key]??DEFAULT_SUB_AGENT_LIMITS[key] : DEFAULT_SUB_AGENT_LIMITS[key]}/></label>)}</fieldset>
          <p>任务组请求额度由本轮父模型、子任务、独立 Skill、摘要及传输重试共享；父回复结束后，后台任务继续使用原额度。额度耗尽会阻止新请求，已开始的请求继续收尾。token预算启用后按输入UTF-8字节与输出上限保守预留，缺失usage不退款；未配置模型输出上限时使用8192。该限制是本地接纳策略，不是厂商计费保证。</p>
          <button disabled={busy} type="submit">保存运行偏好</button>
        </form>
        <CommandSecuritySettings controller={controller}/>
      </section>;
}
