import { readFile } from "node:fs/promises";

import { parse } from "yaml";

import {
  DEFAULT_AUTOMATIC_RESERVE_TOKENS,
  DEFAULT_CONTEXT_PREVIEW_CHARS,
  DEFAULT_MANUAL_RESERVE_TOKENS,
  DEFAULT_RECENT_MESSAGES_TOKENS,
  DEFAULT_SINGLE_TOOL_RESULT_TOKENS,
  DEFAULT_TOOL_RESULT_GROUP_TOKENS,
  type ContextPolicyConfig,
} from "@/core/context/types";
import type { Environment } from "@/lib/environment";
import type { ModelThinkingConfig } from "@/models/provider";

const PROVIDER_FIELDS = new Set([
  "name",
  "protocol",
  "model",
  "base_url",
  "api_key",
  "thinking",
  "context",
]);
const THINKING_FIELDS = new Set(["enabled", "budget_tokens"]);
const CONTEXT_FIELDS = new Set([
  "window_tokens",
  "single_tool_result_tokens",
  "tool_result_group_tokens",
  "recent_messages_tokens",
  "automatic_reserve_tokens",
  "manual_reserve_tokens",
  "preview_chars",
]);
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_CONTEXT_WINDOW_TOKENS = 10_000_000;
const MAX_CONTEXT_THRESHOLD_TOKENS = 1_000_000;
const MAX_CONTEXT_PREVIEW_CHARS = 64 * 1024;
const MIN_THINKING_BUDGET_TOKENS = 128;
const MAX_THINKING_BUDGET_TOKENS = 32_768;

export type ProviderConfig = {
  readonly name: string;
  readonly protocol: "openai";
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKeyEnvironmentVariable: string;
  readonly thinking?: ModelThinkingConfig;
  readonly context: ContextPolicyConfig;
};

export type ResolvedProviderConfig = ProviderConfig & {
  readonly apiKey: string;
};

export class ConfigurationError extends Error {
  readonly kind: "config-file" | "config-value" | "credential";

  constructor(
    kind: "config-file" | "config-value" | "credential",
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ConfigurationError";
    this.kind = kind;
  }
}

type LoadProviderConfigsOptions = {
  readonly filePath: string;
  readonly readTextFile?: (filePath: string) => Promise<string>;
};

type ResolveProviderConfigOptions = {
  readonly providers: readonly ProviderConfig[];
  readonly providerName?: string;
  readonly environment: Environment;
};

type LoadProviderConfigOptions = LoadProviderConfigsOptions &
  Omit<ResolveProviderConfigOptions, "providers">;

export async function loadProviderConfigs({
  filePath,
  readTextFile = (target) => readFile(target, "utf8"),
}: LoadProviderConfigsOptions): Promise<readonly ProviderConfig[]> {
  let source: string;
  try {
    source = await readTextFile(filePath);
  } catch (error) {
    throw new ConfigurationError(
      "config-file",
      `无法读取模型配置文件：${filePath}`,
      error,
    );
  }

  let rawConfig: unknown;
  try {
    rawConfig = parse(source, {
      maxAliasCount: 0,
      prettyErrors: true,
      uniqueKeys: true,
    });
  } catch (error) {
    throw new ConfigurationError(
      "config-file",
      `无法解析模型配置文件：${filePath}`,
      error,
    );
  }

  return validateRoot(rawConfig);
}

export function resolveProviderConfig({
  providers,
  providerName,
  environment,
}: ResolveProviderConfigOptions): ResolvedProviderConfig {
  const selected = selectProvider(providers, providerName);
  const apiKey = environment[selected.apiKeyEnvironmentVariable];

  if (apiKey === undefined || apiKey.length === 0) {
    throw new ConfigurationError(
      "credential",
      `模型配置“${selected.name}”需要环境变量 ${selected.apiKeyEnvironmentVariable}。`,
    );
  }

  return { ...selected, apiKey };
}

export async function loadProviderConfig({
  filePath,
  providerName,
  environment,
  readTextFile,
}: LoadProviderConfigOptions): Promise<ResolvedProviderConfig> {
  const providers = await loadProviderConfigs({ filePath, readTextFile });
  return resolveProviderConfig({ providers, providerName, environment });
}

function validateRoot(value: unknown): readonly ProviderConfig[] {
  if (!isRecord(value)) {
    throw invalidConfig("配置根节点必须是对象。");
  }

  const rootFields = Object.keys(value);
  if (rootFields.length !== 1 || rootFields[0] !== "providers") {
    throw invalidConfig("配置根节点只能包含 providers 字段。");
  }

  if (!Array.isArray(value.providers) || value.providers.length === 0) {
    throw invalidConfig("providers 必须是非空数组。");
  }

  const providers = value.providers.map((provider, index) =>
    validateProvider(provider, index),
  );
  const names = new Set<string>();
  for (const provider of providers) {
    if (names.has(provider.name)) {
      throw invalidConfig(`模型配置名称重复：${provider.name}`);
    }
    names.add(provider.name);
  }
  return providers;
}

function validateProvider(value: unknown, index: number): ProviderConfig {
  const location = `providers[${index}]`;
  if (!isRecord(value)) {
    throw invalidConfig(`${location} 必须是对象。`);
  }

  for (const field of Object.keys(value)) {
    if (!PROVIDER_FIELDS.has(field)) {
      throw invalidConfig(`${location} 包含未知字段：${field}`);
    }
  }

  const name = requireNonEmptyString(value.name, `${location}.name`);
  const protocol = requireNonEmptyString(
    value.protocol,
    `${location}.protocol`,
  );
  if (protocol !== "openai") {
    throw invalidConfig(`${location}.protocol 目前只支持 openai。`);
  }

  const model = requireNonEmptyString(value.model, `${location}.model`);
  const baseUrl = requireHttpUrl(
    requireNonEmptyString(value.base_url, `${location}.base_url`),
    `${location}.base_url`,
  );
  const apiKeyEnvironmentVariable = requireNonEmptyString(
    value.api_key,
    `${location}.api_key`,
  );
  if (!ENVIRONMENT_VARIABLE_PATTERN.test(apiKeyEnvironmentVariable)) {
    throw invalidConfig(
      `${location}.api_key 必须是环境变量名称，不能是密钥或模板。`,
    );
  }
  const thinking = validateThinking(value.thinking, `${location}.thinking`);
  const context = validateContext(value.context, `${location}.context`);

  return {
    name,
    protocol,
    model,
    baseUrl,
    apiKeyEnvironmentVariable,
    ...(thinking === undefined ? {} : { thinking }),
    context,
  };
}

function validateThinking(
  value: unknown,
  location: string,
): ModelThinkingConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw invalidConfig(`${location} 必须是对象。`);
  }
  for (const field of Object.keys(value)) {
    if (!THINKING_FIELDS.has(field)) {
      throw invalidConfig(`${location} 包含未知字段：${field}`);
    }
  }
  if (typeof value.enabled !== "boolean") {
    throw invalidConfig(`${location}.enabled 必须是布尔值。`);
  }
  if (value.budget_tokens === undefined) {
    return { enabled: value.enabled };
  }
  const budgetTokens = requireSafeInteger(
    value.budget_tokens,
    `${location}.budget_tokens`,
    MAX_THINKING_BUDGET_TOKENS,
  );
  if (budgetTokens < MIN_THINKING_BUDGET_TOKENS) {
    throw invalidConfig(
      `${location}.budget_tokens 必须是 ${MIN_THINKING_BUDGET_TOKENS} 到 ${MAX_THINKING_BUDGET_TOKENS} 之间的整数。`,
    );
  }
  if (!value.enabled) {
    throw invalidConfig(`${location}.enabled 为 false 时不能设置 budget_tokens。`);
  }
  return { enabled: true, budgetTokens };
}

function validateContext(value: unknown, location: string): ContextPolicyConfig {
  if (!isRecord(value)) {
    throw invalidConfig(`${location} 必须是对象。`);
  }
  for (const field of Object.keys(value)) {
    if (!CONTEXT_FIELDS.has(field)) {
      throw invalidConfig(`${location} 包含未知字段：${field}`);
    }
  }
  const windowTokens = requireSafeInteger(
    value.window_tokens,
    `${location}.window_tokens`,
    MAX_CONTEXT_WINDOW_TOKENS,
  );
  const config: ContextPolicyConfig = {
    windowTokens,
    singleToolResultTokens: optionalSafeInteger(
      value.single_tool_result_tokens,
      `${location}.single_tool_result_tokens`,
      DEFAULT_SINGLE_TOOL_RESULT_TOKENS,
      MAX_CONTEXT_THRESHOLD_TOKENS,
    ),
    toolResultGroupTokens: optionalSafeInteger(
      value.tool_result_group_tokens,
      `${location}.tool_result_group_tokens`,
      DEFAULT_TOOL_RESULT_GROUP_TOKENS,
      MAX_CONTEXT_THRESHOLD_TOKENS,
    ),
    recentMessagesTokens: optionalSafeInteger(
      value.recent_messages_tokens,
      `${location}.recent_messages_tokens`,
      DEFAULT_RECENT_MESSAGES_TOKENS,
      MAX_CONTEXT_THRESHOLD_TOKENS,
    ),
    automaticReserveTokens: optionalSafeInteger(
      value.automatic_reserve_tokens,
      `${location}.automatic_reserve_tokens`,
      DEFAULT_AUTOMATIC_RESERVE_TOKENS,
      MAX_CONTEXT_THRESHOLD_TOKENS,
    ),
    manualReserveTokens: optionalSafeInteger(
      value.manual_reserve_tokens,
      `${location}.manual_reserve_tokens`,
      DEFAULT_MANUAL_RESERVE_TOKENS,
      MAX_CONTEXT_THRESHOLD_TOKENS,
    ),
    previewChars: optionalSafeInteger(
      value.preview_chars,
      `${location}.preview_chars`,
      DEFAULT_CONTEXT_PREVIEW_CHARS,
      MAX_CONTEXT_PREVIEW_CHARS,
    ),
  };
  if (config.toolResultGroupTokens < config.singleToolResultTokens) {
    throw invalidConfig(
      `${location}.tool_result_group_tokens 不能小于 single_tool_result_tokens。`,
    );
  }
  if (config.automaticReserveTokens <= config.manualReserveTokens) {
    throw invalidConfig(
      `${location}.automatic_reserve_tokens 必须大于 manual_reserve_tokens。`,
    );
  }
  if (
    config.windowTokens <=
    config.automaticReserveTokens + config.recentMessagesTokens
  ) {
    throw invalidConfig(
      `${location}.window_tokens 必须大于自动安全余量与近期消息预算之和。`,
    );
  }
  return config;
}

function selectProvider(
  providers: readonly ProviderConfig[],
  providerName: string | undefined,
): ProviderConfig {
  if (providerName === undefined) {
    if (providers.length === 1) {
      return providers[0];
    }
    throw invalidConfig("存在多个模型配置，请使用 --provider 指定名称。");
  }

  const provider = providers.find((candidate) => candidate.name === providerName);
  if (!provider) {
    throw invalidConfig(`找不到模型配置：${providerName}`);
  }
  return provider;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidConfig(`${field} 必须是非空字符串。`);
  }
  return value.trim();
}

function requireSafeInteger(
  value: unknown,
  field: string,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    throw invalidConfig(`${field} 必须是 1 到 ${maximum} 之间的整数。`);
  }
  return value;
}

function optionalSafeInteger(
  value: unknown,
  field: string,
  fallback: number,
  maximum: number,
): number {
  return value === undefined
    ? fallback
    : requireSafeInteger(value, field, maximum);
}

function requireHttpUrl(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidConfig(`${field} 必须是有效的 HTTP(S) 地址。`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalidConfig(`${field} 必须使用 HTTP(S) 协议。`);
  }
  return url.toString().replace(/\/$/, "");
}

function invalidConfig(message: string): ConfigurationError {
  return new ConfigurationError("config-value", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
