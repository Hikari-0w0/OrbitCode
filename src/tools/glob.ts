export class GlobPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlobPatternError";
  }
}

export interface GlobMatcher {
  matches(relativePath: string): boolean;
}

export function compileGlob(pattern: string): GlobMatcher {
  if (pattern.length === 0) throw new GlobPatternError("文件模式不能为空。");
  if (pattern.length > 512) throw new GlobPatternError("文件模式过长。");
  if (pattern.includes("\0") || pattern.includes("\\")) {
    throw new GlobPatternError("文件模式包含非法字符。");
  }
  if (pattern.includes("{") || pattern.includes("}")) {
    throw new GlobPatternError(
      "受限 Glob 不支持花括号扩展；请分别查找或使用更宽的模式。",
    );
  }
  if (pattern.startsWith("/") || pattern.endsWith("/")) {
    throw new GlobPatternError("文件模式必须是相对文件模式。");
  }
  const segments = pattern.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        (segment.includes("**") && segment !== "**"),
    )
  ) {
    throw new GlobPatternError("文件模式包含无效路径段。");
  }

  return {
    matches(relativePath) {
      const pathSegments = relativePath.split("/").filter(Boolean);
      return matchSegments(segments, pathSegments);
    },
  };
}

function matchSegments(
  pattern: readonly string[],
  value: readonly string[],
): boolean {
  const cache = new Map<string, boolean>();
  function visit(patternIndex: number, valueIndex: number): boolean {
    const key = `${patternIndex}:${valueIndex}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    let matched: boolean;
    if (patternIndex === pattern.length) {
      matched = valueIndex === value.length;
    } else if (pattern[patternIndex] === "**") {
      matched =
        visit(patternIndex + 1, valueIndex) ||
        (valueIndex < value.length && visit(patternIndex, valueIndex + 1));
    } else {
      matched =
        valueIndex < value.length &&
        matchSegment(pattern[patternIndex], value[valueIndex]) &&
        visit(patternIndex + 1, valueIndex + 1);
    }
    cache.set(key, matched);
    return matched;
  }
  return visit(0, 0);
}

function matchSegment(pattern: string, value: string): boolean {
  const rows = Array.from({ length: pattern.length + 1 }, () =>
    Array<boolean>(value.length + 1).fill(false),
  );
  rows[0][0] = true;
  for (let patternIndex = 1; patternIndex <= pattern.length; patternIndex++) {
    const token = pattern[patternIndex - 1];
    if (token === "*") rows[patternIndex][0] = rows[patternIndex - 1][0];
    for (let valueIndex = 1; valueIndex <= value.length; valueIndex++) {
      rows[patternIndex][valueIndex] =
        token === "*"
          ? rows[patternIndex - 1][valueIndex] || rows[patternIndex][valueIndex - 1]
          : (token === "?" || token === value[valueIndex - 1]) &&
            rows[patternIndex - 1][valueIndex - 1];
    }
  }
  return rows[pattern.length][value.length];
}
