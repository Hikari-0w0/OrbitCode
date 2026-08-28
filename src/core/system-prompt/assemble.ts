import {
  buildEnvironmentMessage,
  buildOptionalContextMessages,
} from "@/core/system-prompt/dynamic-context";
import { buildFixedSystemPrompt } from "@/core/system-prompt/fixed-prompt";
import { buildSessionInstructionMessage } from "@/core/system-prompt/session-instructions";
import type {
  OptionalPromptContext,
  PromptEnvironment,
  PromptSystemMessage,
  SessionInstructionContext,
} from "@/core/system-prompt/types";

export function buildSystemPromptMessages(input: {
  readonly environment: PromptEnvironment;
  readonly optional?: OptionalPromptContext;
  readonly session: SessionInstructionContext;
}): readonly PromptSystemMessage[] {
  return [
    { role: "system", content: buildFixedSystemPrompt() },
    buildEnvironmentMessage(input.environment),
    ...buildOptionalContextMessages(input.optional),
    buildSessionInstructionMessage(input.session),
  ];
}
