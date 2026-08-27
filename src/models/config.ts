import { readFile } from "node:fs/promises";

import { parse } from "yaml";

import type { Environment } from "@/lib/environment";

const PROVIDER_FIELDS = new Set([
  "name",
  "protocol",
  "model",
  "base_url",
  "api_key",
]);
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ProviderConfig = {
  readonly name: string;
  readonly protocol: "openai";
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKeyEnvironmentVariable: string;
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

type LoadProviderConfigOptions = {
  readonly filePath: string;
  readonly providerName?: string;
  readonly environment: Environment;
  readonly readTextFile?: (filePath: string) => Promise<string>;
};

export async function loadProviderConfig({
  filePath,
  providerName,
  environment,
  readTextFile = (target) => readFile(target, "utf8"),
}: LoadProviderConfigOptions): Promise<ResolvedProviderConfig> {
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

  const providers = validateRoot(rawConfig);
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

  return {
    name,
    protocol,
    model,
    baseUrl,
    apiKeyEnvironmentVariable,
  };
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
