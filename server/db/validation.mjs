import {
  getDefaultModelIdForService,
  isBackendModelIdForService,
} from "../lib/backendModels.mjs";
import {
  VALID_MESSAGE_ROLES,
  VALID_SERVICE_IDS,
} from "./constants.mjs";
import { createStateError } from "./errors.mjs";

const DEFAULT_SERVICE_ID = "backend-services";

export function normalizeAppState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw createStateError("App state must be a JSON object.");
  }

  if (typeof input.rootId !== "string" || !input.rootId) {
    throw createStateError("rootId must be a non-empty string.");
  }

  if (
    typeof input.activeConversationId !== "string" ||
    !input.activeConversationId
  ) {
    throw createStateError("activeConversationId must be a non-empty string.");
  }

  if (typeof input.railOpen !== "boolean") {
    throw createStateError("railOpen must be a boolean.");
  }

  if (
    !input.conversations ||
    typeof input.conversations !== "object" ||
    Array.isArray(input.conversations)
  ) {
    throw createStateError("conversations must be a keyed object.");
  }

  const normalizedConversations = Object.entries(input.conversations).map(
    ([conversationId, conversation]) =>
      normalizeConversation(conversationId, conversation),
  );

  if (!normalizedConversations.length) {
    throw createStateError("At least one conversation is required.");
  }

  const conversationsById = Object.fromEntries(
    normalizedConversations.map((conversation) => [conversation.id, conversation]),
  );
  const normalizedPinnedThreadIds = normalizePinnedThreadIds(
    input.pinnedThreadIds,
    conversationsById,
  );

  if (!conversationsById[input.rootId]) {
    throw createStateError("rootId must reference an existing conversation.");
  }

  if (!conversationsById[input.activeConversationId]) {
    throw createStateError(
      "activeConversationId must reference an existing conversation.",
    );
  }

  const rootConversations = normalizedConversations.filter(
    (conversation) => conversation.parentId === null,
  );

  if (!rootConversations.length) {
    throw createStateError("At least one root conversation is required.");
  }

  if (conversationsById[input.rootId].parentId !== null) {
    throw createStateError(
      "rootId must reference a top-level conversation.",
    );
  }

  const messageIds = new Set();

  for (const conversation of normalizedConversations) {
    if (conversation.parentId && !conversationsById[conversation.parentId]) {
      throw createStateError(
        `Conversation "${conversation.id}" references a missing parent.`,
      );
    }

    if (conversation.parentId === null && conversation.branchAnchor !== null) {
      throw createStateError(
        `Root conversation "${conversation.id}" cannot have a branch anchor.`,
      );
    }

    if (conversation.parentId !== null && conversation.branchAnchor === null) {
      throw createStateError(
        `Branch conversation "${conversation.id}" must include a branch anchor.`,
      );
    }

    for (const message of conversation.messages) {
      if (messageIds.has(message.id)) {
        throw createStateError(`Duplicate message id "${message.id}".`);
      }

      messageIds.add(message.id);
    }
  }

  for (const conversation of normalizedConversations) {
    if (!conversation.branchAnchor) {
      continue;
    }

    if (!conversationsById[conversation.branchAnchor.sourceConversationId]) {
      throw createStateError(
        `Anchor "${conversation.branchAnchor.id}" references a missing source conversation.`,
      );
    }

    if (!messageIds.has(conversation.branchAnchor.sourceMessageId)) {
      throw createStateError(
        `Anchor "${conversation.branchAnchor.id}" references a missing source message.`,
      );
    }
  }

  const activeRootId = getRootConversationId(
    conversationsById,
    input.activeConversationId,
  );

  if (!activeRootId) {
    throw createStateError(
      "activeConversationId must belong to a valid conversation tree.",
    );
  }

  if (activeRootId !== input.rootId) {
    throw createStateError(
      "rootId must match the root conversation of activeConversationId.",
    );
  }

  const { defaultModelId, defaultServiceId } = normalizeDefaultSelection(
    input.defaultServiceId,
    input.defaultModelId,
    conversationsById,
    input.activeConversationId,
    input.rootId,
  );

  return {
    activeConversationId: input.activeConversationId,
    conversations: normalizedConversations,
    defaultModelId,
    defaultServiceId,
    pinnedThreadIds: normalizedPinnedThreadIds,
    railOpen: input.railOpen,
    rootId: input.rootId,
  };
}

function normalizeDefaultSelection(
  inputServiceId,
  inputModelId,
  conversationsById,
  activeConversationId,
  rootId,
) {
  if (
    inputServiceId !== undefined &&
    inputServiceId !== null &&
    inputServiceId !== "" &&
    !VALID_SERVICE_IDS.has(inputServiceId)
  ) {
    throw createStateError("defaultServiceId must use a supported serviceId.");
  }

  const fallbackConversation =
    conversationsById[activeConversationId] ??
    conversationsById[rootId] ??
    Object.values(conversationsById).find(
      (conversation) => conversation.parentId === null,
    ) ??
    Object.values(conversationsById)[0] ??
    null;
  const defaultServiceId = VALID_SERVICE_IDS.has(inputServiceId)
    ? inputServiceId
    : fallbackConversation?.serviceId ?? DEFAULT_SERVICE_ID;
  const fallbackModelId =
    fallbackConversation?.serviceId === defaultServiceId
      ? fallbackConversation.modelId
      : getDefaultModelIdForService(defaultServiceId);

  if (inputModelId === undefined || inputModelId === null || inputModelId === "") {
    return {
      defaultModelId: fallbackModelId,
      defaultServiceId,
    };
  }

  if (typeof inputModelId !== "string") {
    throw createStateError("defaultModelId must be a string.");
  }

  const defaultModelId = inputModelId.trim();

  if (!defaultModelId) {
    return {
      defaultModelId: fallbackModelId,
      defaultServiceId,
    };
  }

  if (!isBackendModelIdForService(defaultServiceId, defaultModelId)) {
    throw createStateError(
      `defaultModelId must use a supported modelId for "${defaultServiceId}".`,
    );
  }

  return {
    defaultModelId,
    defaultServiceId,
  };
}

function normalizePinnedThreadIds(input, conversationsById) {
  if (input === undefined) {
    return [];
  }

  if (!Array.isArray(input)) {
    throw createStateError("pinnedThreadIds must be an array.");
  }

  const seen = new Set();
  const pinnedThreadIds = [];

  for (const [index, value] of input.entries()) {
    const threadId = normalizeId(value, `pinnedThreadIds[${index}]`);

    if (seen.has(threadId)) {
      continue;
    }

    const conversation = conversationsById[threadId];

    if (!conversation) {
      throw createStateError(
        `Pinned thread "${threadId}" must reference an existing conversation.`,
      );
    }

    if (conversation.parentId !== null) {
      throw createStateError(
        `Pinned thread "${threadId}" must reference a top-level conversation.`,
      );
    }

    seen.add(threadId);
    pinnedThreadIds.push(threadId);
  }

  return pinnedThreadIds;
}

function getRootConversationId(conversationsById, conversationId) {
  const visited = new Set();
  let current = conversationsById[conversationId];

  while (current && !visited.has(current.id)) {
    if (current.parentId === null) {
      return current.id;
    }

    visited.add(current.id);
    current = conversationsById[current.parentId];
  }

  return null;
}

function normalizeConversation(expectedId, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw createStateError(
      `Conversation "${expectedId}" must be a JSON object.`,
    );
  }

  if (typeof input.id !== "string" || input.id !== expectedId) {
    throw createStateError(
      `Conversation "${expectedId}" must include a matching id.`,
    );
  }

  if (typeof input.title !== "string" || !input.title.trim()) {
    throw createStateError(
      `Conversation "${expectedId}" must include a title.`,
    );
  }

  if (!VALID_SERVICE_IDS.has(input.serviceId)) {
    throw createStateError(
      `Conversation "${expectedId}" must use a supported serviceId.`,
    );
  }

  const modelId = normalizeConversationModelId(
    expectedId,
    input.serviceId,
    input.modelId,
  );

  if (!Array.isArray(input.messages)) {
    throw createStateError(
      `Conversation "${expectedId}" must include a messages array.`,
    );
  }

  return {
    branchAnchor:
      input.branchAnchor === null || input.branchAnchor === undefined
        ? null
        : normalizeBranchAnchor(expectedId, input.branchAnchor),
    createdAt: normalizeTimestamp(
      input.createdAt,
      `Conversation "${expectedId}" createdAt`,
    ),
    id: input.id,
    messages: input.messages.map((message, index) =>
      normalizeMessage(expectedId, index, message),
    ),
    modelId,
    parentId:
      input.parentId === null || input.parentId === undefined
        ? null
        : normalizeId(input.parentId, `Conversation "${expectedId}" parentId`),
    serviceId: input.serviceId,
    title: input.title.trim(),
    updatedAt: normalizeTimestamp(
      input.updatedAt,
      `Conversation "${expectedId}" updatedAt`,
    ),
  };
}

function normalizeConversationModelId(expectedId, serviceId, input) {
  if (input === undefined || input === null || input === "") {
    return getDefaultModelIdForService(serviceId);
  }

  if (typeof input !== "string") {
    throw createStateError(
      `Conversation "${expectedId}" must include a string modelId.`,
    );
  }

  const modelId = input.trim();

  if (!modelId) {
    return getDefaultModelIdForService(serviceId);
  }

  if (!isBackendModelIdForService(serviceId, modelId)) {
    throw createStateError(
      `Conversation "${expectedId}" must use a supported modelId for "${serviceId}".`,
    );
  }

  return modelId;
}

function normalizeMessage(conversationId, index, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw createStateError(
      `Message ${index} in conversation "${conversationId}" must be an object.`,
    );
  }

  if (!VALID_MESSAGE_ROLES.has(input.role)) {
    throw createStateError(
      `Message "${input.id ?? index}" must use a supported role.`,
    );
  }

  if (typeof input.content !== "string" || !input.content.trim()) {
    throw createStateError(
      `Message "${input.id ?? index}" must include non-empty content.`,
    );
  }

  return {
    content: input.content,
    createdAt: normalizeTimestamp(
      input.createdAt,
      `Message "${input.id ?? index}" createdAt`,
    ),
    id: normalizeId(
      input.id,
      `Message ${index} in conversation "${conversationId}" id`,
    ),
    role: input.role,
  };
}

function normalizeBranchAnchor(conversationId, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw createStateError(
      `branchAnchor for conversation "${conversationId}" must be an object.`,
    );
  }

  const startOffset = normalizeInteger(
    input.startOffset,
    `branchAnchor for "${conversationId}" startOffset`,
  );
  const endOffset = normalizeInteger(
    input.endOffset,
    `branchAnchor for "${conversationId}" endOffset`,
  );

  if (endOffset <= startOffset) {
    throw createStateError(
      `branchAnchor for "${conversationId}" must have endOffset greater than startOffset.`,
    );
  }

  if (typeof input.quote !== "string" || !input.quote.trim()) {
    throw createStateError(
      `branchAnchor for "${conversationId}" must include a quote.`,
    );
  }

  if (typeof input.prompt !== "string" || !input.prompt.trim()) {
    throw createStateError(
      `branchAnchor for "${conversationId}" must include a prompt.`,
    );
  }

  return {
    createdAt: normalizeTimestamp(
      input.createdAt,
      `branchAnchor for "${conversationId}" createdAt`,
    ),
    endOffset,
    id: normalizeId(input.id, `branchAnchor for "${conversationId}" id`),
    prompt: input.prompt.trim(),
    quote: input.quote,
    sourceConversationId: normalizeId(
      input.sourceConversationId,
      `branchAnchor for "${conversationId}" sourceConversationId`,
    ),
    sourceMessageId: normalizeId(
      input.sourceMessageId,
      `branchAnchor for "${conversationId}" sourceMessageId`,
    ),
    startOffset,
  };
}

function normalizeId(value, label) {
  if (typeof value !== "string" || !value) {
    throw createStateError(`${label} must be a non-empty string.`);
  }

  return value;
}

function normalizeInteger(value, label) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw createStateError(`${label} must be a non-negative integer.`);
  }

  return parsed;
}

function normalizeTimestamp(value, label) {
  if (typeof value !== "string" || !value) {
    throw createStateError(`${label} must be an ISO timestamp string.`);
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw createStateError(`${label} must be a valid timestamp.`);
  }

  return parsed.toISOString();
}
