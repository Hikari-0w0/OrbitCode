import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import type { ResolvedProviderConfig } from "@/models/config";
import type { TaskView } from "@/core/sub-agents/types";
import type { PermissionMode } from "@/core/permissions/types";
import { parseWebChatEvents, readWebStream } from "@/web/chat-contract";
import { realSubAgentFixture, scrubCredential } from "./sub-agent-real-fixture";

export async function realWebSubAgentFixture(base: string, name: string, source: ResolvedProviderConfig, files: Readonly<Record<string, string>> = {}, options: { readonly serverMode?: "dev" | "start"; readonly offload?:boolean; readonly limits?: Partial<import("@/core/sub-agents/types").SubAgentLimits>; readonly serverDirectory?: string; readonly permissionMode?: PermissionMode } = {}) {
  const fixture = await realSubAgentFixture(base, name, source, { "evidence.txt": "COMPLETION_EVIDENCE_20261020\n", ...files },options.offload,options.limits,options);
  await fixture.close();
  const holder = createServer();
  await new Promise<void>(resolve => holder.listen(0, "127.0.0.1", resolve));
  const address = holder.address();
  if (!address || typeof address === "string") throw new Error("没有评测端口。");
  const port = address.port;
  await new Promise<void>(resolve => holder.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", options.serverMode ?? "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: options.serverDirectory ?? process.cwd(), env: { ...process.env, ORBITCODE_DATA_DIR: path.join(fixture.root, "data"), ORBITCODE_SUB_AGENT_EVAL_KEY: source.apiKey }, stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<void>(resolve => server.once("exit", () => resolve()));
  for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { void appendFile(path.join(fixture.root, "server.txt"), scrubCredential(String(chunk), source)); });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    server.kill("SIGINT");
    const timer = setTimeout(() => server.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
    await fixture.save("web-cleanup.json", { pid: server.pid, port, exitCode: server.exitCode, signal: server.signalCode, serverExited: server.exitCode !== null || server.signalCode !== null });
  };
  const api = async <T>(route: string, method = "GET", body?: unknown): Promise<T> => {
    const response = await fetch(origin + route, { method, headers: { origin, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(`评测HTTP ${response.status} ${route}`);
    return response.json() as Promise<T>;
  };
  try {
    await fixture.save("web-server.json", { pid: server.pid, port, origin });
    const deadline = Date.now() + 60000;
    for (;;) {
      try { await api("/api/providers"); break; } catch { if (Date.now() > deadline || server.exitCode !== null) throw new Error("评测Web启动失败。"); }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const created = await api<{ summary: { id: string } }>("/api/conversations", "POST", { providerId: "real", workspaceId: "eval" });
    const conversationId = created.summary.id;
    const permission = await api<{ sessionId: string }>("/api/permission-sessions", "POST", {});
    const tasks = async () => (await api<{ tasks: readonly TaskView[] }>(`/api/conversations/${conversationId}/tasks`)).tasks;
    return {
      ...fixture, tasks, origin, conversationId, api,
      usage: async () => (await api<{usage:Awaited<ReturnType<typeof fixture.usage>>}>(`/api/conversations/${conversationId}/tasks`)).usage,
      readReply: async (taskId:string,offset=0,limit=4000)=>api<Awaited<ReturnType<typeof fixture.readReply>>>(`/api/conversations/${conversationId}/tasks/${encodeURIComponent(taskId)}/result`,"POST",{offset,limit}),
      run: async (prompt: string,parentExecutionMode?:import("@/core/sub-agents/parent-execution").ParentExecutionMode, delegationKind?: import("@/core/sub-agents/parent-execution").DelegationKind) => {
        const checkpoint = await api<{ summary: { revision: number }; modeTurn: number }>(`/api/conversations/${conversationId}`);
        await fixture.save("web-prompt.json", { prompt });
        const response = await fetch(origin + "/api/chat", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ conversationId, revision: checkpoint.summary.revision, permissionSessionId: permission.sessionId, mode: "do", modeTurn: checkpoint.modeTurn + 1, input: prompt,...(parentExecutionMode?{parentExecution:{version:1,mode:parentExecutionMode,...(delegationKind?{delegationKind}:{})}}:{}) }), signal: AbortSignal.timeout(360000) });
        if (!response.ok || !response.body) throw new Error(`聊天HTTP ${response.status}`);
        const events = [];
        for await (const event of parseWebChatEvents(readWebStream(response.body))) {
          events.push(event);
          if (event.type === "permission-requested") await api(`/api/permission-sessions/${permission.sessionId}/decisions`, "POST", { requestId: event.prompt.requestId, decision: "deny" });
        }
        await fixture.save("web-events.json", events);
      },
      settle: async () => {
        const deadline = Date.now() + 300000;
        while (Date.now() < deadline) {
          const current = await tasks();
          if (current.every(task => task.state.status === "terminal")) return current;
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        throw new Error("Web子任务等待超时。");
      },
      close: async () => {
        try { await fixture.save("checkpoint.json", await fixture.checkpoint()); } finally { await close(); }
      },
    };
  } catch (error) { await close(); throw error; }
}
