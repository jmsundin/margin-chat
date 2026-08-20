import { HttpError } from "../lib/errors.mjs";

export const jsonHeaders = Object.freeze({
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "DELETE,GET,POST,PUT,OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json; charset=utf-8",
});

export async function readJsonBody(request) {
  const body = await readRawBody(request);

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
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > maxBytes) {
      throw new HttpError(413, "Request body is too large.");
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
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
