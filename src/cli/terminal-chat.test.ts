import assert from "node:assert/strict";
import { PassThrough, Readable, Writable } from "node:stream";
import test from "node:test";
import { runTerminalChat } from "@/cli/terminal-chat";

const output = () => new Writable({ write(_chunk, _encoding, callback) { callback(); } });
test("管线按行顺序处理，EOF 等待已排队完整行", async () => {
  const seen: string[] = [];
  const session = { busy: false, exitRequested: false,
    async handleLine(line: string) { await new Promise((r) => setTimeout(r, 5)); seen.push(line); },
    cancel() {}, close() { this.exitRequested = true; } };
  await runTerminalChat({ session, input: Readable.from(["第一问\n第二问\n"]), output: output(), errorOutput: output(), terminal: false, registerInterrupt: () => () => {} });
  assert.deepEqual(seen, ["第一问", "第二问"]);
  assert.equal(session.exitRequested, true);
});
test("交互输入在生成未结束时处理审批，EOF 取消活动任务", async () => {
  const input = new PassThrough();
  let finish: () => void = () => {};
  let started: () => void = () => {};
  const began = new Promise<void>((resolve) => { started = resolve; });
  const seen: string[] = [];
  const session = { busy: false, exitRequested: false,
    async handleLine(line: string) {
      seen.push(line);
      if (line === "任务") {
        this.busy = true; started();
        await new Promise<void>((resolve) => { finish = resolve; });
        this.busy = false;
      } else if (line === "/approve id once") {
        assert.equal(this.busy, true); finish();
      }
    }, cancel() { finish(); }, close() { this.exitRequested = true; finish(); } };
  const running = runTerminalChat({ session, input, output: output(), errorOutput: output(), terminal: true, registerInterrupt: () => () => {} });
  input.write("任务\n"); await began;
  input.write("/approve id once\n"); input.end(); await running;
  assert.deepEqual(seen, ["任务", "/approve id once"]);
});
test("SIGINT 在运行中取消、空闲退出且移除监听", async () => {
  const input = new PassThrough();
  let interrupt = () => {};
  let removed = false;
  const session = { busy: true, exitRequested: false, async handleLine() {},
    cancel() { this.busy = false; }, close() { this.exitRequested = true; } };
  const running = runTerminalChat({ session, input, output: output(), errorOutput: output(), terminal: false,
    registerInterrupt(listener) { interrupt = listener; return () => { removed = true; }; } });
  interrupt(); assert.equal(session.busy, false); assert.equal(session.exitRequested, false);
  interrupt(); await running; assert.equal(removed, true);
});
