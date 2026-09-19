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
