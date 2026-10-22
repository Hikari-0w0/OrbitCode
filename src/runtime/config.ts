import { parseSubAgentLimits } from "@/core/sub-agents/types";
import path from "node:path";
import { LocalSettingsStore } from "@/lib/local-settings-store";

import {
  assertMaxAgentRuntime,
  assertMaxAgentIterations,
  DEFAULT_MAX_AGENT_RUNTIME_MS,
  DEFAULT_MAX_AGENT_ITERATIONS,
} from "@/core/agent-loop";
import type { AgentIterationLimit } from "@/core/agent-events";
import {
  loadLocalEnvironment,
  type Environment,
} from "@/lib/environment";
import {
  ConfigurationError,
  loadProviderConfigs,
  resolveProviderConfig,
  type ProviderConfig,
  type ResolvedProviderConfig,
} from "@/models/config";
import type { ProviderSummary } from "@/runtime/types";
import type { ManagedSettings } from "@/runtime/settings-types";

export type ProviderContext = {
  readonly providers: readonly ProviderConfig[];
  readonly environment: Environment;
  readonly maxIterations: AgentIterationLimit;
  readonly maxRuntimeMs: number;
  readonly managedCredentials?: ReadonlyMap<string, string>;
  readonly managedNames?: ReadonlyMap<string, string>;
  readonly defaultProviderId?: string;
  readonly settingsRevision?: number;
  readonly managedSettings?: ManagedSettings;
};

export async function loadProviderContext(
  cwd = process.cwd(),
  processEnvironment: Environment = process.env,
  configPath = path.join(cwd, "orbitcode.yaml"),
  preferLegacy = false,
  settingsStore = new LocalSettingsStore(),
  readLocalEnvironment = true,
): Promise<ProviderContext> {
  const environment = readLocalEnvironment ? await loadLocalEnvironment({
    cwd,
    processEnvironment,
  }) : { ...processEnvironment };
  const settings = preferLegacy ? null : await settingsStore.load();
  if (settings) {
    const credentials = new Map<string, string>();
    const names = new Map<string, string>();
    const providers: ProviderConfig[] = settings.providers.filter((provider) => provider.enabled).map((provider) => {
      names.set(provider.id, provider.displayName);
      const key = provider.credential.kind === "local"
        ? provider.credential.value
        : provider.credential.kind === "environment" ? environment[provider.credential.variable] : undefined;
      if (key) credentials.set(provider.id, key);
      return {
        name: provider.id,
        protocol: "openai",
        model: provider.model,
        baseUrl: provider.baseUrl,
        apiKeyEnvironmentVariable: provider.credential.kind === "environment" ? provider.credential.variable : "ORBITCODE_MANAGED_CREDENTIAL",
        context: provider.context,
        ...(provider.maxOutputTokens === undefined ? {} : { maxOutputTokens: provider.maxOutputTokens }),
        ...(provider.thinking ? { thinking: provider.thinking } : {}),
        ...(provider.transport ? { transport: provider.transport } : {}),
      };
    });
    return {
      providers, environment, managedCredentials: credentials, managedNames: names,
      defaultProviderId: settings.defaultProviderId,
      settingsRevision: settings.revision,
      managedSettings: settings,
      maxIterations: settings.maxIterations ?? resolveMaxAgentIterations(environment),
      maxRuntimeMs: settings.maxRuntimeMinutes === undefined ? resolveMaxAgentRuntime(environment) : settings.maxRuntimeMinutes * 60_000,
    };
  }
  const providers = await loadProviderConfigs({
    filePath: configPath,
  });
  return {
    providers,
    environment,
    maxIterations: resolveMaxAgentIterations(environment),
    maxRuntimeMs: resolveMaxAgentRuntime(environment),
  };
}

export function resolveMaxAgentIterations(
  environment: Environment,
): AgentIterationLimit {
  const source = environment.ORBITCODE_MAX_AGENT_ITERATIONS;
  if (source === undefined) return DEFAULT_MAX_AGENT_ITERATIONS;
  if (source === "unlimited") return "unlimited";
  if (!/^[1-9]\d*$/.test(source)) {
    throw new ConfigurationError(
      "config-value",
      "ORBITCODE_MAX_AGENT_ITERATIONS 必须是有效的正整数或 unlimited。",
    );
  }
  const value = Number(source);
  try {
    assertMaxAgentIterations(value);
  } catch {
    throw new ConfigurationError(
      "config-value",
      "ORBITCODE_MAX_AGENT_ITERATIONS 必须在 1 到 32 之间。",
    );
  }
  return value;
}

export function resolveMaxAgentRuntime(environment: Environment): number {
  const source = environment.ORBITCODE_MAX_AGENT_RUNTIME_MINUTES;
  if (source === undefined) return DEFAULT_MAX_AGENT_RUNTIME_MS;
  if (!/^[1-9]\d*$/.test(source)) {
    throw new ConfigurationError(
      "config-value",
      "ORBITCODE_MAX_AGENT_RUNTIME_MINUTES 必须是有效的正整数。",
    );
  }
  const runtimeMs = Number(source) * 60 * 1_000;
  try {
    assertMaxAgentRuntime(runtimeMs);
  } catch {
    throw new ConfigurationError(
      "config-value",
      "ORBITCODE_MAX_AGENT_RUNTIME_MINUTES 必须在 1 到 1440 之间。",
    );
  }
  return runtimeMs;
}

export function summarizeProviders({
  providers,
  environment,
  managedCredentials,
  managedNames,
  defaultProviderId,
}: ProviderContext): readonly ProviderSummary[] {
  // 两端的默认候选顺序一致；不修改快照，也不覆盖仍有效的显式会话绑定。
  const ordered = [...providers].sort((left, right) => Number(right.name === defaultProviderId) - Number(left.name === defaultProviderId));
  return ordered.map((provider) => ({
    name: provider.name,
    ...(managedNames?.get(provider.name) ? { displayName: managedNames.get(provider.name) } : {}),
    model: provider.model,
    available: managedCredentials ? managedCredentials.has(provider.name) : Boolean(environment[provider.apiKeyEnvironmentVariable]),
  }));
}

export function resolveRuntimeProvider(
  context: ProviderContext,
  providerName: string,
): ResolvedProviderConfig {
  if (context.managedCredentials) {
    const selected = context.providers.find((provider) => provider.name === providerName);
    if (!selected) throw new ConfigurationError("config-value", `找不到模型配置：${providerName}`);
    const apiKey = context.managedCredentials.get(providerName);
    if (!apiKey) throw new ConfigurationError("credential", `模型配置“${providerName}”缺少凭据。`);
    return { ...selected, apiKey };
  }
  return resolveProviderConfig({
    providers: context.providers,
    providerName,
    environment: context.environment,
  });
}

export function resolveSubAgentLimits(context: ProviderContext) { return parseSubAgentLimits(context.managedSettings?.subAgents); }
