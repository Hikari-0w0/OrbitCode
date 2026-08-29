import assert from "node:assert/strict";
import test from "node:test";

import { POST as createSession } from "@/app/api/permission-sessions/route";
import {
  DELETE as closeSession,
  PATCH as updateSession,
} from "@/app/api/permission-sessions/[sessionId]/route";
import { POST as submitDecision } from "@/app/api/permission-sessions/[sessionId]/decisions/route";
import type { PermissionApprovalRequest } from "@/core/permissions/approval";
import {
  parsePermissionDecisionResponse,
  parsePermissionSessionResponse,
} from "@/web/chat-contract";
import { permissionSessionManager } from "@/web/permission-session-store";

const origin = "http://localhost:3000";

test("创建权限会话并只接受同源模式更新", async () => {
  const rejected = createSession(new Request(`${origin}/api/permission-sessions`, {
    method: "POST",
  }));
  assert.equal(rejected.status, 403);

  const createdResponse = createSession(mutationRequest("/api/permission-sessions", "POST"));
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

test("决定接口不接受参数，重复与跨会话提交不改变原等待项", async () => {
  const first = await createPermissionSession();
  const second = await createPermissionSession();
  const turn = permissionSessionManager.beginTurn(first.sessionId, {
    workspace: { id: "project", name: "Project" },
    providerId: "provider",
  });
  const handle = turn.broker.request(approvalRequest(), new AbortController().signal);
  try {
    const injected = await submitDecision(
      mutationRequest(
        `/api/permission-sessions/${first.sessionId}/decisions`,
        "POST",
        {
          requestId: handle.prompt.requestId,
          decision: "allow-once",
          parameters: { path: "outside" },
        },
      ),
      context(first.sessionId),
    );
    assert.equal(injected.status, 400);
    assert.equal(
      permissionSessionManager.getSession(first.sessionId).pendingRequestId,
      handle.prompt.requestId,
    );

    const crossSession = await submitDecision(
      mutationRequest(
        `/api/permission-sessions/${second.sessionId}/decisions`,
        "POST",
        { requestId: handle.prompt.requestId, decision: "deny" },
      ),
      context(second.sessionId),
    );
    assert.equal(crossSession.status, 409);
    assert.equal(
      permissionSessionManager.getSession(first.sessionId).pendingRequestId,
      handle.prompt.requestId,
    );

    const accepted = await submitDecision(
      mutationRequest(
        `/api/permission-sessions/${first.sessionId}/decisions`,
        "POST",
        { requestId: handle.prompt.requestId, decision: "allow-once" },
      ),
      context(first.sessionId),
    );
    assert.equal(accepted.status, 200);
    assert.deepEqual(parsePermissionDecisionResponse(await accepted.json()), {
      accepted: true,
    });
    assert.deepEqual(await handle.outcome, { kind: "allowed", scope: "once" });

    const duplicate = await submitDecision(
      mutationRequest(
        `/api/permission-sessions/${first.sessionId}/decisions`,
        "POST",
        { requestId: handle.prompt.requestId, decision: "allow-once" },
      ),
      context(first.sessionId),
    );
    assert.equal(duplicate.status, 409);
  } finally {
    permissionSessionManager.closeSession(first.sessionId);
    permissionSessionManager.closeSession(second.sessionId);
  }
});

test("关闭会话取消等待，迟到决定不能恢复工具调用", async () => {
  const session = await createPermissionSession();
  const turn = permissionSessionManager.beginTurn(session.sessionId, {
    workspace: { id: "project", name: "Project" },
    providerId: "provider",
  });
  const handle = turn.broker.request(approvalRequest(), new AbortController().signal);
  const response = await closeSession(
    mutationRequest(`/api/permission-sessions/${session.sessionId}`, "DELETE"),
    context(session.sessionId),
  );
  assert.equal(response.status, 204);
  assert.deepEqual(await handle.outcome, { kind: "cancelled" });

  const late = await submitDecision(
    mutationRequest(
      `/api/permission-sessions/${session.sessionId}/decisions`,
      "POST",
      { requestId: handle.prompt.requestId, decision: "allow-once" },
    ),
    context(session.sessionId),
  );
  assert.equal(late.status, 404);
});

async function createPermissionSession() {
  const response = createSession(
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

function approvalRequest(): PermissionApprovalRequest {
  return {
    toolCallId: "call-1",
    subject: {
      kind: "path",
      toolName: "write_file",
      toolKind: "write",
      requestedPath: "src/main.ts",
      canonicalRelativePath: "src/main.ts",
    },
    fingerprint: "verified-fingerprint",
    reason: {
      source: "mode",
      mode: "default",
      risk: "medium",
      message: "写入需要确认。",
    },
    summary: { operation: "写入", path: "src/main.ts" },
  };
}
