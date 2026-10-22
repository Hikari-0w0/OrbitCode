// 仅用于可结构化复制的数据快照，不接受带方法的资源、Set 或 Map。
export function immutableSnapshot<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (typeof item !== "object" || item === null) return;
    if (item instanceof Set || item instanceof Map) throw new Error("不可变快照必须先将集合转换为数据数组。");
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(copy);
  return copy;
}
