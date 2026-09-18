import { readJsonBody } from "../http/json.mjs";

export function writeChatStreamEvent(response, event) {
  response.write(`${JSON.stringify(event)}\n`);
  response.flush?.();
}

export function createRequestAbortScope(request, response) {
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException("The client disconnected.", "AbortError"));
  const onClose = () => { if (!response.writableEnded) abort(); };
  request.on("aborted", abort);
  response.on("close", onClose);
  response.on("error", abort);
  if (request.aborted || response.destroyed) abort();
  return {
    signal: controller.signal,
    dispose() {
      request.off("aborted", abort);
      response.off("close", onClose);
      response.off("error", abort);
    },
  };
}

export async function handleChatRequest({ request, response, user, executeChatReply }) {
  const scope = createRequestAbortScope(request, response);
  try {
    scope.signal.throwIfAborted();
    const payload = await readJsonBody(request);
    const result = await executeChatReply({
      payload,
      user,
      signal: scope.signal,
      handlers: {
        onReady(metadata) {
          response.writeHead(200, {
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache, no-transform",
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "X-Accel-Buffering": "no",
          });
          response.flushHeaders?.();
          writeChatStreamEvent(response, { metadata, type: "metadata" });
        },
        onDelta(delta) {
          writeChatStreamEvent(response, { delta, type: "delta" });
        },
      },
    });
    writeChatStreamEvent(response, { metadata: result.metadata, type: "done" });
    response.end();
  } catch (error) {
    // There is no connected client to receive an error after cancellation.
    if (!scope.signal.aborted) throw error;
  } finally {
    scope.dispose();
  }
}
