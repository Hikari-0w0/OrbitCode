export type ThemePreference = "light" | "dark" | "system";
export function parseThemePreference(value: unknown): ThemePreference {
    return value === "light" || value === "dark" ? value : "system";
}
