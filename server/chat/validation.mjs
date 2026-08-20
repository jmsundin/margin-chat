import {
  getDefaultModelIdForService,
  isBackendModelIdForService,
} from "../lib/backendModels.mjs";
import { HttpError } from "../lib/errors.mjs";

const VALID_MESSAGE_ROLES = new Set(["assistant", "system", "user"]);
const VALID_SERVICE_IDS = new Set([
  "backend-services",
  "gemini-api",
  "huggingface-api",
  "openai-api",
  "openai-agent",
  "xai-api",
]);

export function validateChatRequest(body) {
  const requestReceivedAt = new Date().toISOString();

  if (!body || typeof body !== "object") {
    throw new HttpError(400, "Request body must be a JSON object.");
  }

  if (!isBackendServiceId(body.serviceId)) {
    throw new HttpError(400, "serviceId must be a supported backend service.");
  }

  if (
    body.modelId !== undefined &&
    body.modelId !== null &&
    typeof body.modelId !== "string"
  ) {
    throw new HttpError(400, "modelId must be a string when provided.");
  }

  const modelId =
    typeof body.modelId === "string" && body.modelId.trim()
      ? body.modelId.trim()
      : getDefaultModelIdForService(body.serviceId);

  if (!isBackendModelIdForService(body.serviceId, modelId)) {
    throw new HttpError(
      400,
      "modelId must be a supported model for the selected backend service.",
    );
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
  const documents = body.conversation.documents ?? [];

  if (!Array.isArray(documents) || documents.length > 20) {
    throw new HttpError(
      400,
      "conversation.documents must be an array containing at most 20 documents.",
    );
  }

  const documentIds = new Set();

  for (const document of documents) {
    if (
      !document ||
      typeof document !== "object" ||
      typeof document.id !== "string" ||
      !document.id.trim() ||
      typeof document.filename !== "string" ||
      !document.filename.trim()
    ) {
      throw new HttpError(
        400,
        "Each conversation document must include an id and filename.",
      );
    }

    if (documentIds.has(document.id)) {
      throw new HttpError(400, "conversation.documents cannot contain duplicates.");
    }

    documentIds.add(document.id);
  }

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

  const ancestorContext = body.conversation.ancestorContext ?? [];

  if (!Array.isArray(ancestorContext)) {
    throw new HttpError(400, "conversation.ancestorContext must be an array.");
  }

  for (const ancestor of ancestorContext) {
    if (
      !ancestor ||
      typeof ancestor !== "object" ||
      typeof ancestor.id !== "string" ||
      typeof ancestor.title !== "string" ||
      !Array.isArray(ancestor.messages)
    ) {
      throw new HttpError(
        400,
        "Each ancestor context entry must include id, title, and messages.",
      );
    }

    for (const message of ancestor.messages) {
      if (
        !message ||
        typeof message !== "object" ||
        !VALID_MESSAGE_ROLES.has(message.role) ||
        typeof message.content !== "string" ||
        !message.content.trim()
      ) {
        throw new HttpError(
          400,
          "Ancestor context messages must include a valid role and content.",
        );
      }
    }
  }

  return {
    conversation: {
      ancestorContext: ancestorContext.map((ancestor) => ({
        branchAnchor: ancestor.branchAnchor ?? null,
        id: ancestor.id,
        messages: ancestor.messages.map((message) => ({
          content: message.content,
          role: message.role,
        })),
        title: ancestor.title,
      })),
      branchAnchor: branchAnchor ?? null,
      documents: documents.map((document) => ({
        filename: document.filename.trim(),
        id: document.id.trim(),
      })),
      id: String(body.conversation.id ?? ""),
      parentId:
        body.conversation.parentId === null ||
        body.conversation.parentId === undefined
          ? null
          : String(body.conversation.parentId),
      title: String(body.conversation.title ?? ""),
    },
    messages: body.messages.map((message, index) => ({
      content: message.content,
      createdAt:
        typeof message.createdAt === "string" && message.createdAt.trim()
          ? message.createdAt
          : requestReceivedAt,
      id:
        typeof message.id === "string" && message.id.trim()
          ? message.id
          : `message-${index}`,
      role: message.role,
    })),
    modelId,
    serviceId: body.serviceId,
  };
}

export function isBackendServiceId(value) {
  return VALID_SERVICE_IDS.has(value);
}
