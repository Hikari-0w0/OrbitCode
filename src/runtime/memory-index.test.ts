import { test } from "node:test";
import assert from "node:assert/strict";
import { validateIndexSize } from "./memory-index";
test("索引双重上限按字节和逻辑行计数", () => { assert.ok(validateIndexSize("x\n".repeat(200))); assert.ok(!validateIndexSize("x\n".repeat(201))); assert.ok(validateIndexSize("中".repeat(8333) + "x")); assert.ok(!validateIndexSize("中".repeat(8333) + "xx")); });
