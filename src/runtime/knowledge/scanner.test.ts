import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createWorkspaceBoundary } from "@/tools/workspace";
import { PermissionGateway } from "@/tools/permission-gateway";
import { KnowledgeAccess } from "./access";
import { DEFAULT_KNOWLEDGE_LIMITS, parseKnowledgeConfig } from "./config";
import { scanFiles } from "./scanner";

function config() {
  return parseKnowledgeConfig({ enabled: true, endpoint: "http://127.0.0.1:1/v1", model: "fixture", dimensions: 2,
    credential: { kind: "none" }, remoteEnabled: false, include: ["src/**/*.ts", "src/**", "src/**/*.ts"],
    exclude: ["src/vendor/**"], includeHistorical: false, documentPrefix: "", queryPrefix: "",
    limits: { ...DEFAULT_KNOWLEDGE_LIMITS, maxFiles: 1 } });
}

test("范围外临时产物、排除文件和重叠模式不消耗索引文件预算", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-knowledge-scope-"));
  try {
    await mkdir(path.join(root, "tmp"));
    await mkdir(path.join(root, "src/vendor"), { recursive: true });
    await writeFile(path.join(root, "src/main.ts"), "export const valid = true;\n");
    for (let index = 0; index < 40; index++) {
      await writeFile(path.join(root, "tmp", `${index}.md`), "irrelevant");
      await writeFile(path.join(root, "src/vendor", `${index}.ts`), "excluded");
    }
    const workspace = await createWorkspaceBoundary(root);
    const access = new KnowledgeAccess(workspace, new PermissionGateway({ workspace, agentMode: "plan", loadRules: async () => [] }));
    const result = await scanFiles(access, config(), new AbortController().signal);
    assert.deepEqual(result.files.map(file => file.path), ["src/main.ts"]);
    assert.equal(result.bytes, Buffer.byteLength("export const valid = true;\n"));
    await writeFile(path.join(root, "src/second.ts"), "export const second = true;");
    await assert.rejects(scanFiles(access, config(), new AbortController().signal), /扫描文件数达到上限/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("大量被排除的候选仍受独立遍历预算约束", async context => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-knowledge-traversal-"));
  try {
    const workspace = await createWorkspaceBoundary(root);
    context.mock.method(workspace, "walk", async function* () {
      for (let index = 0; index < 100001; index++) yield {
        relativePath: `src/vendor/${index}.ts`, absolutePath: path.join(root, "unused"), byteLength: 1,
      };
    });
    const access = new KnowledgeAccess(workspace, new PermissionGateway({ workspace, agentMode: "plan", loadRules: async () => [] }));
    await assert.rejects(scanFiles(access, config(), new AbortController().signal), /遍历候选数达到上限/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
