import type { ContextCompressionResponse } from "@/web/chat-contract";
import type { TokenEstimate } from "@/core/context/types";

export type ContextCompressionUiState =
  | { readonly status: "idle" }
  | { readonly status: "compressing" }
  | ContextCompressionResponse;

type ContextCompressionControlProps = {
  readonly state: ContextCompressionUiState;
  readonly disabled: boolean;
  readonly onCompress: () => void;
};

export function ContextCompressionControl({
  state,
  disabled,
  onCompress,
}: ContextCompressionControlProps) {
  return (
    <div className="contextCompression">
      <button
        className="contextCompressionButton"
        type="button"
        disabled={disabled || state.status === "compressing"}
        onClick={onCompress}
      >
        {state.status === "compressing" ? "压缩中…" : "压缩上下文"}
      </button>
      <span
        className={`contextCompressionStatus contextCompressionStatus--${state.status}`}
        aria-live="polite"
      >
        {compressionStatusText(state)}
      </span>
    </div>
  );
}

function compressionStatusText(state: ContextCompressionUiState): string {
  if (state.status === "idle") return "可手动释放较早上下文";
  if (state.status === "compressing") return "正在生成结构化摘要";
  if (state.status === "succeeded") {
    return `${formatEstimate(state.before)} → ${formatEstimate(state.after)}`;
  }
  const prefix = state.status === "circuit-open" ? "自动压缩已熔断" : "压缩失败";
  return `${prefix}：${state.failure.message}（压缩前 ${formatEstimate(state.before)}）`;
}

function formatEstimate(estimate: TokenEstimate): string {
  const source = estimate.source === "usage-anchor" ? "usage 锚点估算" : "字符近似";
  return `约 ${formatTokens(estimate.tokens)} Token（${source}）`;
}

function formatTokens(tokens: number): string {
  return new Intl.NumberFormat("zh-CN").format(tokens);
}
