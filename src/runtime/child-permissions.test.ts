import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createChildPermissions} from './child-permissions';
import {createWorkspaceBoundary} from '@/tools/workspace';
import {parsePermissionRule} from '@/core/permissions/rules';
import type {PermissionRule} from '@/core/permissions/types';
import type {PreparedToolCall} from '@/tools/registry';

test('子权限直接执行，父接纳deny、当前撤权与Plan均不能被角色宽松模式覆盖',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'child-policy-')),workspace=await createWorkspaceBoundary(root);
 const deny=parsePermissionRule({expression:'write_file(x.txt)',decision:'deny',source:'project',toolTargets:new Map([['write_file','path']])});
 const call:PreparedToolCall={name:'write_file',mutability:'workspace-write',fingerprint:'x',permissionTarget:{kind:'path',requestedPath:'x.txt',resolution:'write-target'},execute:async()=>{throw new Error('仅测试许可');}};
 let rules:PermissionRule[]=[],agentMode:'do'|'plan'='do';
 const base={workspace,mode:'do' as const,parentMode:'strict' as const,roleMode:'default' as const,current:async()=>({mode:'strict' as const,rules,agentMode})};
 try{
  const policy=createChildPermissions({...base,rules:[]});const allowed=await policy.gateway.authorize(call,'direct',new AbortController().signal);assert.equal(allowed.kind,'allowed');
  rules=[deny];if(allowed.kind==='allowed')assert.equal((await allowed.revalidate(new AbortController().signal))?.ok,false);
  assert.equal((await policy.gateway.authorize(call,'current-deny',new AbortController().signal)).kind,'denied');
  rules=[];agentMode='plan';assert.equal((await policy.gateway.authorize(call,'plan',new AbortController().signal)).kind,'denied');
  agentMode='do';assert.equal((await createChildPermissions({...base,rules:[deny]}).gateway.authorize(call,'snapshot-deny',new AbortController().signal)).kind,'denied');
 }finally{await rm(root,{recursive:true,force:true});}
});
