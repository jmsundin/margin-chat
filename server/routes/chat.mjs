import { readJsonBody } from "../http/json.mjs";
import { CHAT_RUN_HEADER, chatRunFailure, chatRunId } from "../chat/runs.mjs";

// A conversation can carry attached documents and long history.
const CHAT_BODY_LIMIT = 8 * 1024 * 1024;

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

export async function handleChatRequest({ request, response, user, executeChatReply, chatRuns = null }) {
  const scope = createRequestAbortScope(request, response);
  // A named request keeps running after its browser disconnects and saves the
  // reply for the browser to pick up; an unnamed one stops with its connection.
  const runId = chatRuns ? chatRunId(request.headers?.[CHAT_RUN_HEADER]) : null;
  let run = null;
  const connected = () => !scope.signal.aborted && !response.destroyed && !response.writableEnded;
  const send = (event) => { if (connected()) writeChatStreamEvent(response, event); };
  try {
    scope.signal.throwIfAborted();
    const payload = await readJsonBody(request, CHAT_BODY_LIMIT);
    run = runId ? chatRuns.start({ id: runId, userId: user.id }) : null;
    const result = await executeChatReply({
      payload,
      user,
      signal: run?.signal ?? scope.signal,
      handlers: {
        onReady(metadata) {
          run?.metadata(metadata);
          if (!connected()) return;
          response.writeHead(200, {
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store, no-transform",
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "X-Accel-Buffering": "no",
          });
          response.flushHeaders?.();
          writeChatStreamEvent(response, { metadata, type: "metadata" });
        },
        onDelta(delta) {
          run?.delta(delta);
          send({ delta, type: "delta" });
        },
        onRetract() {
          run?.retract();
          send({ type: "retract" });
        },
        onStep({ step, spentMicros }) {
          send({ step, ...(spentMicros === undefined ? {} : { spentMicros }), type: "step" });
        },
        onThinking(delta) {
          send({ delta, type: "thinking" });
        },
        onActivity(activity, details = {}) {
          send({ activity, ...(details.label ? { label: details.label } : {}), ...(details.call ? { call: details.call } : {}), type: "activity" });
        },
        onDocuments(documents) {
          run?.documents(documents);
          send({ documents, type: "documents" });
        },
      },
    });
    await run?.finish({ status: "complete", metadata: result.metadata });
    if (!connected()) return;
    writeChatStreamEvent(response, { metadata: result.metadata, type: "done" });
    response.end();
  } catch (error) {
    if (run) await run.finish(run.signal.aborted ? null : { status: "failed", ...chatRunFailure(error) });
    // There is no connected client to receive an error after cancellation.
    if (!scope.signal.aborted && !run?.signal.aborted) throw error;
  } finally {
    scope.dispose();
  }
}
