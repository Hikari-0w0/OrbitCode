"use client";
import type { useSettings } from "./use-settings";
export function RuntimeSettings({ controller }: {
    readonly controller: ReturnType<typeof useSettings>;
}) {
    const { busy, maxIterations, setMaxIterations, maxRuntimeMinutes, setMaxRuntimeMinutes, defaultPermissionMode, setDefaultPermissionMode, apply } = controller;
    if (controller.state.kind !== "ready")
        return null;
    return <section className="settingsCard" aria-labelledby="preferences-heading">
        <h2 id="preferences-heading">运行偏好</h2>
        <p>新权限会话使用默认模式；最大轮数和总时限从下一轮对话开始生效。</p>
        <form className="settingsForm" onSubmit={(event) => { event.preventDefault(); void apply({ type: "preferences-set", maxIterations, maxRuntimeMinutes, defaultPermissionMode }); }}>
          <label>默认权限模式<select value={defaultPermissionMode} onChange={(event) => {
            const value = event.target.value;
            if (value === "strict" || value === "default" || value === "permissive")
                setDefaultPermissionMode(value);
        }}>
            <option value="strict">严格</option><option value="default">默认</option><option value="permissive">放行</option>
          </select></label>
          <label>最大模型轮数<input type="number" min={1} max={32} required value={maxIterations} onChange={(event) => setMaxIterations(Number(event.target.value))}/></label>
          <label>单轮最长运行分钟<input type="number" min={1} max={1440} required value={maxRuntimeMinutes} onChange={(event) => setMaxRuntimeMinutes(Number(event.target.value))}/></label>
          <button disabled={busy} type="submit">保存运行偏好</button>
        </form>
      </section>;
}
