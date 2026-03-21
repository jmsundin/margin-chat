import { HttpError } from "../lib/errors.mjs";

export const jsonHeaders = Object.freeze({
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
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

export async function readRawBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

export function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    ...jsonHeaders,
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}
