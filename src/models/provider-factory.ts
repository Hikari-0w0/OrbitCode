import type { ResolvedProviderConfig } from "@/models/config";
import { OpenAICompatibleProvider } from "@/models/openai-provider";
import type { ChatProvider } from "@/models/provider";

export function createChatProvider(
  config: ResolvedProviderConfig,
): ChatProvider {
  switch (config.protocol) {
    case "openai":
      return new OpenAICompatibleProvider(config);
  }
}
