import { HttpError } from "../lib/errors.mjs";

export const jsonHeaders = Object.freeze({
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Margin-Capture-Settings,X-Margin-Vault-Write,X-Margin-Vault-User",
  "Access-Control-Allow-Methods": "DELETE,GET,POST,PUT,OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json; charset=utf-8",
});

export async function readJsonBody(request, maxBytes = Infinity) {
  const body = await readRawBody(request, maxBytes);

  if (!body.length) {
    throw new HttpError(400, "Request body is required.");
  }

  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must contain valid JSON.");
  }
}

export async function readRawBody(request, maxBytes = Infinity) {
  // Do not throw out of an IncomingMessage async iterator: it destroys the
  // socket before the handler can return its 413 response (including on Bun).
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    function cleanup() {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    }
    function onError(error) { cleanup(); reject(error); }
    function onAborted() { onError(new HttpError(400, "Request upload was interrupted.")); }
    function onEnd() { cleanup(); resolve(Buffer.concat(chunks)); }
    function onData(chunk) {
      size += chunk.length;
      if (size > maxBytes) {
        cleanup();
        request.resume();
        reject(new HttpError(413, "Request body is too large."));
      } else { chunks.push(chunk); }
    }
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("aborted", onAborted);
  });
}

export async function readMultipartForm(request, maxBytes) {
  const contentType = String(request.headers["content-type"] ?? "");

  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new HttpError(415, "Request must use multipart/form-data.");
  }

  const body = await readRawBody(request, maxBytes);
  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  return new Request("http://localhost/upload", {
    body,
    headers,
    method: "POST",
  }).formData();
}

export function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    ...jsonHeaders,
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}
