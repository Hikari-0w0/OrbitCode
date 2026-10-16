import { SkillError } from "@/core/skills/types";
export type SkillCommand = {
    kind: "list";
} | {
    kind: "refresh";
} | {
    kind: "deactivate";
    name: string;
} | {
    kind: "run";
    name: string;
    arguments: string;
};
export function parseSkillCommand(text: string): SkillCommand | undefined {
    if (/^\/skills\s*$/u.test(text.trim()))
        return { kind: "list" };
    if (/^\/skills\s+refresh\s*$/u.test(text.trim()))
        return { kind: "refresh" };
    if (/^\/skills(?:\s|$)/u.test(text.trim()))
        throw new SkillError("invalid-arguments", "使用 /skills 或 /skills refresh。");
    if (!/^\/skill(?:\s|$)/u.test(text.trim()))
        return undefined;
    const line = text.trim(), stop = /^\/skill\s+deactivate\s+([a-z][a-z0-9-]{0,63})$/u.exec(line);
    if (stop)
        return { kind: "deactivate", name: stop[1] };
    const run = /^\/skill\s+(?:run\s+)?([a-z][a-z0-9-]{0,63})(?:\s+([\s\S]*))?$/u.exec(line);
    if (!run || (!/^\/skill\s+run\s/u.test(line) && ["run", "deactivate"].includes(run[1])))
        throw new SkillError("invalid-arguments", "使用 /skills、/skills refresh、/skill run <name> [参数] 或 /skill deactivate <name>。");
    return { kind: "run", name: run[1], arguments: run[2] ?? "" };
}
