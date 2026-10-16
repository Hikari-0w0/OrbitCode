import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCleanupRequest } from "./conversation-cleanup-http";
test("清理必须明确选择有修订的标识", () => { assert.deepEqual(parseCleanupRequest({ candidates: [{ id: "a", expectedRevision: 0 }] }), [{ id: "a", expectedRevision: 0 }]); assert.throws(() => parseCleanupRequest({ all: true })); assert.throws(() => parseCleanupRequest({ candidates: [{ id: "../a", expectedRevision: 0 }] })); });
