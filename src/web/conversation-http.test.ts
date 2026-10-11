import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceCatalogError } from "@/runtime/workspace-config";
import { conversationApiErrorResponse } from "./conversation-http";

test("会话接口区分失效工作区与存储故障", async () => {
  const missing = conversationApiErrorResponse(new WorkspaceCatalogError("unknown-workspace", "工作区不在当前配置中"));
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: "工作区不在当前配置中", code: "workspace-unknown" });
  const unavailable = conversationApiErrorResponse(new WorkspaceCatalogError("workspace-unavailable", "工作区不可用", new Error("secret")));
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "工作区不可用", code: "workspace-unavailable" });
  const unexpected = conversationApiErrorResponse(new Error("secret"));
  assert.equal(unexpected.status, 500);
  assert.equal(JSON.stringify(await unexpected.json()).includes("secret"), false);
});
