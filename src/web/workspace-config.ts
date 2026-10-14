export * from "@/runtime/workspace-config";
import { loadWorkspaceCatalog as loadRuntimeWorkspaceCatalog } from "@/runtime/workspace-config";
import { webSettingsStore } from "@/web/storage-paths";

export function loadWorkspaceCatalog(options: Parameters<typeof loadRuntimeWorkspaceCatalog>[0] = {}) {
  return loadRuntimeWorkspaceCatalog({ ...options, settingsStore: options.settingsStore ?? webSettingsStore });
}
