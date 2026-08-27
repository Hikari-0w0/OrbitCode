import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfigurationError,
  loadProviderConfig,
} from "@/models/config";

const VALID_PROVIDER = [
  "providers:",
  "  - name: primary",
  "    protocol: openai",
  "    model: example-model",
  "    base_url: https://example.invalid/v1",
  "    api_key: ORBITCODE_API_KEY",
].join("\n");

async function load(
  source: string,
  options: {
    readonly providerName?: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  } = {},
) {
  return loadProviderConfig({
    filePath: "/virtual/orbitcode.yaml",
    providerName: options.providerName,
    environment: options.environment ?? { ORBITCODE_API_KEY: "test-secret" },
    readTextFile: async () => source,
  });
}

test("加载单个合法配置并从环境解析凭据", async () => {
  const result = await load(VALID_PROVIDER);

  assert.deepEqual(result, {
    name: "primary",
    protocol: "openai",
    model: "example-model",
    baseUrl: "https://example.invalid/v1",
    apiKeyEnvironmentVariable: "ORBITCODE_API_KEY",
    apiKey: "test-secret",
  });
});

test("多个配置必须按名称选择", async () => {
  const source = `${VALID_PROVIDER}\n  - name: secondary\n    protocol: openai\n    model: second-model\n    base_url: http://127.0.0.1:3001/v1/\n    api_key: SECONDARY_KEY`;

  await assert.rejects(load(source), /--provider/);
  const result = await load(source, {
    providerName: "secondary",
    environment: { SECONDARY_KEY: "secondary-secret" },
  });
  assert.equal(result.name, "secondary");
  assert.equal(result.model, "second-model");
  assert.equal(result.baseUrl, "http://127.0.0.1:3001/v1");
});

test("配置文件读取和 YAML 解析错误被结构化报告", async () => {
  await assert.rejects(
    loadProviderConfig({
      filePath: "/missing/config.yaml",
      environment: {},
      readTextFile: async () => {
        throw new Error("private detail");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.equal(error.kind, "config-file");
      assert.equal(error.message.includes("private detail"), false);
      return true;
    },
  );
  await assert.rejects(load("providers: ["), /无法解析模型配置文件/);
});

test("拒绝根结构、空列表和未知字段", async () => {
  await assert.rejects(load("- invalid"), /根节点必须是对象/);
  await assert.rejects(load("providers: []"), /非空数组/);
  await assert.rejects(load(`${VALID_PROVIDER}\nextra: true`), /根节点只能包含/);
  await assert.rejects(
    load(`${VALID_PROVIDER}\n    temperature: 0.2`),
    /未知字段/,
  );
});

test("拒绝缺失或空白的每个必填字段", async () => {
  const fields = ["name", "protocol", "model", "base_url", "api_key"];
  for (const field of fields) {
    const withoutField =
      field === "name"
        ? VALID_PROVIDER.replace(
            "  - name: primary\n    protocol: openai",
            "  - protocol: openai",
          )
        : VALID_PROVIDER
            .split("\n")
            .filter(
              (line) =>
                !new RegExp(`^\\s*(?:-\\s*)?${field}:`).test(line),
            )
            .join("\n");
    await assert.rejects(load(withoutField), new RegExp(field));

    const emptyField = VALID_PROVIDER.replace(
      new RegExp(`(${field}:).*$`, "m"),
      "$1 '   '",
    );
    await assert.rejects(load(emptyField), new RegExp(field));
  }
});

test("拒绝重复名、不支持协议、非法 URL 和环境变量模板", async () => {
  await assert.rejects(
    load(`${VALID_PROVIDER}\n  - name: primary\n    protocol: openai\n    model: other\n    base_url: https://other.invalid/v1\n    api_key: OTHER_KEY`),
    /名称重复/,
  );
  await assert.rejects(load(VALID_PROVIDER.replace("openai", "anthropic")), /只支持 openai/);
  await assert.rejects(
    load(VALID_PROVIDER.replace("https://example.invalid/v1", "file:///tmp/model")),
    /HTTP\(S\)/,
  );
  await assert.rejects(
    load(VALID_PROVIDER.replace("ORBITCODE_API_KEY", "${ORBITCODE_API_KEY}")),
    /环境变量名称/,
  );
});

test("拒绝 YAML alias 和不存在的配置名", async () => {
  const aliasSource = [
    "providers:",
    "  - &provider",
    "    name: primary",
    "    protocol: openai",
    "    model: model",
    "    base_url: https://example.invalid/v1",
    "    api_key: API_KEY",
    "  - *provider",
  ].join("\n");
  await assert.rejects(load(aliasSource), /无法解析模型配置文件|alias|Alias/);
  await assert.rejects(
    load(VALID_PROVIDER, { providerName: "missing" }),
    /找不到模型配置/,
  );
});

test("缺失凭据错误不包含哨兵值", async () => {
  const sentinel = "sentinel-real-secret";
  await assert.rejects(
    load(VALID_PROVIDER, { environment: { OTHER_KEY: sentinel } }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.equal(error.kind, "credential");
      assert.equal(error.message.includes(sentinel), false);
      return true;
    },
  );
});
