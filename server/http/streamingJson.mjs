import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { jsonHeaders } from "./json.mjs";

const CHUNK_BYTES = 64 * 1024;

/** Preserve the JSON contract while allowing old, large manifests to download. */
export async function sendStreamingJson(response, statusCode, payload, extraHeaders = {}) {
  // Serialize before sending headers so malformed internal values still receive
  // the normal API error response. Byte chunks preserve multibyte UTF-8 text.
  const json = JSON.stringify(payload);
  response.writeHead(statusCode, { ...jsonHeaders, ...extraHeaders });
  if (Buffer.byteLength(json) <= CHUNK_BYTES) {
    response.end(json);
    return;
  }
  const bytes = Buffer.from(json);
  const chunks = Readable.from((function* () {
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      yield bytes.subarray(offset, offset + CHUNK_BYTES);
    }
  })(), { objectMode: false });
  // pipeline honors backpressure and destroys the response on a disconnect;
  // never append a second response or a chat event to incomplete JSON.
  await pipeline(chunks, response);
}

const LINE_BATCH_BYTES = 64 * 1024;

function drained(response) {
  return new Promise((resolve) => {
    const done = () => {
      response.off("drain", done);
      response.off("close", done);
      resolve();
    };
    response.on("drain", done);
    response.on("close", done);
  });
}

/**
 * Newline-delimited JSON, written as values become available so a client can
 * show the first results before the last are ready. Headers are sent with the
 * first write, so an error before then still gets the normal API response.
 */
export function createNdjsonResponse(response, statusCode = 200, extraHeaders = {}) {
  let started = false;
  let pending = "";
  const start = () => {
    if (started) return;
    started = true;
    response.writeHead(statusCode, { ...jsonHeaders, "Content-Type": "application/x-ndjson; charset=utf-8", ...extraHeaders });
  };
  async function flush() {
    start();
    if (!pending || response.destroyed) return;
    const chunk = pending;
    pending = "";
    if (!response.write(chunk)) await drained(response);
  }
  return {
    get started() { return started; },
    /** Queue a value; `immediate` sends it (and anything queued) now. */
    async write(value, { immediate = true } = {}) {
      pending += `${JSON.stringify(value)}\n`;
      if (immediate || pending.length >= LINE_BATCH_BYTES) await flush();
    },
    async end() {
      await flush();
      if (!response.destroyed) response.end();
    },
  };
}
