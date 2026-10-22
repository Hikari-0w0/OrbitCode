import { ContextManagementError } from "./context-errors";
import { approximateTextTokens } from "./token-estimator";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function isPaginatedReadPayload(serialized:string):boolean {
  let value:unknown;try{value=JSON.parse(serialized);}catch{return false;}
  if(!record(value)||value.ok!==true||!record(value.output))return false;
  const output=value.output;
  return (typeof output.reference==="string"||output.source==="child-model-reply"&&typeof output.taskId==="string")&&typeof output.content==="string"&&typeof output.offset==="number"&&Number.isSafeInteger(output.offset)&&output.offset>=0&&typeof output.totalCharacters==="number"&&typeof output.hasMore==="boolean";
}

// 分页读取是有界内容的出口，不能再次变为引用；按实际展示字符数回传同一资源的游标。
export function fitContextReadPayload(serialized: string, budgetTokens: number): string {
  if (approximateTextTokens(serialized) <= budgetTokens) return serialized;
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { return serialized; }
  if (!record(value) || value.ok !== true || !record(value.output)) return serialized;
  const output = value.output;
  if (output.mode === "search" && Array.isArray(output.matches) && typeof output.matchCount === "number") {
    // 搜索已扫描完整正文；缩减展示摘录不改变覆盖范围或精确匹配数。
    for (let count = output.matches.length; count >= 0; count--) {
      const fitted = JSON.stringify({ ...value, output: { ...output, matches: output.matches.slice(0, count), matchesOmitted: output.matchCount - count } });
      if (approximateTextTokens(fitted) <= budgetTokens) return fitted;
    }
    throw new ContextManagementError("capacity", "当前预算不足以展示上下文搜索的覆盖信息。");
  }
  if (!isPaginatedReadPayload(serialized)||typeof output.content!=="string"||typeof output.offset!=="number") return serialized;
  const characters = Array.from(output.content);
  const offset = output.offset;
  const serialize = (length: number) => JSON.stringify({ ...value, output: { ...output, content: characters.slice(0, length).join(""), nextOffset: offset + length, hasMore: true } });
  let low = 0, high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (approximateTextTokens(serialize(middle)) <= budgetTokens) low = middle;
    else high = middle - 1;
  }
  if (low === 0) throw new ContextManagementError("capacity", "当前工具结果预算不足以展示上下文读取内容与游标，请缩小工具批次或调整上下文配置。");
  return serialize(low);
}
