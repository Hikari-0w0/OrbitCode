import test from 'node:test';
import assert from 'node:assert/strict';
import {childWorkspaceAccess} from './workspace-policy';
import {createDefaultToolRegistry} from '@/tools/default-registry';
import type {AgentRole} from '@/core/sub-agents/types';
const registry=createDefaultToolRegistry({probe:async()=>({available:true}),run:async()=>{throw new Error('测试不执行命令');}});
const descriptors=registry.descriptors();
const role:AgentRole={name:'reader',description:'角色名称不是只读保证',allowedTools:['read_file','run_command'],disallowedTools:[],model:'inherit',maxIterations:4,permissionMode:'permissive',instructions:''};
test('工作区策略来自有效工具元数据，未知和命令均采用独占',()=>{
 assert.equal(childWorkspaceAccess(new Set(['read_file','find_files']),descriptors),'read-only');
 assert.equal(childWorkspaceAccess(new Set(['read_file','run_command']),descriptors,role),'exclusive');
 assert.equal(childWorkspaceAccess(new Set(['read_file','run_command']),descriptors,{...role,disallowedTools:['run_command']}),'read-only');
 assert.equal(childWorkspaceAccess(new Set(['mcp__unknown']),descriptors),'exclusive');
 assert.equal(childWorkspaceAccess(new Set(['read_file']),[]),'exclusive');
 assert.equal(childWorkspaceAccess(new Set(['read_file','run_command']),descriptors,{...role,allowedTools:['read_file']}),'read-only');
});
