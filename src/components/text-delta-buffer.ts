type TextDelta = { readonly iteration: number; readonly text: string };

export function createTextDeltaBuffer(emit: (delta: TextDelta) => void, delayMs = 32) {
  let pending: TextDelta | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function flush(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const delta = pending;
    pending = undefined;
    if (delta) emit(delta);
  }
  return {
    push(delta: TextDelta): void {
      if (pending && pending.iteration !== delta.iteration) flush();
      pending = { iteration: delta.iteration, text: (pending?.text ?? "") + delta.text };
      // 后台标签页可能延迟定时器，限制积累大小，避免无界等待。
      if (pending.text.length >= 8192) flush();
      else timer ??= setTimeout(flush, delayMs);
    },
    flush,
  };
}
