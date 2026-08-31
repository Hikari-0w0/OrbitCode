import type { SchemaIssue } from "@/tools/types";

export function preflightCommand(input: {
  readonly command: string;
  readonly cwd?: string;
}): readonly SchemaIssue[] {
  const command = input.command.trim();
  const issues: SchemaIssue[] = [];
  if (isJsonDocument(command)) {
    issues.push({
      path: "$.command",
      message: "command 不能是整段 JSON；请只传入实际 shell 命令。",
    });
  }
  if (hasWholeCommandQuotes(command)) {
    issues.push({
      path: "$.command",
      message: "command 不应再用一对引号包裹整串命令。",
    });
  }
  if (
    input.cwd !== undefined &&
    leadingChangedDirectory(command) === normalizeWorkspacePath(input.cwd)
  ) {
    issues.push({
      path: "$.command",
      message: "已设置 cwd，command 不应再次 cd 到同一目录。",
    });
  }
  return issues;
}

function isJsonDocument(command: string): boolean {
  if (
    !((command.startsWith("{") && command.endsWith("}")) ||
      (command.startsWith("[") && command.endsWith("]")))
  ) return false;
  try {
    const value = JSON.parse(command) as unknown;
    return typeof value === "object" && value !== null;
  } catch {
    return false;
  }
}

function hasWholeCommandQuotes(command: string): boolean {
  if (command.length < 2) return false;
  const quote = command[0];
  return (quote === "'" || quote === '"') && command.at(-1) === quote;
}

function leadingChangedDirectory(command: string): string | undefined {
  const match = /^cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:&&|;)\s*/u.exec(command);
  const directory = match?.[1] ?? match?.[2] ?? match?.[3];
  return directory === undefined ? undefined : normalizeWorkspacePath(directory);
}

function normalizeWorkspacePath(value: string): string {
  const segments: string[] = [];
  for (const segment of value.trim().replaceAll("\\", "/").split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/") || ".";
}
