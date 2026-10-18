import assert from "node:assert/strict";
import test from "node:test";
import { createTextDeltaBuffer } from "./text-delta-buffer";

test("文本增量合并且在轮次切换、工具事件及停止前保留原始顺序", () => {
  const seen: string[] = [];
  const buffer = createTextDeltaBuffer(delta => seen.push(`${delta.iteration}:${delta.text}`));
  buffer.push({ iteration: 1, text: "甲" });
  buffer.push({ iteration: 1, text: "乙" });
  assert.equal(seen.length, 0);
  buffer.push({ iteration: 2, text: "丙" });
  assert.deepEqual(seen, ["1:甲乙"]);
  buffer.flush();
  seen.push("工具");
  buffer.push({ iteration: 2, text: "丁" });
  buffer.flush();
  buffer.flush();
  assert.deepEqual(seen, ["1:甲乙", "2:丙", "工具", "2:丁"]);
});

test("静默等待时自动刷新，积累大文本时立即刷新", async () => {
  const seen: string[] = [];
  let resolve!: () => void;
  const emitted = new Promise<void>(done => { resolve = done; });
  const buffer = createTextDeltaBuffer(delta => { seen.push(delta.text); resolve(); }, 1);
  buffer.push({ iteration: 1, text: "首段" });
  await emitted;
  buffer.push({ iteration: 1, text: "长".repeat(8192) });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].length, 8192);
  buffer.flush();
});
