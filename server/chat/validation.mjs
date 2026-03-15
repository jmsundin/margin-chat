import { HttpError } from "../lib/errors.mjs";

const VALID_MESSAGE_ROLES = new Set(["assistant", "system", "user"]);
const VALID_SERVICE_IDS = new Set([
  "backend-services",
  "gemini-api",
  "huggingface-api",
  "openai-api",
]);

export function validateChatRequest(body) {
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "Request body must be a JSON object.");
  }

  if (!isBackendServiceId(body.serviceId)) {
    throw new HttpError(400, "serviceId must be a supported backend service.");
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new HttpError(400, "messages must be a non-empty array.");
  }

  for (const message of body.messages) {
    if (!message || typeof message !== "object") {
      throw new HttpError(400, "Each message must be an object.");
    }

    if (!VALID_MESSAGE_ROLES.has(message.role)) {
      throw new HttpError(
        400,
        "Each message role must be system, user, or assistant.",
      );
    }

    if (typeof message.content !== "string" || !message.content.trim()) {
      throw new HttpError(
        400,
        "Each message content must be a non-empty string.",
      );
    }
  }

  if (!body.conversation || typeof body.conversation !== "object") {
    throw new HttpError(400, "conversation metadata is required.");
  }

  const branchAnchor = body.conversation.branchAnchor;

  if (
    branchAnchor !== null &&
    branchAnchor !== undefined &&
    (!branchAnchor ||
      typeof branchAnchor !== "object" ||
      typeof branchAnchor.quote !== "string" ||
      typeof branchAnchor.prompt !== "string")
  ) {
    throw new HttpError(
      400,
      "conversation.branchAnchor must be null or include quote and prompt.",
    );
  }

  return {
    conversation: {
      branchAnchor: branchAnchor ?? null,
      id: String(body.conversation.id ?? ""),
      parentId:
        body.conversation.parentId === null ||
        body.conversation.parentId === undefined
          ? null
          : String(body.conversation.parentId),
      title: String(body.conversation.title ?? ""),
    },
    messages: body.messages.map((message) => ({
      content: message.content,
      role: message.role,
    })),
    serviceId: body.serviceId,
  };
}

export function isBackendServiceId(value) {
  return VALID_SERVICE_IDS.has(value);
}
