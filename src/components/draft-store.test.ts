import test from "node:test";
import assert from "node:assert/strict";
import { createDraftStore } from "./draft-store";
test("会话草稿隔离，存储失败后内存仍可恢复", () => {
    const store = createDraftStore(() => { throw new Error("storage denied"); });
    store.write("a", "草稿 A");
    store.write("b", "草稿 B");
    assert.equal(store.read("a"), "草稿 A");
    assert.equal(store.read("b"), "草稿 B");
    assert.equal(store.persistent, false);
    store.remove("a");
    assert.equal(store.read("a"), "");
});
