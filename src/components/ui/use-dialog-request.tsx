"use client";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "./dialog";
import { Button } from "./button";
type Request = {
    title: string;
    description: string;
    initial?: string;
    danger?: boolean;
};
export function useDialogRequest() {
    const [request, setRequest] = useState<Request>();
    const [value, setValue] = useState("");
    const resolver = useRef<((value: string | undefined) => void) | undefined>(undefined);
    useEffect(() => () => resolver.current?.(undefined), []);
    function finish(result?: string) { resolver.current?.(result); resolver.current = undefined; setRequest(undefined); }
    function ask(next: Request): Promise<string | undefined> {
        resolver.current?.(undefined);
        setValue(next.initial ?? "");
        setRequest(next);
        return new Promise(resolve => { resolver.current = resolve; });
    }
    const dialog = <Dialog open={Boolean(request)} title={request?.title ?? "确认操作"} onClose={() => finish()}><form onSubmit={event => { event.preventDefault(); finish(request?.initial !== undefined ? value : "confirmed"); }}><p>{request?.description}</p>{request?.initial !== undefined && <label className="field">会话标题<input value={value} required maxLength={120} onChange={event => setValue(event.target.value)}/></label>}<div className="dialogActions"><Button onClick={() => finish()}>取消</Button><Button type="submit" variant={request?.danger ? "danger" : "primary"}>确认</Button></div></form></Dialog>;
    return { ask, dialog };
}
