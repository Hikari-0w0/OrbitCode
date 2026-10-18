import type { ButtonHTMLAttributes } from "react";
export function Button({ className = "", variant = "default", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
    readonly variant?: "default" | "primary" | "danger";
}) {
    return <button type="button" {...props} className={`uiButton uiButton--${variant} ${className}`}/>;
}
