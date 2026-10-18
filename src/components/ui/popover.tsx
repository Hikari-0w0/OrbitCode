"use client";

import { useEffect, useRef, type ReactNode } from "react";

export function Popover({ className, label, accessibleLabel, children }: {
    readonly className: string;
    readonly label: ReactNode;
    readonly accessibleLabel?: string;
    readonly children: ReactNode;
}) {
    const details = useRef<HTMLDetailsElement>(null);

    useEffect(() => {
        function dismissOutside(event: Event): void {
            const element = details.current;
            if (element?.open && event.target instanceof Node && !element.contains(event.target))
                element.open = false;
        }
        function dismissWithEscape(event: KeyboardEvent): void {
            const element = details.current;
            if (event.key !== "Escape" || event.defaultPrevented || !element?.open)
                return;
            if (!(event.target instanceof Node) || !element.contains(event.target))
                return;
            element.open = false;
            element.querySelector("summary")?.focus();
            event.preventDefault();
            event.stopPropagation();
        }
        document.addEventListener("pointerdown", dismissOutside, true);
        document.addEventListener("focusin", dismissOutside);
        document.addEventListener("keydown", dismissWithEscape);
        return () => {
            document.removeEventListener("pointerdown", dismissOutside, true);
            document.removeEventListener("focusin", dismissOutside);
            document.removeEventListener("keydown", dismissWithEscape);
        };
    }, []);

    return (
        <details ref={details} name="workspace-popover" className={className}>
            <summary aria-label={accessibleLabel} title={accessibleLabel}>{label}</summary>
            {children}
        </details>
    );
}
