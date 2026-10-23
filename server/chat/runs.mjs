import { HttpError, hasStatusCode } from "../lib/errors.mjs";

/** The browser names each Ask AI request so it can find the reply again after a disconnect. */
export const CHAT_RUN_HEADER = "x-margin-chat-run";
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function chatRunId(value) {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  return RUN_ID.test(id) ? id : null;
}

export function chatRunFailure(error) {
  const known = error instanceof HttpError || hasStatusCode(error);
  return { error: known ? error.message : "The model stream ended unexpectedly.", statusCode: known ? error.statusCode : 500 };
}

/**
 * A reply that outlives its request. Phones drop the connection when the user
 * switches tabs or apps; the reply keeps going and is saved every couple of
 * seconds, and each save also learns whether the user pressed Stop, which can
 * arrive at another server instance.
 */
export function createChatRunService({ database, saveEveryMs = 2_000 }) {
  const running = new Map();
  const key = (id, userId) => `${userId}\u0000${id}`;

  function start({ id, userId }) {
    const controller = new AbortController();
    const state = { reply: "", metadata: null, documents: [] };
    let timer;
    let saving = null;
    let ended = false;
    running.set(key(id, userId), controller);
    const save = async (fields = {}) => {
      let status = null;
      try {
        status = await database.saveChatRun({ id, userId, ...state, ...fields });
      } catch (error) {
        console.error("Could not save the AI reply in progress", error);
      }
      if (status === "cancelled") controller.abort(new DOMException("The reply was stopped.", "AbortError"));
    };
    const tick = () => {
      saving = save().finally(() => {
        saving = null;
        if (!ended && !controller.signal.aborted) timer = setTimeout(tick, saveEveryMs);
      });
    };
    tick();
    return {
      signal: controller.signal,
      delta(delta) { state.reply += delta; },
      retract() { state.reply = ""; },
      metadata(metadata) { state.metadata = metadata; },
      documents(documents) { state.documents.push(...documents); },
      /** Saves the run's end; a stopped run saves nothing more. */
      async finish(fields) {
        ended = true;
        clearTimeout(timer);
        await saving;
        running.delete(key(id, userId));
        if (fields && !controller.signal.aborted) await save(fields);
      },
    };
  }

  return {
    start,
    read: ({ id, userId }) => database.readChatRun({ id, userId }),
    async cancel({ id, userId }) {
      running.get(key(id, userId))?.abort(new DOMException("The reply was stopped.", "AbortError"));
      await database.cancelChatRun({ id, userId });
    },
  };
}
