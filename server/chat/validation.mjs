import {
  getDefaultModelIdForService,
  isBackendModelIdForService,
} from "../lib/backendModels.mjs";
import { HttpError } from "../lib/errors.mjs";

const VALID_MESSAGE_ROLES = new Set(["assistant", "system", "user"]);
const AI_PROVIDERS = new Set(["openai", "gemini", "huggingface", "xai"]);

export function validateAIOptions(input) {
  if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) {
    throw new HttpError(400, "ai must be an object.");
  }
  const ai = input ?? {};
  const mode = ai.mode ?? "balanced";
  const contextScope = ai.contextScope ?? "conversation";
  if (!["fast", "balanced", "thorough"].includes(mode)) throw new HttpError(400, "Unsupported AI mode.");
  if (!["conversation", "selected", "workspace"].includes(contextScope)) throw new HttpError(400, "Unsupported AI context scope.");
  const selectedConversationIds = ai.selectedConversationIds ?? [];
  if (!Array.isArray(selectedConversationIds) || selectedConversationIds.length > 500 ||
      selectedConversationIds.some((id) => typeof id !== "string" || !id.trim())) {
    throw new HttpError(400, "selectedConversationIds must contain at most 500 conversation IDs.");
  }
  if (ai.allowedProviders !== undefined && (!Array.isArray(ai.allowedProviders) ||
      ai.allowedProviders.some((provider) => !AI_PROVIDERS.has(provider)))) {
    throw new HttpError(400, "allowedProviders must contain supported provider names.");
  }
  return {
    mode,
    contextScope,
    selectedConversationIds: [...new Set(selectedConversationIds)],
    ...(ai.allowedProviders === undefined ? {} : { allowedProviders: [...new Set(ai.allowedProviders)] }),
  };
}

function validateWorkspaceContext(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 500) throw new HttpError(400, "workspaceContext must contain at most 500 items.");
  const seen = new Set();
  return input.map((item) => {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id.trim() ||
        seen.has(item.id) || typeof item.title !== "string" || !Array.isArray(item.messages) ||
        (item.content !== undefined && typeof item.content !== "string")) {
      throw new HttpError(400, "Each workspace context item needs a unique id, title, and messages.");
    }
    seen.add(item.id);
    const messages = item.messages.map((message, index) => {
      if (!message || !VALID_MESSAGE_ROLES.has(message.role) || typeof message.content !== "string") {
        throw new HttpError(400, "Workspace context messages need a valid role and content.");
      }
      return { id: typeof message.id === "string" ? message.id : `context-${index}`, role: message.role, content: message.content };
    });
    // Deliberately whitelist fields: margin annotations and stored execution
    // receipts never enter model context or workspace tool search.
    return {
      id: item.id,
      title: item.title.slice(0, 500),
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : undefined,
      messages,
      ...(item.content === undefined ? {} : { content: item.content }),
    };
  });
}
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

  if (!Array.isArray(ancestorContext) || ancestorContext.length > 500) {
    throw new HttpError(400, "conversation.ancestorContext must be an array containing at most 500 ancestors.");
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
    ai: validateAIOptions(body.ai),
    workspaceContext: validateWorkspaceContext(body.workspaceContext),
    workspaceContextTruncated: body.workspaceContextTruncated === true,
    conversation: {
      ancestorContext: ancestorContext.map((ancestor) => ({
        branchAnchor: ancestor.branchAnchor ?? null,
        id: ancestor.id,
        updatedAt: typeof ancestor.updatedAt === "string" ? ancestor.updatedAt : undefined,
        messages: ancestor.messages.map((message) => ({
          id: typeof message.id === "string" ? message.id : undefined,
          content: message.content,
          role: message.role,
        })),
        title: ancestor.title.slice(0, 500),
      })),
      branchAnchor: branchAnchor ?? null,
      documents: documents.map((document) => ({
        filename: document.filename.trim(),
        id: document.id.trim(),
      })),
      id: String(body.conversation.id ?? ""),
      updatedAt: typeof body.conversation.updatedAt === "string" ? body.conversation.updatedAt : undefined,
      parentId:
        body.conversation.parentId === null ||
        body.conversation.parentId === undefined
          ? null
          : String(body.conversation.parentId),
      title: String(body.conversation.title ?? "").slice(0, 500),
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
