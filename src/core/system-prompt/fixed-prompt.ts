import { ACTION_EXECUTION_PROMPT_MODULE } from "@/core/system-prompt/action-execution";
import { IDENTITY_PROMPT_MODULE } from "@/core/system-prompt/identity";
import { SYSTEM_CONSTRAINTS_PROMPT_MODULE } from "@/core/system-prompt/system-constraints";
import { TASK_MODE_PROMPT_MODULE } from "@/core/system-prompt/task-mode";
import { TEXT_OUTPUT_PROMPT_MODULE } from "@/core/system-prompt/text-output";
import { TONE_STYLE_PROMPT_MODULE } from "@/core/system-prompt/tone-style";
import { TOOL_USE_PROMPT_MODULE } from "@/core/system-prompt/tool-use";
import type {
  FixedPromptModule,
  FixedPromptModuleId,
} from "@/core/system-prompt/types";

const EXPECTED_MODULE_IDS: readonly FixedPromptModuleId[] = [
  "identity",
  "system-constraints",
  "task-mode",
  "action-execution",
  "tool-use",
  "tone-style",
  "text-output",
];

export const FIXED_PROMPT_MODULES: readonly FixedPromptModule[] = [
  IDENTITY_PROMPT_MODULE,
  SYSTEM_CONSTRAINTS_PROMPT_MODULE,
  TASK_MODE_PROMPT_MODULE,
  ACTION_EXECUTION_PROMPT_MODULE,
  TOOL_USE_PROMPT_MODULE,
  TONE_STYLE_PROMPT_MODULE,
  TEXT_OUTPUT_PROMPT_MODULE,
];

assertFixedModules(FIXED_PROMPT_MODULES);

const FIXED_SYSTEM_PROMPT = FIXED_PROMPT_MODULES
  .map((module) => module.content)
  .join("\n\n");

export function buildFixedSystemPrompt(): string {
  return FIXED_SYSTEM_PROMPT;
}

function assertFixedModules(modules: readonly FixedPromptModule[]): void {
  if (modules.length !== EXPECTED_MODULE_IDS.length) {
    throw new Error("固定系统提示模块数量无效。");
  }
  const ids = new Set<FixedPromptModuleId>();
  let previousPriority = Number.NEGATIVE_INFINITY;
  for (const [index, module] of modules.entries()) {
    if (module.id !== EXPECTED_MODULE_IDS[index]) {
      throw new Error("固定系统提示模块顺序无效。");
    }
    if (ids.has(module.id)) {
      throw new Error("固定系统提示模块标识重复。");
    }
    if (!Number.isInteger(module.priority) || module.priority <= previousPriority) {
      throw new Error("固定系统提示模块优先级无效。");
    }
    if (module.content.trim().length === 0 || module.content !== module.content.trim()) {
      throw new Error("固定系统提示模块内容无效。");
    }
    if (module.content.includes("<orbitcode_")) {
      throw new Error("固定系统提示模块不得包含动态标签。");
    }
    ids.add(module.id);
    previousPriority = module.priority;
  }
}
