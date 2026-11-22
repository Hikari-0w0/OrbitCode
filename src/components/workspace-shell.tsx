import { useEffect, type ReactNode } from "react";
import { Dialog } from "./ui/dialog";

export function WorkspaceShell({ navigation, mobileNavigationOpen, onCloseNavigation, children }: {
    readonly navigation: ReactNode;
    readonly mobileNavigationOpen: boolean;
    readonly onCloseNavigation: () => void;
    readonly children: ReactNode;
}) {
    useEffect(() => {
        if (!mobileNavigationOpen) return;
        const narrowScreen = window.matchMedia("(max-width: 760px)");
        function closeOnDesktop(event: MediaQueryListEvent) {
            if (!event.matches) onCloseNavigation();
        }
        narrowScreen.addEventListener("change", closeOnDesktop);
        return () => narrowScreen.removeEventListener("change", closeOnDesktop);
    }, [mobileNavigationOpen, onCloseNavigation]);

    return (
        <main className="appFrame">
            <aside className="sidebar">{navigation}</aside>
            <div className="workspaceMain">{children}</div>
            <Dialog open={mobileNavigationOpen} title="会话与工作台" onClose={onCloseNavigation} className="navigationDrawer">
                {navigation}
            </Dialog>
        </main>
    );
}
