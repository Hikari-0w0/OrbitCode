import type { ContextCompressionResponse } from "@/web/chat-contract";
import {
  contextApiErrorResponse,
  requireContextSessionId,
} from "@/web/context-http";
import { ContextSessionError } from "@/web/context-session-manager";
import { contextSessionManager } from "@/web/context-session-store";
import { assertSameOrigin } from "@/web/request-security";

type RouteContext = {
  readonly params: Promise<{ readonly sessionId: string }>;
};

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  let active:
    | { readonly sessionId: string; readonly operationId: string }
    | undefined;
  try {
    assertSameOrigin(request);
    const { sessionId: rawSessionId } = await context.params;
    const sessionId = requireContextSessionId(rawSessionId);
    const operation = contextSessionManager.beginManualCompression(sessionId);
    active = { sessionId, operationId: operation.id };
    const signal = AbortSignal.any([request.signal, operation.signal]);
    const report: ContextCompressionResponse =
      await operation.context.compressManually(signal);
    return Response.json(report, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return contextApiErrorResponse(error);
  } finally {
    if (active) {
      try {
        contextSessionManager.finishOperation(
          active.sessionId,
          active.operationId,
        );
      } catch (error) {
        if (!(error instanceof ContextSessionError)) throw error;
      }
    }
  }
}
