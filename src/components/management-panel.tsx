"use client";
import type { ReactNode } from "react";
import { Dialog } from "./ui/dialog";
export function ManagementPanel({ title, open, onClose, children }: {
    readonly title: string;
    readonly open: boolean;
    readonly onClose: () => void;
    readonly children: ReactNode;
}) {
    return <Dialog title={title} open={open} onClose={onClose} wide><div className="managementContent">{children}</div></Dialog>;
}
