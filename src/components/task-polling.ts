type TaskPollingOptions = {
  readonly load: (signal: AbortSignal) => Promise<{ readonly active: boolean }>;
  readonly isVisible: () => boolean;
  readonly onVisibilityChange: (listener: () => void) => () => void;
  readonly onError: () => void;
};

export function startTaskPolling(options: TaskPollingOptions) {
  let stopped = false;
  let loading = false;
  let refreshRequested = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const clearTimer = () => { clearTimeout(timer); timer = undefined; };
  const load = async () => {
    clearTimer();
    if (stopped || !options.isVisible()) return;
    if (loading) { refreshRequested = true; return; }
    loading = true;
    refreshRequested = false;
    const current = new AbortController();
    controller = current;
    let active = false;
    try { active = (await options.load(current.signal)).active; }
    catch { if (!stopped && !current.signal.aborted) options.onError(); }
    finally {
      loading = false;
      if (!stopped && options.isVisible()) {
        // 下一次在本次完成后计时，慢请求不会和定时刷新重叠。
        timer = setTimeout(() => void load(), refreshRequested ? 0 : active ? 1_500 : 15_000);
      }
    }
  };
  const unsubscribe = options.onVisibilityChange(() => {
    if (options.isVisible()) void load();
    else { clearTimer(); controller?.abort(); }
  });
  void load();
  return {
    refresh: () => { void load(); },
    stop: () => { stopped = true; clearTimer(); controller?.abort(); unsubscribe(); },
  };
}
