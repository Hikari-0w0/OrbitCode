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

test("子任务类型显示明确选择并在生成期间禁用", () => {
  const props = { value: "委派", mode: "do" as const, disabled: false, isStreaming: false, isStopping: false, onModeChange: noop, onChange: noop, onSubmit: noop, onStop: noop, onDelegationKindChange: noop, delegationKind: "fork" as const };
  const markup = renderToStaticMarkup(<ChatComposer {...props}/>);
  assert.match(markup, /aria-label="子任务类型"/);
  assert.match(markup, /value="fork" selected=""/);
  assert.match(renderToStaticMarkup(<ChatComposer {...props} isStreaming/>), /aria-label="子任务类型" disabled=""/);
});
