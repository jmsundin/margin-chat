import { readJsonBody } from "../http/json.mjs";
import { HttpError } from "../lib/errors.mjs";
import { createRequestAbortScope, writeChatStreamEvent } from "./chat.mjs";

export async function handleTopicExpansionRequest({ request, response, user, expandTopic }) {
  if (request.headers["sec-fetch-site"] === "cross-site" || !String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(403, "Expand topics from your Margin Chat workspace.");
  }
  const scope = createRequestAbortScope(request, response);
  const startStream = () => {
    if (response.headersSent) return;
    response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "private, no-store, no-transform", "X-Accel-Buffering": "no" });
    response.flushHeaders?.();
  };
  try {
    scope.signal.throwIfAborted();
    const payload = await readJsonBody(request, 65_536);
    const expansion = await expandTopic({ payload, user, signal: scope.signal, onProgress(message) {
      scope.signal.throwIfAborted();
      startStream(); writeChatStreamEvent(response, { type: "progress", message });
    } });
    scope.signal.throwIfAborted();
    startStream(); writeChatStreamEvent(response, { type: "done", expansion });
    response.end();
  } catch (error) {
    if (!scope.signal.aborted) throw error;
  } finally { scope.dispose(); }
}
