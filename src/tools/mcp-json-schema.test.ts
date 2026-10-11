import assert from "node:assert/strict";
import test from "node:test";
import { compileMcpSchema } from "./mcp-json-schema";
test("MCP Schema 对象、Unicode、数组、组合与引用严格校验", () => {
  const schema = compileMcpSchema({ type: "object", properties: {
    text: { type: "string", minLength: 1, maxLength: 1 },
    n: { $ref: "#/$defs/number", maximum: 3 },
    tags: { type: "array", items: { type: "string" }, uniqueItems: true },
  }, required: ["text", "n"], additionalProperties: false, $defs: { number: { type: "integer", minimum: 1 } } });
  assert.equal(schema.parse({ text: "😀", n: 2, tags: ["a"] }).ok, true);
  for (const input of [{ text: "ab", n: 2 }, { text: "a", n: 4 }, { text: "a", n: "2" }, { text: "a", n: 1, extra: true }, { text: "a", n: 1, tags: ["a", "a"] }]) assert.equal(schema.parse(input).ok, false);
  const union = compileMcpSchema({ type: "object", properties: { x: { oneOf: [{ type: "string" }, { type: "integer" }], not: { const: 0 } } } });
  assert.equal(union.parse({ x: 0 }).ok, false);
  assert.equal(union.parse({ x: "yes" }).ok, true);
});
test("MCP 不支持或循环 Schema 拒绝注册，不填默认值且冻结副本", () => {
  for (const schema of [{ type: "object", pattern: "x" }, { type: "object", $ref: "https://example.com/schema" }, { type: "object", $defs: { a: { $ref: "#/$defs/a" } }, $ref: "#/$defs/a" }, { type: "object", required: [1] }]) assert.throws(() => compileMcpSchema(schema));
  const schema = compileMcpSchema({ type: "object", properties: { a: { type: "object", default: {} } } });
  const input = { a: { value: 1 } };
  const parsed = schema.parse(input);
  assert.equal(parsed.ok, true);
  input.a.value = 2;
  if (parsed.ok) { assert.deepEqual(parsed.value, { a: { value: 1 } }); assert.ok(Object.isFrozen(parsed.value.a)); }
  assert.deepEqual(schema.parse({}), { ok: true, value: {} });
});

test("Schema 支持表的边界与未支持约束均不静默放行", () => {
  const schema = compileMcpSchema({ type: "object", minProperties: 1, maxProperties: 2, additionalProperties: { allOf: [{ type: ["number", "null"] }, { anyOf: [{ const: null }, { exclusiveMinimum: 0, exclusiveMaximum: 3 }] }] } });
  for (const value of [{ x: null }, { x: 1.5 }, { x: 1, y: 2 }]) assert.equal(schema.parse(value).ok, true);
  for (const value of [{}, { x: 0 }, { x: 3 }, { x: false }, { x: 1, y: 1, z: 1 }]) assert.equal(schema.parse(value).ok, false);
  const array = compileMcpSchema({ type: "object", properties: { x: { type: "array", minItems: 1, maxItems: 2, items: { enum: ["a", "b"] } } } });
  for (const x of [[], ["c"], ["a", "a", "a"]]) assert.equal(array.parse({ x }).ok, false);
  assert.equal(array.parse({ x: ["a", "b"] }).ok, true);
  for (const keyword of ["format", "patternProperties", "if", "unevaluatedProperties", "multipleOf", "unknown"]) assert.throws(() => compileMcpSchema({ type: "object", [keyword]: true }));
  assert.throws(() => compileMcpSchema({ type: "object", description: "x".repeat(70_000) }));
});

test("Schema 深度、节点、参数大小和运行时访问预算有界", () => {
  let nested: Record<string, unknown> = { type: "object" };
  for (let i = 0; i < 34; i++) nested = { type: "object", properties: { x: nested } };
  assert.throws(() => compileMcpSchema(nested));
  assert.throws(() => compileMcpSchema({ type: "object", allOf: Array(4097).fill(true) }));
  const schema = compileMcpSchema({ type: "object", properties: { x: { type: "array", items: { anyOf: Array.from({length:1000},()=>({type:"string"})) } } } });
  const parsed = schema.parse({ x: Array(200).fill("x") });
  assert.equal(parsed.ok, false); if (!parsed.ok) assert.match(parsed.issues[0].message, /复杂度/);
  assert.equal(compileMcpSchema({type:"object"}).parse({ x:"x".repeat(2*1024*1024) }).ok,false);
});
