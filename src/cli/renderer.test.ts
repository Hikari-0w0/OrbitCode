import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { TerminalRenderer } from "@/cli/renderer";
test("结果展示区分 Usage 缺失，过滤控制符且不扩大验证范围", () => {
  let text = "";
  const output = new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } });
  const renderer = new TerminalRenderer(output, output);
  renderer.event({ type: "agent", event: { type: "text-delta", iteration: 1, text: "hello\x1b[" } });
  renderer.event({ type: "agent", event: { type: "text-delta", iteration: 1, text: "2Jworld" } });
  renderer.event({ type: "agent", event: { type: "token-usage", iteration: 1,
    usage: { availability: "unavailable" }, cumulative: { availability: "unavailable" } } });
  renderer.event({ type: "finished", stopped: { type: "stopped", reason: "final-response",
    iterations: 1, durationMs: 5, sideEffect: "none", verification: { status: "unverified", checks: [], blockers: [] } },
    persistence: { status: "saved", revision: 1 } });
  assert.match(text, /helloworld/); assert.doesNotMatch(text, /\x1b/);
  assert.match(text, /模型未报告/); assert.match(text, /仅覆盖所列检查/);
  assert.match(text, /已保存 revision 1/);
});
