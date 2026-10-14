export * from "@/runtime/config";
import { loadProviderContext, resolveRuntimeProvider, type ProviderContext } from "@/runtime/config";
import { webDataDirectory, webSettingsStore } from "@/web/storage-paths";

export type WebProviderContext = ProviderContext;
export const resolveWebProvider = resolveRuntimeProvider;
export function loadWebProviderContext(): Promise<ProviderContext> {
  return loadProviderContext(process.cwd(), process.env, undefined, false, webSettingsStore, !webDataDirectory);
}
