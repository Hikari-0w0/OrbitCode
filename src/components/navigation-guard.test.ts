import test from "node:test";
import assert from "node:assert/strict";
import { needsNavigationConfirmation } from "./navigation-guard";
test("编辑未保存或运行中需要离开保护", () => { assert.equal(needsNavigationConfirmation(false), false); assert.equal(needsNavigationConfirmation(true), true); assert.equal(needsNavigationConfirmation(false, true), true); });
