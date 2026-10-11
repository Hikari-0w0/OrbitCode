import { isJsonObject, isJson, isObject } from "@/mcp/messages";
import { canonicalJson } from "@/lib/mcp-redaction";
import type { JsonObject, JsonValue, SchemaIssue, ToolInputSchema } from "@/tools/types";

const KEYS = new Set(["$schema", "$defs", "$ref", "$comment", "type", "enum", "const", "properties", "required", "additionalProperties", "minProperties", "maxProperties", "items", "minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "allOf", "anyOf", "oneOf", "not", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly"]);
const TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
type Schema = boolean | JsonObject;
export class McpSchemaError extends Error {
  constructor() { super("MCP 输入 Schema 无效、过于复杂或包含不支持的约束。"); }
}
export function compileMcpSchema(raw: unknown): ToolInputSchema<JsonObject> {
  if (!isJsonObject(raw) || raw.type !== "object" || Buffer.byteLength(JSON.stringify(raw)) > 64 * 1024) throw new McpSchemaError();
  const root = structuredClone(raw);
  let nodes = 0;
  const visit = (schema: unknown, depth: number, refs: ReadonlySet<string>): void => {
    if (++nodes > 4096 || depth > 32) throw new McpSchemaError();
    if (typeof schema === "boolean") return;
    if (!isJsonObject(schema) || Object.keys(schema).some((k) => !KEYS.has(k))) throw new McpSchemaError();
    if (schema.$schema !== undefined && schema.$schema !== "https://json-schema.org/draft/2020-12/schema") throw new McpSchemaError();
    if (schema.type !== undefined) {
      const values = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!values.length || values.some((v) => typeof v !== "string" || !TYPES.has(v)) || new Set(values).size !== values.length) throw new McpSchemaError();
    }
    for (const key of ["title", "description", "$comment"]) if (schema[key] !== undefined && typeof schema[key] !== "string") throw new McpSchemaError();
    for (const key of ["deprecated", "readOnly", "writeOnly", "uniqueItems"]) if (schema[key] !== undefined && typeof schema[key] !== "boolean") throw new McpSchemaError();
    for (const key of ["minProperties", "maxProperties", "minItems", "maxItems", "minLength", "maxLength"]) {
      const value = schema[key];
      if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) throw new McpSchemaError();
    }
    for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) if (schema[key] !== undefined && typeof schema[key] !== "number") throw new McpSchemaError();
    for (const key of ["enum", "examples"]) if (schema[key] !== undefined && !Array.isArray(schema[key])) throw new McpSchemaError();
    if (Array.isArray(schema.enum) && (!schema.enum.length || new Set(schema.enum.map(canonicalJson)).size !== schema.enum.length)) throw new McpSchemaError();
    if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((v) => typeof v === "string") || new Set(schema.required).size !== schema.required.length)) throw new McpSchemaError();
    for (const key of ["properties", "$defs"]) {
      if (schema[key] === undefined) continue;
      if (!isObject(schema[key])) throw new McpSchemaError();
      for (const child of Object.values(schema[key])) visit(child, depth + 1, refs);
    }
    for (const key of ["additionalProperties", "items", "not"]) if (schema[key] !== undefined) visit(schema[key], depth + 1, refs);
    for (const key of ["allOf", "anyOf", "oneOf"]) {
      const children = schema[key];
      if (children === undefined) continue;
      if (!Array.isArray(children) || !children.length) throw new McpSchemaError();
      for (const child of children) visit(child, depth + 1, refs);
    }
    if (schema.$ref !== undefined) {
      if (typeof schema.$ref !== "string" || refs.has(schema.$ref)) throw new McpSchemaError();
      visit(resolveRef(root, schema.$ref), depth + 1, new Set([...refs, schema.$ref]));
    }
  };
  visit(root, 0, new Set());
  freezeJson(root);
  return {
    jsonSchema: root,
    parse(value) {
      if (!isJsonObject(value) || Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024) return { ok: false, issues: [{ path: "$", message: "必须为有界 JSON 对象。" }] };
      const budget = { remaining: 100_000 };
      try {
        const issues = validate(root, value, "$", 0, root, budget);
        if (issues.length) return { ok: false, issues };
        const copy = structuredClone(value);
        freezeJson(copy);
        return { ok: true, value: copy };
      } catch {
        return { ok: false, issues: [{ path: "$", message: "参数校验超过复杂度上限。" }] };
      }
    },
  };
}
function resolveRef(root: JsonObject, ref: string): Schema {
  if (!ref.startsWith("#/$defs/") || /~(?![01])/.test(ref)) throw new McpSchemaError();
  let current: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isObject(current) || !Object.hasOwn(current, key)) throw new McpSchemaError();
    current = current[key];
  }
  if (typeof current !== "boolean" && !isJsonObject(current)) throw new McpSchemaError();
  return current;
}
function asSchema(value: JsonValue): Schema {
  if (typeof value === "boolean" || isJsonObject(value)) return value;
  throw new McpSchemaError();
}
function validate(schema: Schema, value: JsonValue, path: string, depth: number, root: JsonObject, budget: { remaining: number }): SchemaIssue[] {
  if (--budget.remaining < 0 || depth > 32) throw new McpSchemaError();
  if (schema === true) return [];
  if (schema === false) return [{ path, message: "Schema 不允许此值。" }];
  const issues: SchemaIssue[] = [];
  const fail = (message: string) => { if (issues.length < 20) issues.push({ path, message }); };
  const nested = (child: Schema, v = value, p = path) => validate(child, v, p, depth + 1, root, budget);
  const add = (items: readonly SchemaIssue[]) => { issues.push(...items.slice(0, 20 - issues.length)); };
  if (typeof schema.$ref === "string") add(nested(resolveRef(root, schema.$ref)));
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, value))) fail("参数类型不符合 Schema。");
  }
  if (schema.const !== undefined && canonicalJson(value) !== canonicalJson(schema.const)) fail("参数不符合 const 约束。");
  if (Array.isArray(schema.enum) && !schema.enum.some((v) => canonicalJson(v) === canonicalJson(value))) fail("参数不在枚举范围内。");
  if (typeof value === "string") {
    const size = Array.from(value).length;
    if (typeof schema.minLength === "number" && size < schema.minLength) fail("字符串过短。");
    if (typeof schema.maxLength === "number" && size > schema.maxLength) fail("字符串过长。");
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) fail("数值低于下限。");
    if (typeof schema.maximum === "number" && value > schema.maximum) fail("数值超过上限。");
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) fail("数值未超过排他下限。");
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) fail("数值未低于排他上限。");
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) fail("数组项目不足。");
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) fail("数组项目过多。");
    if (schema.uniqueItems === true && new Set(value.map(canonicalJson)).size !== value.length) fail("数组含重复项目。");
    if (schema.items !== undefined) for (const [i, v] of value.entries()) add(nested(asSchema(schema.items), v, `${path}[${i}]`));
  } else if (isJsonObject(value)) {
    const keys = Object.keys(value);
    if (typeof schema.minProperties === "number" && keys.length < schema.minProperties) fail("对象属性不足。");
    if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties) fail("对象属性过多。");
    if (Array.isArray(schema.required)) for (const key of schema.required) if (typeof key === "string" && !Object.hasOwn(value, key)) fail("缺少必填属性。");
    const properties = isJsonObject(schema.properties) ? schema.properties : {};
    for (const key of keys) {
      if (Object.hasOwn(properties, key)) add(nested(asSchema(properties[key]), value[key], `${path}.${key}`));
      else if (schema.additionalProperties !== undefined) add(nested(asSchema(schema.additionalProperties), value[key], `${path}.${key}`));
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    const children = schema[key];
    if (!Array.isArray(children)) continue;
    const passed = children.reduce((count: number, child) => count + (nested(asSchema(child)).length === 0 ? 1 : 0), 0);
    if ((key === "allOf" && passed !== children.length) || (key === "anyOf" && passed === 0) || (key === "oneOf" && passed !== 1)) fail(`参数不符合 ${key} 约束。`);
  }
  if (schema.not !== undefined && nested(asSchema(schema.not)).length === 0) fail("参数匹配被排除的 Schema。");
  return issues;
}
function typeMatches(type: JsonValue, value: JsonValue): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isObject(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === type;
}
function freezeJson(value: JsonValue): void {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) if (isJson(child)) freezeJson(child);
  }
}
