import { assertSettingsMutation, settingsSessionOwner, LocalManagementError } from "@/web/local-management-guard";
import { settingsOperations } from "@/web/settings-operations";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ operationId: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    const owner = settingsSessionOwner(request);
    const { operationId } = await context.params;
    if (!settingsOperations.has(owner, operationId)) return Response.json({ error: "管理操作不存在。" }, { status: 404 });
    let unsubscribe: (() => void) | undefined;
    let detach = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let ended = false;
        const close = () => {
          if (ended) return;
          ended = true; unsubscribe?.(); request.signal.removeEventListener("abort", close); controller.close();
        };
        detach = () => {
          ended = true; request.signal.removeEventListener("abort", close); unsubscribe?.();
        };
        unsubscribe = settingsOperations.subscribe(owner, operationId, (event) => {
          if (ended) return;
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
          if (event.type === "finished") close();
        });
        if (ended) unsubscribe();
        else if (request.signal.aborted) close();
        else request.signal.addEventListener("abort", close, { once: true });
      },
      cancel() { detach(); },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
  } catch (error) { return Response.json({ error: "管理会话无效。" }, { status: error instanceof LocalManagementError ? 403 : 500 }); }
}
export async function DELETE(request: Request, context: Context): Promise<Response> {
  try {
    assertSettingsMutation(request);
    const { operationId } = await context.params;
    return new Response(null, { status: settingsOperations.cancel(settingsSessionOwner(request), operationId) ? 204 : 404 });
  } catch { return Response.json({ error: "管理会话无效。" }, { status: 403 }); }
}
