import assert from "node:assert/strict";
import test from "node:test";
import { TerminalText, terminalText } from "@/cli/terminal-text";
test("跨块控制序列不会执行，正文保留", () => {
  const text = new TerminalText();
  assert.equal(text.write("正文\x1b["), "正文");
  assert.equal(text.write("2J下一段\x1b]52;c;"), "下一段");
  assert.equal(text.write("clipboard\x1b"), "");
  assert.equal(text.write("\\完成\r\b\u202e"), "完成");
  assert.equal(terminalText("\x9b2J安全\n\t文字"), "安全\n\t文字");
});
