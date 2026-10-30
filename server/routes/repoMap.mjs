import { jsonHeaders, readJsonBody } from "../http/json.mjs";
import { HttpError } from "../lib/errors.mjs";
import { createRequestAbortScope, writeChatStreamEvent } from "./chat.mjs";

/** Streams progress lines, then `{ type: "done", [key]: result }`, like the webpage map. */
export async function handleRepoMapRequest({ request, response, user, run, resultKey, bodyLimit, workspaceCredential = false }) {
  if ((!workspaceCredential && request.headers["sec-fetch-site"] === "cross-site") || !String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(403, "Explore repositories from your Margin Chat workspace.");
  }
  const scope = createRequestAbortScope(request, response);
  const startStream = () => {
    if (response.headersSent) return;
    response.writeHead(200, { ...jsonHeaders, "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "private, no-store, no-transform", "X-Accel-Buffering": "no" });
    response.flushHeaders?.();
  };
  try {
    const payload = await readJsonBody(request, bodyLimit);
    const result = await run({ payload, user, signal: scope.signal, onProgress(message) {
      startStream();
      writeChatStreamEvent(response, { type: "progress", message });
    } });
    startStream(); writeChatStreamEvent(response, { type: "done", [resultKey]: result });
    response.end();
  } catch (error) {
    if (!scope.signal.aborted) throw error;
  } finally { scope.dispose(); }
}
