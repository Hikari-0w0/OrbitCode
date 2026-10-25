export function tokenize(text: string): string[] {
  const words = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z0-9]+|[\p{Script=Han}]+/gu) ?? [];
  const tokens = words.flatMap(word => /\p{Script=Han}/u.test(word) ? Array.from(word).flatMap((char, i, chars) => i + 1 < chars.length ? [char + chars[i + 1]] : chars.length === 1 ? [char] : []) : [word]);
  return [...tokens, ...(text.match(/[A-Za-z][A-Za-z0-9_]*[_A-Z][A-Za-z0-9_]*/g) ?? []).map(word => word.toLowerCase())];
}
