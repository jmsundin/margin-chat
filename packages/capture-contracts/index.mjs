// Version 1 is additive: keep these fields and routes compatible with installed clippers.
export const CAPTURE_API_PATH = "/api/v1/captures";
export const CONNECTION_API_PATH = "/api/v1/capture-connection";
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

export function normalizeCapture(input) {
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
    content: textField(
      input,
      "content",
      CAPTURE_LIMITS.content,
      input.kind !== "bookmark",
    ),
    comment: textField(input, "comment", CAPTURE_LIMITS.comment),
    capturedAt: new Date(capturedAt).toISOString(),
  };
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
