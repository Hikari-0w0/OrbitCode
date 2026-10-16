import { defineTool, successfulToolResult, type RegisteredTool } from "@/tools/registry";
import { objectSchema, stringSchema } from "@/tools/schema";
import { skillFailure } from "@/tools/load-skill";
export interface SkillResourceReader {
    target(name: string, path: string): string;
    read(name: string, path: string, signal: AbortSignal): Promise<{
        content: string;
        path: string;
    }>;
}
export function createReadSkillResourceTool(reader: SkillResourceReader): RegisteredTool {
    const tool = defineTool({
        name: "read_skill_resource", description: "按需读取已激活 Skill 目录内的模板、示例、脚本或参考文件；不执行脚本，资源仍须位于授权 Workspace 内。",
        inputSchema: objectSchema({ name: stringSchema({ minLength: 1, maxLength: 64, description: "已激活 Skill 名称" }), path: stringSchema({ minLength: 1, maxLength: 1024, description: "Skill 目录内的相对资源路径" }) }),
        mutability: "read-only", permission: { targetKind: "path", resolve: input => ({ kind: "path", requestedPath: reader.target(input.name, input.path), resolution: "existing-file" }) },
        async execute(input, context) { try {
            return successfulToolResult(await reader.read(input.name, input.path, context.signal));
        }
        catch (error) {
            return skillFailure(error, context.signal);
        } },
    });
    return { ...tool, prepareUnknown(input) { try {
            return tool.prepareUnknown(input);
        }
        catch (error) {
            return { kind: "failure", result: skillFailure(error) };
        } } };
}
