import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMemoryManagementRequest } from "./background-http";
test("记忆管理契约不接受任意路径或无修订修改", () => { assert.deepEqual(parseMemoryManagementRequest({ action: "enabled", enabled: false }), { action: "enabled", enabled: false }); assert.throws(() => parseMemoryManagementRequest({ action: "delete", path: "/tmp/x" })); assert.throws(() => parseMemoryManagementRequest({ action: "enabled", enabled: true, path: "/x" })); });
