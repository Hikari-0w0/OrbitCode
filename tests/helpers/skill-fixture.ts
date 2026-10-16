import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { runtimeFixture } from "./runtime-fixture";
import { textDelta, DONE_EVENT, toolCallDelta, TOOL_FINISH_EVENT, TRANSPORT_DONE_EVENT, type MockResponse } from "./openai-mock";
export type SkillFixture = Awaited<ReturnType<typeof runtimeFixture>>;
export async function writeSkill(fixture: SkillFixture, name: string, options: {
    mode?: "shared" | "isolated";
    tools?: readonly string[];
    body?: string;
    history?: string;
} = {}) {
    await fixture.runtime.memory.setEnabled(false);
    const root = path.join(fixture.root, '.orbitcode/skills', name);
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} 简介\nallowed-tools: [${(options.tools ?? ['read_file']).join(', ')}]\nmode: ${options.mode ?? 'shared'}\n${options.mode === 'isolated' ? `history: ${options.history ?? '{kind: none}'}\n` : ''}---\n${options.body ?? '独特操作正文 {{arguments}}'}`);
    return root;
}
export const say = (text: string): MockResponse => ({ chunks: [{ data: textDelta(text) + DONE_EVENT }] });
export const call = (name: string, args: unknown, id = 'call'): MockResponse => ({ chunks: [{ data: toolCallDelta({ name, id, argumentsJson: JSON.stringify(args) }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT }] });
