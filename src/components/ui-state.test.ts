import test from "node:test";
import assert from "node:assert/strict";
import { composerAvailability } from "./ui-state";
const ready = { request: "idle", catalog: "ready", permission: "ready", conversation: "ready", availability: "ready", unsaved: false } as const;
test("可用状态区分只读、权限和未保存，停止中优先", () => {
    assert.equal(composerAvailability(ready).kind, "ready");
    for (const changed of [{ availability: "read-only" }, { permission: "error" }, { unsaved: true }])
        assert.equal(composerAvailability({ ...ready, ...changed }).kind, "blocked");
    assert.deepEqual(composerAvailability({ ...ready, request: "stopping", unsaved: true }), { kind: "busy", phase: "stopping" });
});

test("首次配置错误优先于只读历史，保留配置恢复入口", () => {
    const result = composerAvailability({ ...ready, catalog: "config-error", availability: "read-only" });
    assert.equal(result.kind, "blocked");
    if (result.kind === "blocked") assert.equal(result.recovery, "settings");
});
