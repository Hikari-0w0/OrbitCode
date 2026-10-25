import { createHash } from "node:crypto";
import { KnowledgeError } from "@/core/retrieval/types";
import { readFileTool } from "@/tools/read-file";
import type { PermissionGateway } from "@/tools/permission-gateway";
import type { WorkspaceBoundary } from "@/tools/types";
export function contentHash(content:string):string {return createHash("sha256").update(content).digest("hex");}
export class KnowledgeAccess {
  constructor(readonly workspace:WorkspaceBoundary,private readonly gateway:PermissionGateway) {}
  async read(file:string,maxBytes:number,signal:AbortSignal) {
    signal.throwIfAborted();
    const prepared=readFileTool.prepareUnknown({path:file});
    if(prepared.kind!=="ready") throw new KnowledgeError("permission-denied","材料不可读取。");
    const authorization=await this.gateway.authorize(prepared.call,"knowledge-read",signal);
    if(authorization.kind!=="allowed" || await authorization.revalidate(signal)) throw new KnowledgeError("permission-denied","材料不可读取。");
    const snapshot=await this.workspace.readTextFile(file,{maxBytes});
    if(await authorization.revalidate(signal)) throw new KnowledgeError("permission-denied","材料读取权限已变化。");
    return {content:snapshot.content,hash:contentHash(snapshot.content)};
  }
}
