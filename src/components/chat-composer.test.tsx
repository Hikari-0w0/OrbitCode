import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatComposer } from "./chat-composer";
const noop = () => undefined;
test("输入阻塞使用实际原因，空白不可发送，停止中不可重复停止", () => {
    const props = { value: "  ", mode: "do" as const, disabled: false, isStreaming: false, isStopping: false, onModeChange: noop, onChange: noop, onSubmit: noop, onStop: noop };
    assert.match(renderToStaticMarkup(<ChatComposer {...props}/>), /disabled="" aria-label="发送消息"/);
    assert.match(renderToStaticMarkup(<ChatComposer {...props} disabled blockedReason="只读历史"/>), /placeholder="只读历史"/);
    assert.match(renderToStaticMarkup(<ChatComposer {...props} isStreaming isStopping/>), /disabled="" aria-label="停止生成"/);
});
