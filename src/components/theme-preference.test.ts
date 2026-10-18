import test from "node:test";
import assert from "node:assert/strict";
import { parseThemePreference } from "./theme-preference";
test("主题仅接受允许值", () => { assert.equal(parseThemePreference("dark"), "dark"); assert.equal(parseThemePreference('<script>'), "system"); });
