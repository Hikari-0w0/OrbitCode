import {
  permissionTargetValue,
  type MatchedPermissionRule,
  type PermissionDecision,
  type PermissionRule,
  type PermissionRuleLayer,
  type PermissionSubject,
  type PermissionTargetKind,
} from "@/core/permissions/types";

export const MAX_PERMISSION_RULE_EXPRESSION_LENGTH = 8 * 1024 + 96;

export class PermissionRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionRuleError";
  }
}

export function parsePermissionRule(options: {
  readonly expression: string;
  readonly decision: PermissionDecision;
  readonly source: PermissionRuleLayer;
  readonly toolTargets: ReadonlyMap<string, PermissionTargetKind>;
}): PermissionRule {
  const { expression } = options;
  if (
    expression.length === 0 ||
    expression.length > MAX_PERMISSION_RULE_EXPRESSION_LENGTH ||
    expression.includes("\0")
  ) {
    throw new PermissionRuleError("权限规则为空、过长或包含非法字符。");
  }
  const open = expression.indexOf("(");
  const close = expression.lastIndexOf(")");
  if (open <= 0 || close !== expression.length - 1 || close <= open + 1) {
    throw new PermissionRuleError("权限规则必须使用 工具名(模式) 格式。");
  }
  const toolName = expression.slice(0, open);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(toolName)) {
    throw new PermissionRuleError("权限规则包含无效工具名。");
  }
  const targetKind = options.toolTargets.get(toolName);
  if (!targetKind) {
    throw new PermissionRuleError(`权限规则引用未知工具：${toolName}`);
  }
  const pattern = expression.slice(open + 1, close);
  if (pattern.length === 0 || pattern.includes("\0")) {
    throw new PermissionRuleError("权限规则模式不能为空或包含非法字符。");
  }
  const patternAnalysis = analyzePattern(pattern);
  validatePattern(pattern, targetKind, patternAnalysis);
  return {
    source: options.source,
    expression,
    toolName,
    targetKind,
    pattern,
    matchKind: patternAnalysis.hasGlob ? "glob" : "exact",
    decision: options.decision,
  };
}

export function findMatchingPermissionRules(
  subject: PermissionSubject,
  rules: readonly PermissionRule[],
): readonly PermissionRule[] {
  const target = permissionTargetValue(subject);
  return rules.filter((rule) => {
    if (rule.toolName !== subject.toolName || rule.targetKind !== subject.kind) {
      return false;
    }
    if (rule.matchKind === "exact") return decodePattern(rule.pattern) === target;
    return rule.targetKind === "path"
      ? matchesPathGlob(rule.pattern, target)
      : matchesCharacterGlob(rule.pattern, target);
  });
}

export function mergePermissionRuleDecisions(
  rules: readonly PermissionRule[],
): { readonly decision: PermissionDecision; readonly matches: readonly MatchedPermissionRule[] } | undefined {
  if (rules.length === 0) return undefined;
  let decision: PermissionDecision = "allow";
  for (const rule of rules) {
    if (rule.decision === "deny") decision = "deny";
    else if (rule.decision === "ask" && decision !== "deny") decision = "ask";
  }
  return {
    decision,
    matches: rules.map(({ source, expression, decision: matched, matchKind }) => ({
      source,
      expression,
      decision: matched,
      matchKind,
    })),
  };
}

export function formatExactPermissionExpression(
  toolName: string,
  target: string,
): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(toolName) || target.length === 0) {
    throw new PermissionRuleError("无法生成精确权限规则。");
  }
  const escaped = target.replaceAll("\\", "\\\\").replaceAll("*", "\\*").replaceAll("?", "\\?");
  return `${toolName}(${escaped})`;
}

type PatternAnalysis = {
  readonly hasGlob: boolean;
};

function validatePattern(
  pattern: string,
  targetKind: PermissionTargetKind,
  analysis: PatternAnalysis,
): void {
  if (targetKind === "command") {
    if (pattern.length > 8 * 1024) {
      throw new PermissionRuleError("命令权限模式过长。");
    }
    return;
  }
  const decoded = decodePattern(pattern);
  if (pattern.length > 1_024 || decoded.startsWith("/")) {
    throw new PermissionRuleError("路径权限模式必须是有效的 Workspace 相对模式。");
  }
  if (decoded === ".") return;
  const segments = pattern.split("/");
  if (
    segments.some(
      (segment) => {
        const decodedSegment = decodePattern(segment);
        return (
          segment.length === 0 ||
          decodedSegment === "." ||
          decodedSegment === ".." ||
          (hasUnescapedDoubleStar(segment) && segment !== "**")
        );
      },
    )
  ) {
    throw new PermissionRuleError("路径权限模式包含无效路径段。");
  }
  void analysis;
}

function matchesPathGlob(pattern: string, target: string): boolean {
  if (pattern === ".") return target === ".";
  const patternSegments = pattern.split("/");
  const targetSegments = target.split("/").filter(Boolean);
  const cache = new Map<string, boolean>();
  const visit = (patternIndex: number, targetIndex: number): boolean => {
    const key = `${patternIndex}:${targetIndex}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    let matched: boolean;
    if (patternIndex === patternSegments.length) {
      matched = targetIndex === targetSegments.length;
    } else if (patternSegments[patternIndex] === "**") {
      matched =
        visit(patternIndex + 1, targetIndex) ||
        (targetIndex < targetSegments.length && visit(patternIndex, targetIndex + 1));
    } else {
      matched =
        targetIndex < targetSegments.length &&
        matchesCharacterGlob(patternSegments[patternIndex], targetSegments[targetIndex]) &&
        visit(patternIndex + 1, targetIndex + 1);
    }
    cache.set(key, matched);
    return matched;
  };
  return visit(0, 0);
}

function matchesCharacterGlob(pattern: string, target: string): boolean {
  const targetCharacters = Array.from(target);
  const previous = Array<boolean>(targetCharacters.length + 1).fill(false);
  previous[0] = true;
  for (const token of tokenizePattern(pattern)) {
    const current = Array<boolean>(targetCharacters.length + 1).fill(false);
    if (token.kind === "many") current[0] = previous[0];
    for (let targetIndex = 1; targetIndex <= targetCharacters.length; targetIndex += 1) {
      current[targetIndex] =
        token.kind === "many"
          ? previous[targetIndex] || current[targetIndex - 1]
          : (token.kind === "one" || token.value === targetCharacters[targetIndex - 1]) &&
            previous[targetIndex - 1];
    }
    for (let index = 0; index < current.length; index += 1) previous[index] = current[index];
  }
  return previous[targetCharacters.length];
}

type PatternToken =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "one" }
  | { readonly kind: "many" };

function analyzePattern(pattern: string): PatternAnalysis {
  let hasGlob = false;
  tokenizePattern(pattern, () => {
    hasGlob = true;
  });
  return { hasGlob };
}

function decodePattern(pattern: string): string {
  return tokenizePattern(pattern)
    .map((token) => {
      if (token.kind === "literal") return token.value;
      return token.kind === "many" ? "*" : "?";
    })
    .join("");
}

function tokenizePattern(
  pattern: string,
  onGlob: () => void = () => undefined,
): readonly PatternToken[] {
  const tokens: PatternToken[] = [];
  const characters = Array.from(pattern);
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (character === "\\") {
      const escaped = characters[index + 1];
      if (escaped !== "\\" && escaped !== "*" && escaped !== "?") {
        throw new PermissionRuleError("权限规则包含无效转义。仅支持 \\\\, \\* 和 \\?。");
      }
      tokens.push({ kind: "literal", value: escaped });
      index += 1;
      continue;
    }
    if (character === "*") {
      tokens.push({ kind: "many" });
      onGlob();
    } else if (character === "?") {
      tokens.push({ kind: "one" });
      onGlob();
    } else {
      tokens.push({ kind: "literal", value: character });
    }
  }
  return tokens;
}

function hasUnescapedDoubleStar(segment: string): boolean {
  const tokens = tokenizePattern(segment);
  return tokens.some(
    (token, index) =>
      token.kind === "many" && tokens[index + 1]?.kind === "many",
  );
}
