"use client";
import { useSyncExternalStore } from "react";
import { parseThemePreference, type ThemePreference } from "./theme-preference";
const subscribe = (listener: () => void) => { window.addEventListener("orbitcode-theme", listener); return () => window.removeEventListener("orbitcode-theme", listener); };
export function ThemeControl() {
    const theme = useSyncExternalStore(subscribe, () => parseThemePreference(document.documentElement.dataset.theme), () => "system" as ThemePreference);
    function change(value: string) {
        const next = parseThemePreference(value);
        document.documentElement.dataset.theme = next;
        document.cookie = `orbitcode-theme=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
        window.dispatchEvent(new Event("orbitcode-theme"));
    }
    return <label className="themeControl"><span>外观</span><select aria-label="外观主题" value={theme} onChange={event => change(event.target.value)}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>;
}
