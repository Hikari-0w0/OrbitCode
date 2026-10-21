"use client";
import { DEFAULT_SUB_AGENT_LIMITS, type SubAgentLimits } from "@/core/sub-agents/types";
import type { useSettings } from "./use-settings";
export function RuntimeSettings({ controller }: {
    readonly controller: ReturnType<typeof useSettings>;
}) {
    const { busy, maxIterations, setMaxIterations, maxRuntimeMinutes, setMaxRuntimeMinutes, defaultPermissionMode, apply } = controller;
    if (controller.state.kind !== "ready")
        return null;
    return <section className="settingsCard" aria-labelledby="preferences-heading">
        <h2 id="preferences-heading">运行偏好</h2>
        <p>主 Agent、子任务与独立 Skill 均无需人工审批；最大轮数和总时限从下一轮对话开始生效。</p>
        <form className="settingsForm" onSubmit={(event) => { event.preventDefault(); const data=new FormData(event.currentTarget);const read=(key:keyof SubAgentLimits)=>Number(data.get(key));void apply({ type: "preferences-set", maxIterations, maxRuntimeMinutes, defaultPermissionMode, subAgents:{groupTokens:read("groupTokens"),groupRequests:read("groupRequests"),perTurn:read("perTurn"),capacity:read("capacity"),concurrency:read("concurrency"),maxIterations:read("maxIterations"),maxRuntimeMinutes:read("maxRuntimeMinutes"),waitSeconds:read("waitSeconds")} }); }}>
          <label>最大模型轮数<input type="number" min={1} max={32} required value={maxIterations} onChange={(event) => setMaxIterations(Number(event.target.value))}/></label>
          <label>单轮最长运行分钟<input type="number" min={1} max={1440} required value={maxRuntimeMinutes} onChange={(event) => setMaxRuntimeMinutes(Number(event.target.value))}/></label>
          <fieldset><legend>子 Agent 预算</legend>{([
            ["groupRequests","每轮任务组模型请求上限",4096],["groupTokens","任务组token预算（0为关闭）",1000000000],["perTurn","每轮子任务数量",32],["capacity","运行时任务容量",256],["concurrency","子执行并发",8],["maxIterations","子任务模型轮数",32],["maxRuntimeMinutes","子任务时限（分钟）",1440],["waitSeconds","前台等待（秒）",300]
          ] as const).map(([key,label,max])=><label key={key}>{label}<input name={key} type="number" required min={key==="groupTokens"?0:1} max={max} defaultValue={controller.state.kind==="ready" ? controller.state.settings.subAgents?.[key]??DEFAULT_SUB_AGENT_LIMITS[key] : DEFAULT_SUB_AGENT_LIMITS[key]}/></label>)}</fieldset>
          <p>任务组请求额度由本轮父模型、子任务、独立 Skill、摘要及传输重试共享；父回复结束后，后台任务继续使用原额度。额度耗尽会阻止新请求，已开始的请求继续收尾。token预算启用后按输入UTF-8字节与输出上限保守预留，缺失usage不退款；未配置模型输出上限时使用8192。该限制是本地接纳策略，不是厂商计费保证。</p>
          <button disabled={busy} type="submit">保存运行偏好</button>
        </form>
      </section>;
}
