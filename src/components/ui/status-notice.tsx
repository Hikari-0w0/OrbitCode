import type { ReactNode } from "react";
export function StatusNotice({ children, error = false }: {
    readonly children: ReactNode;
    readonly error?: boolean;
}) {
    return <div className={`statusNotice${error ? " statusNotice--error" : ""}`} role={error ? "alert" : "status"}>{children}</div>;
}
