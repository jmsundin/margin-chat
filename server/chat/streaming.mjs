import { HttpError } from "../lib/errors.mjs";

export async function* parseServerSentEvents(body) {
  if (!body) {
    throw new HttpError(502, "The model provider returned an empty stream.");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });

    while (true) {
      const boundary = buffer.match(/\r?\n\r?\n/);

      if (!boundary || boundary.index === undefined) {
        break;
      }

      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = getEventData(block);

      if (data !== null) {
        yield data;
      }
    }
  }

  buffer += decoder.decode();

  if (buffer.trim()) {
    const data = getEventData(buffer);

    if (data !== null) {
      yield data;
    }
  }
}

export async function parseProviderErrorResponse(response) {
  const text = await response.text().catch(() => "");

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

export function parseStreamJson(data) {
  if (data === "[DONE]") {
    return null;
  }

  try {
    return JSON.parse(data);
  } catch {
    throw new HttpError(502, "The model provider returned an invalid stream event.");
  }
}

function getEventData(block) {
  const dataLines = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));

  return dataLines.length ? dataLines.join("\n") : null;
}
