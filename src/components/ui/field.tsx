import type { ReactNode } from "react";
export function Field({ label, children, hint }: {
    readonly label: string;
    readonly children: ReactNode;
    readonly hint?: string;
}) {
    return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
