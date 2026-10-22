import assert from "node:assert/strict";
import test from "node:test";

import { POST as createSession } from "@/app/api/permission-sessions/route";
import {
  DELETE as closeSession,
  PATCH as updateSession,
} from "@/app/api/permission-sessions/[sessionId]/route";
import { POST as submitDecision } from "@/app/api/permission-sessions/[sessionId]/decisions/route";
import {
  parsePermissionSessionResponse,
} from "@/web/chat-contract";
import { permissionSessionManager } from "@/web/permission-session-store";

const origin = "http://localhost:3000";

test("创建权限会话并只接受同源模式更新", async () => {
  const rejected = await createSession(new Request(`${origin}/api/permission-sessions`, {
    method: "POST",
  }));
  assert.equal(rejected.status, 403);

  const createdResponse = await createSession(mutationRequest("/api/permission-sessions", "POST"));
  assert.equal(createdResponse.status, 201);
  const created = parsePermissionSessionResponse(await createdResponse.json());
  assert.equal(created.mode, "default");
  try {
    const updatedResponse = await updateSession(
      mutationRequest(`/api/permission-sessions/${created.sessionId}`, "PATCH", {
        mode: "strict",
      }),
      context(created.sessionId),
    );
    assert.equal(updatedResponse.status, 200);
    assert.deepEqual(parsePermissionSessionResponse(await updatedResponse.json()), {
      sessionId: created.sessionId,
      mode: "strict",
    });

    const invalidResponse = await updateSession(
      mutationRequest(`/api/permission-sessions/${created.sessionId}`, "PATCH", {
        mode: "unrestricted",
      }),
      context(created.sessionId),
    );
    assert.equal(invalidResponse.status, 400);
    assert.equal(permissionSessionManager.getSession(created.sessionId).mode, "strict");
  } finally {
    permissionSessionManager.closeSession(created.sessionId);
  }
});

test("已移除的决定接口返回410，跨会话或重复提交都不能授予权限",async()=>{
 const first=await createPermissionSession(),second=await createPermissionSession();
 try{for(const session of [first,second,first]){const response=await submitDecision(mutationRequest(`/api/permission-sessions/${session.sessionId}/decisions`,'POST',{requestId:'retired',decision:'allow-permanent'}),context(session.sessionId));assert.equal(response.status,410);assert.equal(permissionSessionManager.getSession(session.sessionId).pendingRequestId,undefined);}const cross=await submitDecision(new Request('http://evil.invalid/decisions',{method:'POST'}),context(first.sessionId));assert.equal(cross.status,403);}finally{permissionSessionManager.closeSession(first.sessionId);permissionSessionManager.closeSession(second.sessionId);}
});
test("关闭权限会话后旧审批接口仍不能恢复操作",async()=>{
 const session=await createPermissionSession();const response=await closeSession(mutationRequest(`/api/permission-sessions/${session.sessionId}`,'DELETE'),context(session.sessionId));assert.equal(response.status,204);assert.equal((await submitDecision(mutationRequest('/decisions','POST',{requestId:'retired',decision:'allow-once'}),context(session.sessionId))).status,410);
});

async function createPermissionSession() {
  const response = await createSession(
    mutationRequest("/api/permission-sessions", "POST"),
  );
  return parsePermissionSessionResponse(await response.json());
}

function mutationRequest(
  pathname: string,
  method: string,
  body?: unknown,
): Request {
  return new Request(`${origin}${pathname}`, {
    method,
    headers: {
      origin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function context(sessionId: string) {
  return { params: Promise.resolve({ sessionId }) };
}
