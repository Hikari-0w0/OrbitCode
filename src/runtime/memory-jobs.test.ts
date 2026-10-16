import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryJobs } from "./memory-jobs";
test("单并发后台队列有界且可取消", async () => {
    const jobs = new MemoryJobs();
    let active = 0, max = 0, cancelled = 0;
    const run = async (signal: AbortSignal) => { active++; max = Math.max(active, max); await new Promise<void>(resolve => { if (signal.aborted)
        resolve();
    else
        signal.addEventListener("abort", () => resolve(), { once: true }); }); active--; };
    assert.ok(jobs.enqueue("c:0", run, () => cancelled++));
    await new Promise<void>(resolve => queueMicrotask(resolve));
    for (let i = 1; i <= 8; i++)
        assert.ok(jobs.enqueue(`c:${i}`, run, () => cancelled++));
    assert.ok(!jobs.enqueue("c:9", run, () => cancelled++));
    jobs.close();
    await jobs.idle();
    assert.equal(max, 1);
    assert.equal(cancelled, 8);
});

test("后台截止信号固定为 30 秒且会取消等待任务",async()=>{
 let milliseconds=0,expired=false;
 const jobs=new MemoryJobs(value=>{milliseconds=value;return AbortSignal.timeout(5);});
 jobs.enqueue("deadline",async signal=>{expired=await new Promise<boolean>(resolve=>{const fallback=setTimeout(()=>resolve(false),100);signal.addEventListener("abort",()=>{clearTimeout(fallback);resolve(true);},{once:true});});},()=>{});
 await jobs.idle();assert.equal(milliseconds,30000);assert.equal(expired,true);jobs.close();
});
