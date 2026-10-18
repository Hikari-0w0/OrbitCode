"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
export function Dialog({ open, title, onClose, children, wide = false }: {
    readonly open: boolean;
    readonly title: string;
    readonly onClose: () => void;
    readonly children: ReactNode;
    readonly wide?: boolean;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const titleId = useId();
    useEffect(() => {
        const element = dialog.current;
        if (!element || !open)
            return;
        const previous = document.activeElement;
        element.showModal();
        return () => { element.close(); if (previous instanceof HTMLElement && previous.isConnected)
            previous.focus(); };
    }, [open]);
    return <dialog ref={dialog} className={`appDialog${wide ? " appDialog--wide" : ""}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="dialogHeader"><h2 id={titleId}>{title}</h2><button type="button" className="iconButton" aria-label="关闭对话框" onClick={onClose}>×</button></header>
    {open && <div className="dialogBody">{children}</div>}
  </dialog>;
}
