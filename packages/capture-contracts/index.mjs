// Version 1 is additive: keep these fields and routes compatible with installed clippers.
export const CAPTURE_API_PATH = "/api/v1/captures";
export const CONNECTION_API_PATH = "/api/v1/capture-connection";
export const EXTENSION_SESSION_API_PATH = "/api/v1/extension-session";
export const CAPTURE_LIMITS = Object.freeze({
  title: 300,
  url: 4096,
  content: 200_000,
  comment: 10_000,
});
export const CAPTURE_KINDS = Object.freeze([
  "selection",
  "article",
  "bookmark",
]);

function textField(input, name, limit, required = false) {
  const value = input[name] ?? "";
  if (typeof value !== "string" || value.includes("\0"))
    throw new Error(`Invalid ${name}.`);
  const text = value.trim();
  if (text.length > limit)
    throw new Error(
      `${name} is too long (maximum ${limit.toLocaleString()} characters).`,
    );
  if (required && !text) throw new Error(`${name} is required.`);
  return text;
}

function normalizeCaptureMetadata(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("A capture is required.");
  if (input.schemaVersion !== 1)
    throw new Error("Unsupported capture version. Update the extension.");
  if (!CAPTURE_KINDS.includes(input.kind))
    throw new Error("Invalid capture kind.");
  if (
    typeof input.clientCaptureId !== "string" ||
    !/^[a-zA-Z0-9_-]{16,100}$/u.test(input.clientCaptureId)
  ) {
    throw new Error("Invalid capture identifier.");
  }
  const sourceUrl = textField(input, "sourceUrl", CAPTURE_LIMITS.url, true);
  let url;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new Error("A valid source URL is required.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "Only HTTP and HTTPS pages without embedded credentials can be saved.",
    );
  }
  const capturedAt = textField(input, "capturedAt", 40, true);
  if (!Number.isFinite(Date.parse(capturedAt)))
    throw new Error("Invalid capture date.");
  return {
    schemaVersion: 1,
    clientCaptureId: input.clientCaptureId,
    kind: input.kind,
    title: textField(input, "title", CAPTURE_LIMITS.title, true),
    sourceUrl: url.href,
    capturedAt: new Date(capturedAt).toISOString(),
  };
}

export function normalizeCapture(input) {
  const metadata = normalizeCaptureMetadata(input);
  // Keep the serialized field order stable: the server hashes this payload for retries.
  return {
    schemaVersion: metadata.schemaVersion,
    clientCaptureId: metadata.clientCaptureId,
    kind: metadata.kind,
    title: metadata.title,
    sourceUrl: metadata.sourceUrl,
    content: textField(
      input,
      "content",
      CAPTURE_LIMITS.content,
      input.kind !== "bookmark",
    ),
    comment: textField(input, "comment", CAPTURE_LIMITS.comment),
    capturedAt: metadata.capturedAt,
  };
}

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value) =>
  typeof value === "string" && Boolean(value.trim()) && !value.includes("\0");
const isDate = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

function requireResponse(valid, message) {
  if (!valid) throw new Error(message);
}

// Responses are additive within v1. Validate known fields without removing or
// rejecting new fields supplied by a newer server.
export function parseCaptureReceipt(input) {
  requireResponse(
    isRecord(input) && isRecord(input.capture) &&
      isText(input.capture.id) && isDate(input.capture.createdAt),
    "The server did not confirm the save. Retry to check it.",
  );
  return input;
}

export function parseExtensionSession(input) {
  requireResponse(
    isRecord(input) && typeof input.token === "string" &&
      /^mc_extension_[A-Za-z0-9_-]{43}$/u.test(input.token) &&
      isRecord(input.user) && isText(input.user.id) &&
      isText(input.user.displayName) && isText(input.user.email) &&
      isDate(input.expiresAt) && Date.parse(input.expiresAt) > Date.now(),
    "This server did not return a valid session. Update your Margin Chat server and try again.",
  );
  return input;
}

export function parseCaptureConnection(input) {
  requireResponse(
    isRecord(input) && isText(input.displayName) && isDate(input.expiresAt) &&
      (input.userId === undefined || isText(input.userId)),
    "The server returned an invalid capture connection.",
  );
  return input;
}

export function parseCapture(input) {
  const message = "The server returned an invalid capture.";
  requireResponse(
    isRecord(input) && isText(input.id) && isDate(input.createdAt) &&
      typeof input.content === "string" && typeof input.comment === "string",
    message,
  );
  try {
    normalizeCapture(input);
  } catch {
    throw new Error(message);
  }
  return input;
}

export function parseCaptureDetail(input) {
  requireResponse(isRecord(input), "The server returned an invalid capture.");
  parseCapture(input.capture);
  return input;
}

export function parseCapturePage(input) {
  const message = "The server returned an invalid Cloud Inbox page.";
  requireResponse(
    isRecord(input) && Array.isArray(input.captures) &&
      (input.nextCursor === null || isText(input.nextCursor)),
    message,
  );
  for (const capture of input.captures) {
    requireResponse(
      isRecord(capture) && isText(capture.id) && isDate(capture.createdAt) &&
        typeof capture.excerpt === "string",
      message,
    );
    try {
      normalizeCaptureMetadata(capture);
    } catch {
      throw new Error(message);
    }
  }
  return input;
}

export function normalizeServerUrl(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new Error("Enter your Margin Chat website address.");
  }
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password
  ) {
    throw new Error("Use HTTPS, or HTTP on localhost for development.");
  }
  if (url.pathname !== "/" || url.search || url.hash)
    throw new Error(
      "Use the website address without a path, query, or fragment.",
    );
  return url.origin;
}

export function escapeMarkdown(value) {
  return value.replace(/[\\`*_{}\[\]<>()#+.!|~-]/gu, "\\$&");
}

export function captureToMarkdown(capture) {
  // Render metadata and personal comments as text, never as executable HTML.
  const sourceUrl = new URL(capture.sourceUrl).href
    .replace(/</gu, "%3C")
    .replace(/>/gu, "%3E")
    .replace(/\(/gu, "%28")
    .replace(/\)/gu, "%29");
  const sourceLabel = new URL(sourceUrl).hostname.replace(/[\\\[\]]/gu, "\\$&");
  return [
    `Source: [${sourceLabel}](${sourceUrl})`,
    `Captured: ${capture.capturedAt}`,
    capture.comment ? `## My note\n\n${escapeMarkdown(capture.comment)}` : "",
    capture.content
      ? `## ${capture.kind === "selection" ? "Saved passage" : "Article"}\n\n${capture.content}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
