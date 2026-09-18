import { AgentConfigurationError } from "@/core/errors";
import type { PromptEnvironment } from "@/core/system-prompt/types";

export function createPromptEnvironment(options: {
  readonly workspace: { readonly id: string; readonly name: string };
  readonly now?: Date;
  readonly platform?: NodeJS.Platform;
  readonly timeZone?: string;
}): PromptEnvironment {
  const now = options.now ?? new Date();
  const platform = options.platform ?? process.platform;
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (Number.isNaN(now.valueOf())) {
    throw new AgentConfigurationError("无法构造系统提示日期。");
  }

  let currentDate: string;
  try {
    const parts = new Intl.DateTimeFormat("en", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const values = new Map(parts.map((part) => [part.type, part.value]));
    currentDate = `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
  } catch {
    throw new AgentConfigurationError("无法构造系统提示时区。");
  }

  return {
    workspace: { ...options.workspace },
    platform,
    currentDate,
    timeZone,
    pathSemantics: "workspace-relative-posix",
  };
}
