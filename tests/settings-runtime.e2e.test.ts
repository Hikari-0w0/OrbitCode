import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { runOnce } from "@/cli/run-once";
import { LocalSettingsStore } from "@/lib/local-settings-store";
import { SettingsService } from "@/runtime/settings-service";
import { DONE_EVENT, startOpenAIMockServer, textDelta, toolCallDelta, TOOL_FINISH_EVENT, TRANSPORT_DONE_EVENT } from "./helpers/openai-mock";

test("运行中修改默认模型与工作区，旧轮保留快照，下一轮使用新版本", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-settings-turn-"));
  const dataDir = path.join(root, "data");
  const service = new SettingsService(new LocalSettingsStore(dataDir));
  let providerId = "", workspaceId = "", changed = false;
  const server = await startOpenAIMockServer(async (request) => {
    if (!changed) {
      changed = true;
      await service.apply(4, { type: "provider-default", id: providerId });
      await service.apply(5, { type: "workspace-default", id: workspaceId });
    }
    const hasTool = JSON.stringify(request.body).includes('"role":"tool"');
    return { chunks: [{ data: hasTool ? textDelta("读取完成") + DONE_EVENT
      : toolCallDelta({ id: `read-${changed}`, name: "read_file", argumentsJson: '{"path":"README.md"}' }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT }] };
  });
  try {
    const oldRoot = path.join(root, "old"), newRoot = path.join(root, "new");
    await mkdir(oldRoot); await mkdir(newRoot);
    await writeFile(path.join(oldRoot, "README.md"), "OLD_BOUNDARY");
    await writeFile(path.join(newRoot, "README.md"), "NEW_BOUNDARY");
    await service.apply(0, { type: "provider-add", displayName: "旧模型", model: "old-model", baseUrl: server.baseUrl, windowTokens: 128000, credential: { kind: "local", value: "synthetic-old" } });
    const models = await service.apply(1, { type: "provider-add", displayName: "新模型", model: "new-model", baseUrl: server.baseUrl, windowTokens: 128000, credential: { kind: "local", value: "synthetic-new" } });
    providerId = models.providers[1].id;
    await service.apply(2, { type: "workspace-add", name: "旧目录", rootPath: oldRoot });
    const workspaces = await service.apply(3, { type: "workspace-add", name: "新目录", rootPath: newRoot });
    workspaceId = workspaces.workspaces[1].id;
    const execute = async () => {
      let result = "";
      const output = new Writable({ write(chunk, _encoding, done) { result += chunk.toString(); done(); } });
      assert.equal(await runOnce({ arguments: { type: "run-once", stdin: true, outputFormat: "json", dataDir }, cwd: root,
        environment: {}, input: Readable.from(["读取 README.md"]), output, errorOutput: output }), 0);
      return JSON.parse(result);
    };
    assert.equal((await execute()).settingsRevision, 4);
    assert.equal((await execute()).settingsRevision, 6);
    assert.equal(server.requests.length, 4);
    assert.match(JSON.stringify(server.requests[0].body), /old-model/);
    assert.match(JSON.stringify(server.requests[1].body), /old-model/);
    assert.match(JSON.stringify(server.requests[1].body), /OLD_BOUNDARY/);
    assert.doesNotMatch(JSON.stringify(server.requests[1].body), /NEW_BOUNDARY/);
    assert.match(JSON.stringify(server.requests[2].body), /new-model/);
    assert.match(JSON.stringify(server.requests[3].body), /NEW_BOUNDARY/);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
