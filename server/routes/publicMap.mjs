import { jsonHeaders, readJsonBody, sendJson } from "../http/json.mjs";
import { HttpError } from "../lib/errors.mjs";
import { PUBLIC_MAP_STATE_LIMIT } from "../publicMap/index.mjs";
import { createRequestAbortScope, writeChatStreamEvent } from "./chat.mjs";

const noStore = { "Cache-Control": "private, no-store" };

function requireWorkspaceJson(request, workspaceCredential) {
  if ((!workspaceCredential && request.headers["sec-fetch-site"] === "cross-site") || !String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(403, "Use the public map from your Margin Chat workspace.");
  }
}

export async function handleWebSearchRequest({ request, response, user, webSearch, workspaceCredential = false }) {
  requireWorkspaceJson(request, workspaceCredential);
  const scope = createRequestAbortScope(request, response);
  try {
    const payload = await readJsonBody(request, 4096);
    sendJson(response, 200, await webSearch.search({ user, payload, signal: scope.signal }), noStore);
  } catch (error) {
    if (!scope.signal.aborted) throw error;
  } finally { scope.dispose(); }
}

export async function handlePublicMapRequest({ route, request, response, url, user, publicMap, workspaceCredential = false }) {
  if (route.id === "publicMapStateRead") {
    sendJson(response, 200, await publicMap.readState(user), noStore);
    return;
  }
  if (route.id === "publicMapStateWrite") {
    requireWorkspaceJson(request, workspaceCredential);
    const body = await readJsonBody(request, PUBLIC_MAP_STATE_LIMIT + 4096);
    sendJson(response, 200, await publicMap.writeState(user, body), noStore);
    return;
  }
  if (route.id === "publicMapAnswers") {
    const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
    sendJson(response, 200, await publicMap.listAnswers(user, {
      topicIds: url.searchParams.getAll("topic"), limit,
    }), noStore);
    return;
  }
  if (route.id === "publicMapAnswerDelete") {
    sendJson(response, 200, await publicMap.deleteAnswer(user, route.params.id), noStore);
    return;
  }
  // Asking streams progress, then the answer, like topic expansion. Public
  // answers are saved and shared; answers about a note in My map are not.
  requireWorkspaceJson(request, workspaceCredential);
  const scope = createRequestAbortScope(request, response);
  const startStream = () => {
    if (response.headersSent) return;
    response.writeHead(200, { ...jsonHeaders, "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "private, no-store, no-transform", "X-Accel-Buffering": "no" });
    response.flushHeaders?.();
  };
  try {
    const payload = await readJsonBody(request, 16_384);
    const method = route.id === "graphAsk" ? publicMap.askPrivate : publicMap.ask;
    const answer = await method({ payload, user, signal: scope.signal, onProgress(message) {
      scope.signal.throwIfAborted();
      startStream(); writeChatStreamEvent(response, { type: "progress", message });
    } });
    scope.signal.throwIfAborted();
    startStream(); writeChatStreamEvent(response, { type: "done", answer });
    response.end();
  } catch (error) {
    if (!scope.signal.aborted) throw error;
  } finally { scope.dispose(); }
}
