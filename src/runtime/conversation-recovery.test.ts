import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverToolCalls, pendingToolCalls } from "./conversation-recovery";
import type { ManagedContextMessage } from "@/core/context/types";
test("唯一未完成调用补未知结果，歧义拒绝", () => {
    const messages: ManagedContextMessage[] = [{ kind: "assistant-tool-call", content: null, toolCalls: [{ id: "c", name: "run_command", argumentsJson: "{}" }] }];
    const fixed = recoverToolCalls(messages);
    assert.equal(pendingToolCalls(fixed).length, 0);
    assert.match(JSON.stringify(fixed), /执行结果未知/);
    assert.match(JSON.stringify(fixed), /possible/);
    assert.throws(() => recoverToolCalls([...messages, ...messages]));
    assert.throws(() => recoverToolCalls([{ kind: "tool-result", toolCallId: "other", payload: { storage: "inline", content: "ok" } }]));
});

test("磁盘未完成调用可显式恢复，修复后 transcript 严格配对",async()=>{
 const {mkdtemp,writeFile,rm}=await import("node:fs/promises"),{default:path}=await import("node:path"),{default:os}=await import("node:os"),{LocalConversationStore}=await import("@/lib/local-conversation-store"),{parseConversationCheckpoint}=await import("@/core/conversations/validation");
 const root=await mkdtemp(path.join(os.tmpdir(),"recovery-disk-"));try{
 const store=new LocalConversationStore(root),cp=await store.create({workspaceId:"w",providerId:"p"});
 const messages:ManagedContextMessage[]=[{kind:"assistant-tool-call",content:null,toolCalls:[{id:"pending",name:"write_file",argumentsJson:'{"path":"effect.txt","content":"unknown"}'}]}];
 await writeFile(path.join(root,cp.summary.id,"revisions","000000000000.json"),JSON.stringify({...cp,context:{messages,consecutiveSummaryFailures:0}}));
 assert.deepEqual(pendingToolCalls((await store.load(cp.summary.id)).context.messages),["pending"]);
 const recovered=await store.recoverInterruptedTurn(cp.summary.id);assert.equal(recovered.summary.revision,1);assert.ok(parseConversationCheckpoint(recovered));assert.match(JSON.stringify(recovered.context),/执行结果未知/);assert.equal((await store.listRevisions(cp.summary.id)).length,2);
 }finally{await rm(root,{recursive:true,force:true});}
});
