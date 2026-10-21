import assert from 'node:assert/strict';
import test from 'node:test';
import {evaluatePermission} from '@/core/permissions/evaluator';
import {parsePermissionRule} from '@/core/permissions/rules';
import type {PermissionSubject,PermissionRule} from '@/core/permissions/types';
import {PermissionGateway} from '@/tools/permission-gateway';
import {createWorkspaceBoundary} from '@/tools/workspace';
import type {PermissionOperation} from '@/tools/registry';
import {toolFailure} from '@/tools/types';
const subject:PermissionSubject={kind:'mcp',toolKind:'external',toolName:'mcp__demo',operation:'call',serverName:'demo',configurationId:'config'};
test('MCP旧模式及ask均直接执行，deny优先',()=>{
 const rule=(decision:'allow'|'ask'|'deny')=>parsePermissionRule({expression:'mcp_call(*)',decision,source:'local',toolTargets:new Map()});
 for(const mode of ['strict','default','permissive'] as const){assert.equal(evaluatePermission({subject,mode,rules:[]}).kind,'allow');assert.equal(evaluatePermission({subject,mode,rules:[rule('ask')]}).kind,'allow');assert.equal(evaluatePermission({subject,mode,rules:[rule('allow'),rule('ask'),rule('deny')]}).kind,'deny');}
});
test('MCP连接无需审批，Plan与连接配置变化仍拒绝',async()=>{
 const workspace=await createWorkspaceBoundary(process.cwd());let changed=false;
 const operation:PermissionOperation={name:'mcp_connect',mutability:'external',fingerprint:'config',permissionTarget:{kind:'mcp',operation:'connect',serverName:'demo',configurationId:'config',summary:{}},revalidate:async()=>changed?toolFailure('approval-invalid','配置变化'):undefined};
 const signal=new AbortController().signal;const gateway=(agentMode:'plan'|'do')=>new PermissionGateway({agentMode,workspace,loadRules:async()=>[]});
 assert.equal((await gateway('plan').authorizeConnection(operation,'start',signal)).kind,'denied');const allowed=await gateway('do').authorizeConnection(operation,'start',signal);assert.equal(allowed.kind,'allowed');changed=true;if(allowed.kind==='allowed')assert.equal((await allowed.revalidate(signal))?.ok,false);
});
test('MCP调用参数与定义仍绑定到许可，新增deny使调用不可执行',async()=>{
 const {createMcpTool}=await import('./mcp-tool');const workspace=await createWorkspaceBoundary(process.cwd());let rules:PermissionRule[]=[];
 const gateway=new PermissionGateway({agentMode:'do',workspace,loadRules:async()=>rules});
 const tool=createMcpTool({name:'echo',description:'echo',inputSchema:{type:'object'}},{serverName:'demo',configurationId:'c',redact:v=>v,revalidate:async()=>undefined,call:async()=>({content:[]})});const prepared=tool.prepareUnknown({n:1});if(prepared.kind!=='ready')assert.fail('准备失败');
 const signal=new AbortController().signal,allowed=await gateway.authorize(prepared.call,'call',signal);assert.equal(allowed.kind,'allowed');rules=[parsePermissionRule({expression:'mcp_call(*)',decision:'deny',source:'user',toolTargets:new Map()})];if(allowed.kind==='allowed')assert.equal((await allowed.revalidate(signal))?.ok,false);
});
