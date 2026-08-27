import path from "node:path";

import {
  loadLocalEnvironment,
  type Environment,
} from "@/lib/environment";
import {
  loadProviderConfigs,
  resolveProviderConfig,
  type ProviderConfig,
  type ResolvedProviderConfig,
} from "@/models/config";
import type { ProviderSummary } from "@/web/chat-contract";

type WebProviderContext = {
  readonly providers: readonly ProviderConfig[];
  readonly environment: Environment;
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
  return { providers, environment };
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
