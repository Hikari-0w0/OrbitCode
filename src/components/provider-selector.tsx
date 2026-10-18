import type { ProviderSummary } from "@/web/chat-contract";
export function ProviderSelector({ providers, selected, disabled, onChange }: {
    readonly providers: readonly ProviderSummary[];
    readonly selected: string;
    readonly disabled: boolean;
    readonly onChange: (value: string) => void;
}) {
    return <div className="providerSection"><label htmlFor="provider-select">模型</label><select id="provider-select" aria-label="MODEL PROVIDER" value={selected} disabled={disabled} onChange={event => onChange(event.target.value)}>{!providers.length && <option value="">等待配置</option>}{selected && !providers.some(item => item.name === selected) && <option value={selected} disabled>{selected}（不可用）</option>}{providers.map(provider => <option key={provider.name} value={provider.name} disabled={!provider.available}>{provider.displayName ?? provider.name}{!provider.available ? "（不可用）" : ""}</option>)}</select><p className="fieldHint">切换模型或工作区将新建会话，原会话保留。</p></div>;
}
