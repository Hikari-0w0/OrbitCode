import { SettingsPanel } from "@/components/settings/settings-panel";
import type { SettingsSection } from "@/components/ui-state";
export default async function SettingsPage({ searchParams }: {
    readonly searchParams: Promise<{
        section?: string;
    }>;
}) {
    const { section } = await searchParams;
    const initialSection: SettingsSection = section === "knowledge" || section === "workspaces" || section === "mcp" || section === "runtime" || section === "recovery" || section === "appearance" ? section : "models";
    return <SettingsPanel initialSection={initialSection}/>;
}
