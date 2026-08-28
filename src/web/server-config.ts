import path from "node:path";

import {
  assertMaxAgentIterations,
  DEFAULT_MAX_AGENT_ITERATIONS,
} from "@/core/agent-loop";
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
import type { ProviderSummary } from "@/web/chat-contract";

export type WebProviderContext = {
  readonly providers: readonly ProviderConfig[];
  readonly environment: Environment;
  readonly maxIterations: number;
};

export async function loadWebProviderContext(
  cwd = process.cwd(),
  processEnvironment: Environment = process.env,
): Promise<WebProviderContext> {
  const environment = await loadLocalEnvironment({
    cwd,
    processEnvironment,
  });
  const providers = await loadProviderConfigs({
    filePath: path.join(cwd, "orbitcode.yaml"),
  });
  return {
    providers,
    environment,
    maxIterations: resolveMaxAgentIterations(environment),
  };
}

export function resolveMaxAgentIterations(environment: Environment): number {
  const source = environment.ORBITCODE_MAX_AGENT_ITERATIONS;
  if (source === undefined) return DEFAULT_MAX_AGENT_ITERATIONS;
  if (!/^[1-9]\d*$/.test(source)) {
    throw new ConfigurationError(
      "config-value",
      "ORBITCODE_MAX_AGENT_ITERATIONS 必须是有效的正整数。",
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

export function summarizeProviders({
  providers,
  environment,
}: WebProviderContext): readonly ProviderSummary[] {
  return providers.map((provider) => ({
    name: provider.name,
    model: provider.model,
    available: Boolean(environment[provider.apiKeyEnvironmentVariable]),
  }));
}

export function resolveWebProvider(
  context: WebProviderContext,
  providerName: string,
): ResolvedProviderConfig {
  return resolveProviderConfig({
    providers: context.providers,
    providerName,
    environment: context.environment,
  });
}
