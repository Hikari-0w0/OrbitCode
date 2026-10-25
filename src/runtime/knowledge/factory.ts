import path from "node:path";
import { createDefaultToolRegistry } from "@/tools/default-registry";
import { MacOsSeatbeltCommandSandbox } from "@/tools/macos-seatbelt-sandbox";
import { LocalSettingsStore } from "@/lib/local-settings-store";
import { PermissionGateway } from "@/tools/permission-gateway";
import { loadPermissionRules, type PermissionConfigLocations } from "@/tools/permission-config";
import { createWorkspaceBoundary } from "@/tools/workspace";
import { KnowledgeAccess } from "./access";
import { KnowledgeService } from "./service";
import type { WorkspaceBoundary } from "@/tools/types";
export function createKnowledgeService(input:{store:LocalSettingsStore;workspace:WorkspaceBoundary;workspaceId?:string;gateway?:PermissionGateway;environment?:Readonly<Record<string,string|undefined>>;locations?:PermissionConfigLocations}) {
  const loadSettings=()=>input.store.load();
  const gateway=input.gateway??new PermissionGateway({agentMode:"plan",workspace:input.workspace,loadRules:async()=> (await loadPermissionRules({workspaceRoot:input.workspace.root,toolTargets:new Map(createDefaultToolRegistry(new MacOsSeatbeltCommandSandbox()).permissionTargets()).set("read_skill_resource","path").set("search_knowledge","path"),locations:input.locations??{user:path.join(input.store.directory,"permissions.yaml"),project:path.join(input.workspace.root,".orbitcode","permissions.yaml"),local:path.join(input.workspace.root,".orbitcode","permissions.local.yaml")}})).rules});
  return new KnowledgeService({dataRoot:input.store.directory,workspaceIdentity:input.workspaceId,access:new KnowledgeAccess(input.workspace,gateway),environment:input.environment,loadConfig:async()=>{const settings=await loadSettings();return settings?.workspaces.find(workspace=>workspace.enabled&&workspace.rootPath===input.workspace.root&&(!input.workspaceId||workspace.id===input.workspaceId))?.knowledge;}});
}
export async function knowledgeForWorkspace(store:LocalSettingsStore,id:string){
  const settings=await store.load(),entry=settings?.workspaces.find(item=>item.id===id&&item.enabled);if(!entry)throw new Error("工作区未授权。");
  const workspace=await createWorkspaceBoundary(entry.rootPath);
  return createKnowledgeService({store,workspace,workspaceId:id});
}
