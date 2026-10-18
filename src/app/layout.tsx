import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { cookies } from "next/headers";
import { parseThemePreference } from "@/components/theme-preference";
export const metadata: Metadata = {
    title: "OrbitCode · Local AI Workspace",
    description: "本地优先的流式 AI 对话工作区",
};
export default async function RootLayout({ children }: Readonly<{
    children: ReactNode;
}>) {
    const theme = parseThemePreference((await cookies()).get("orbitcode-theme")?.value);
    return (<html lang="zh-CN" data-theme={theme}>
      <body>{children}</body>
    </html>);
}
