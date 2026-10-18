import type { ReactNode } from "react";

export function WorkspaceShell({ navigation, children }: {
    readonly navigation: ReactNode;
    readonly children: ReactNode;
}) {
    return (
        <main className="appFrame">
            <aside className="sidebar">{navigation}</aside>
            <div className="workspaceMain">{children}</div>
        </main>
    );
}
