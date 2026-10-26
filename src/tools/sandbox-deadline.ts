import type { CommandExecution } from "@/tools/command-sandbox";
import { emptyExecution } from "@/tools/sandbox-process";

export async function runWithSandboxDeadline(
  timeoutMs: number,
  cancellation: AbortSignal,
  execute: (signal: AbortSignal) => Promise<CommandExecution>,
): Promise<CommandExecution> {
  if (cancellation.aborted) return emptyExecution({ cancelled: true });
  const deadline = new AbortController();
  const signal = AbortSignal.any([cancellation, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(new Error("命令总时限已到。")), timeoutMs);
  const interrupted = () => {
    const timedOut = deadline.signal.aborted && signal.reason === deadline.signal.reason;
    return { ...emptyExecution({ cancelled: !timedOut }), timedOut };
  };
  try {
    const result = await execute(signal);
    if (!signal.aborted) return result;
    const stopped = interrupted();
    return { ...result, timedOut: stopped.timedOut, cancelled: stopped.cancelled };
  } catch (error) {
    if (signal.aborted) return interrupted();
    throw error;
  } finally { clearTimeout(timer); }
}

export function waitForSandboxProbe<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    // 共享探测可供下一条命令复用；取消等待不能取消其他调用者的探测。
    pending.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}
