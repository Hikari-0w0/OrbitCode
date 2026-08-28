import { AgentConfigurationError } from "@/core/errors";
import type {
  OptionalPromptContext,
  PromptEnvironment,
  PromptSystemMessage,
} from "@/core/system-prompt/types";

export const PROMPT_TAGS = {
  environment: "orbitcode_environment",
  customInstructions: "orbitcode_custom_instructions",
  activatedSkills: "orbitcode_activated_skills",
  longTermMemory: "orbitcode_long_term_memory",
  sessionInstructions: "orbitcode_session_instructions",
} as const;

export const MAX_OPTIONAL_PROMPT_LENGTH = 20_000;
export const MAX_OPTIONAL_PROMPT_TOTAL_LENGTH = 40_000;

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PLATFORM_VALUES = new Set([
  "aix",
  "android",
  "cygwin",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "netbsd",
  "openbsd",
  "sunos",
  "win32",
]);
const TIME_ZONE_PATTERN = /^[A-Za-z0-9._+/-]{1,80}$/;

export function buildEnvironmentMessage(
  environment: PromptEnvironment,
): PromptSystemMessage {
  validateEnvironment(environment);
  return taggedMessage(
    PROMPT_TAGS.environment,
    [
      `workspace_id: ${environment.workspace.id}`,
      `workspace_name: ${environment.workspace.name}`,
      `platform: ${environment.platform}`,
      `current_date: ${environment.currentDate}`,
      `time_zone: ${environment.timeZone}`,
      "path_semantics: workspace-relative-posix",
    ].join("\n"),
  );
}

export function buildOptionalContextMessages(
  context: OptionalPromptContext | undefined,
): readonly PromptSystemMessage[] {
  if (context === undefined) return [];
  const entries = [
    [PROMPT_TAGS.customInstructions, context.customInstructions],
    [PROMPT_TAGS.activatedSkills, context.activatedSkills],
    [PROMPT_TAGS.longTermMemory, context.longTermMemory],
  ] as const;
  let totalLength = 0;
  const messages: PromptSystemMessage[] = [];
  for (const [tag, content] of entries) {
    if (content === undefined) continue;
    if (content.trim().length === 0 || content.length > MAX_OPTIONAL_PROMPT_LENGTH) {
      throw new AgentConfigurationError("可选系统提示内容无效或过长。");
    }
    totalLength += content.length;
    if (totalLength > MAX_OPTIONAL_PROMPT_TOTAL_LENGTH) {
      throw new AgentConfigurationError("可选系统提示总长度超过限制。");
    }
    messages.push(taggedMessage(tag, content));
  }
  return messages;
}

export function taggedMessage(tag: string, content: string): PromptSystemMessage {
  return {
    role: "system",
    content: `<${tag}>\n${escapeTaggedContent(content)}\n</${tag}>`,
  };
}

function validateEnvironment(environment: PromptEnvironment): void {
  if (
    !WORKSPACE_ID_PATTERN.test(environment.workspace.id) ||
    environment.workspace.name.trim().length === 0 ||
    environment.workspace.name !== environment.workspace.name.trim() ||
    environment.workspace.name.length > 80 ||
    !PLATFORM_VALUES.has(environment.platform) ||
    !isValidDate(environment.currentDate) ||
    !TIME_ZONE_PATTERN.test(environment.timeZone) ||
    environment.pathSemantics !== "workspace-relative-posix"
  ) {
    throw new AgentConfigurationError("系统提示环境信息无效。");
  }
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function escapeTaggedContent(content: string): string {
  return content
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
