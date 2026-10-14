import path from "node:path";
import { LocalSettingsStore } from "@/lib/local-settings-store";

const configured = process.env.ORBITCODE_DATA_DIR;
export const webDataDirectory = configured ? path.resolve(configured) : undefined;
export const webSettingsStore = new LocalSettingsStore(webDataDirectory);
export const webConversationDirectory = webDataDirectory ? path.join(webDataDirectory, "conversations-v1") : undefined;
export const webContextDirectory = webDataDirectory ? path.join(webDataDirectory, "context-v1") : undefined;
export const webLogDirectory = webDataDirectory ? path.join(webDataDirectory, "logs") : undefined;
