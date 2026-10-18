import test from "node:test";
import assert from "node:assert/strict";
import { runSettingsOperation } from "./settings-operation";
for (const terminal of [true, false])
    test(`管理操作${terminal ? "返回终态" : "断流不伪装成功"}且清理订阅`, async () => {
        const original = globalThis.fetch;
        const requests: string[] = [];
        globalThis.fetch = async (_url, init) => {
            requests.push(init?.method ?? "GET");
            if (init?.method === "POST")
                return Response.json({ operationId: "test-id" });
            if (init?.method === "DELETE")
                return new Response(null, { status: 204 });
            return new Response(terminal ? 'data: {"type":"finished","httpStatus":200,"result":{"detail":"完成"}}\n\n' : '', { headers: { "content-type": "text/event-stream" } });
        };
        try {
            const operation = runSettingsOperation({}, "fake-management-token", new AbortController().signal);
            if (terminal)
                assert.deepEqual(await operation, { ok: true, result: { detail: "完成" } });
            else
                await assert.rejects(operation, /未返回终态/);
            assert.deepEqual(requests, ["POST", "GET", "DELETE"]);
        }
        finally {
            globalThis.fetch = original;
        }
    });
