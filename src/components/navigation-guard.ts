"use client";
import { useEffect } from "react";
export function needsNavigationConfirmation(dirty: boolean, running = false): boolean { return dirty || running; }
export function useBeforeUnload(dirty: boolean): void {
    useEffect(() => {
        if (!dirty)
            return;
        const listener = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
        window.addEventListener("beforeunload", listener);
        return () => window.removeEventListener("beforeunload", listener);
    }, [dirty]);
}
