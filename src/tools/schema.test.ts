import assert from "node:assert/strict";
import test from "node:test";

import {
  booleanSchema,
  integerSchema,
  objectSchema,
  optionalSchema,
  stringSchema,
} from "@/tools/schema";

test("对象 Schema 同时生成严格 JSON Schema 并解析类型", () => {
  const schema = objectSchema({
    path: stringSchema({ minLength: 1, maxLength: 20 }),
    enabled: optionalSchema(booleanSchema()),
    limit: integerSchema({ minimum: 1, maximum: 10 }),
  });

  assert.deepEqual(schema.jsonSchema, {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, maxLength: 20 },
      enabled: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: 10 },
    },
    required: ["path", "limit"],
    additionalProperties: false,
  });
  assert.deepEqual(schema.parse({ path: "src", limit: 3 }), {
    ok: true,
    value: { path: "src", limit: 3 },
  });
});

test("对象 Schema 拒绝未知、缺失、类型及范围错误", () => {
  const schema = objectSchema({
    command: stringSchema({ minLength: 1, maxLength: 4 }),
    timeout: integerSchema({ minimum: 100, maximum: 200 }),
  });
  const result = schema.parse({ command: "12345", timeout: 99, extra: true });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(
    result.issues.map((entry) => entry.path),
    ["$.extra", "$.command", "$.timeout"],
  );
  assert.equal(schema.parse({ command: "ok" }).ok, false);
  assert.equal(schema.parse(null).ok, false);
});
