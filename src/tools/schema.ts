import type {
  JsonObject,
  JsonValue,
  SchemaIssue,
  SchemaParseResult,
  ToolInputSchema,
} from "@/tools/types";

type StringOptions = {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly description?: string;
};

type IntegerOptions = {
  readonly minimum?: number;
  readonly maximum?: number;
  readonly description?: string;
};

export interface ValueSchema<T, TOptional extends boolean = false>
  extends ToolInputSchema<T> {
  readonly optional: TOptional;
}

type AnyValueSchema = ValueSchema<unknown, boolean>;

type InferSchema<TSchema> = TSchema extends ValueSchema<infer TValue, boolean>
  ? TValue
  : never;

type RequiredKeys<TFields extends Record<string, AnyValueSchema>> = {
  [TKey in keyof TFields]: TFields[TKey]["optional"] extends true
    ? never
    : TKey;
}[keyof TFields];

type OptionalKeys<TFields extends Record<string, AnyValueSchema>> =
  Exclude<keyof TFields, RequiredKeys<TFields>>;

export type InferObject<TFields extends Record<string, AnyValueSchema>> = {
  readonly [TKey in RequiredKeys<TFields>]: InferSchema<TFields[TKey]>;
} & {
  readonly [TKey in OptionalKeys<TFields>]?: InferSchema<TFields[TKey]>;
};

export function stringSchema(options: StringOptions = {}): ValueSchema<string, false> {
  const jsonSchema: JsonObject = compactObject({
    type: "string",
    minLength: options.minLength,
    maxLength: options.maxLength,
    description: options.description,
  });
  return {
    optional: false,
    jsonSchema,
    parse(value) {
      if (typeof value !== "string") return issue("$", "必须是字符串。");
      if (options.minLength !== undefined && value.length < options.minLength) {
        return issue("$", `长度不能小于 ${options.minLength}。`);
      }
      if (options.maxLength !== undefined && value.length > options.maxLength) {
        return issue("$", `长度不能大于 ${options.maxLength}。`);
      }
      return { ok: true, value };
    },
  };
}

export function booleanSchema(
  description?: string,
): ValueSchema<boolean, false> {
  return {
    optional: false,
    jsonSchema: compactObject({ type: "boolean", description }),
    parse(value) {
      return typeof value === "boolean"
        ? { ok: true, value }
        : issue("$", "必须是布尔值。");
    },
  };
}

export function integerSchema(
  options: IntegerOptions = {},
): ValueSchema<number, false> {
  return {
    optional: false,
    jsonSchema: compactObject({
      type: "integer",
      minimum: options.minimum,
      maximum: options.maximum,
      description: options.description,
    }),
    parse(value) {
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        return issue("$", "必须是安全整数。");
      }
      if (options.minimum !== undefined && value < options.minimum) {
        return issue("$", `不能小于 ${options.minimum}。`);
      }
      if (options.maximum !== undefined && value > options.maximum) {
        return issue("$", `不能大于 ${options.maximum}。`);
      }
      return { ok: true, value };
    },
  };
}

export function optionalSchema<T>(
  schema: ValueSchema<T, false>,
): ValueSchema<T, true> {
  return { ...schema, optional: true };
}

export function objectSchema<
  const TFields extends Record<string, AnyValueSchema>,
>(fields: TFields): ToolInputSchema<InferObject<TFields>> {
  const properties: Record<string, JsonValue> = {};
  const required: string[] = [];
  for (const [name, schema] of Object.entries(fields)) {
    properties[name] = schema.jsonSchema;
    if (!schema.optional) required.push(name);
  }

  return {
    jsonSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    parse(value) {
      if (!isRecord(value)) return issue("$", "必须是对象。");
      const issues: SchemaIssue[] = [];
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        if (!(key in fields)) {
          issues.push({ path: `$.${key}`, message: "不允许未知字段。" });
        }
      }
      for (const [name, schema] of Object.entries(fields)) {
        if (!(name in value)) {
          if (!schema.optional) {
            issues.push({ path: `$.${name}`, message: "缺少必填字段。" });
          }
          continue;
        }
        const result = schema.parse(value[name]);
        if (result.ok) {
          output[name] = result.value;
        } else {
          for (const nested of result.issues) {
            issues.push({
              path: nested.path === "$" ? `$.${name}` : `$.${name}${nested.path.slice(1)}`,
              message: nested.message,
            });
          }
        }
      }
      return issues.length > 0
        ? { ok: false, issues }
        : { ok: true, value: output as InferObject<TFields> };
    },
  };
}

function issue<T>(path: string, message: string): SchemaParseResult<T> {
  return { ok: false, issues: [{ path, message }] };
}

function compactObject(
  value: Readonly<Record<string, JsonValue | undefined>>,
): JsonObject {
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = item;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
