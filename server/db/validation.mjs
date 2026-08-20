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
  const normalizedGraphLayouts = normalizeGraphLayouts(
    input.graphLayouts,
    conversationsById,
  );
  const normalizedGroups = normalizeConversationGroups(
    input.groups,
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
  const noteIds = new Set();

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

    for (const message of conversation.messages) {
      if (messageIds.has(message.id)) {
        throw createStateError(`Duplicate message id "${message.id}".`);
      }

      messageIds.add(message.id);
    }

    const conversationMessageIds = new Set(
      conversation.messages.map((message) => message.id),
    );

    for (const note of conversation.notes) {
      if (noteIds.has(note.id)) {
        throw createStateError(`Duplicate note id "${note.id}".`);
      }

      if (note.sourceMessageId && !conversationMessageIds.has(note.sourceMessageId)) {
        throw createStateError(
          `Note "${note.id}" must reference a message in its conversation.`,
        );
      }

      noteIds.add(note.id);
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
    graphLayouts: normalizedGraphLayouts,
    groups: normalizedGroups,
    pinnedThreadIds: normalizedPinnedThreadIds,
    railOpen: input.railOpen,
    rootId: input.rootId,
  };
}

function normalizeConversationGroups(input, conversationsById) {
  if (input === undefined || input === null) {
    return {};
  }

  if (typeof input !== "object" || Array.isArray(input)) {
    throw createStateError("groups must be a keyed object.");
  }

  const assignedConversationIds = new Set();

  return Object.fromEntries(
    Object.entries(input).map(([groupId, group]) => {
      if (!group || typeof group !== "object" || Array.isArray(group)) {
        throw createStateError(`Group "${groupId}" must be an object.`);
      }

      if (group.id !== groupId) {
        throw createStateError(`Group "${groupId}" must include a matching id.`);
      }

      if (typeof group.name !== "string" || !group.name.trim()) {
        throw createStateError(`Group "${groupId}" must include a name.`);
      }

      if (
        typeof group.color !== "string" ||
        !/^#[0-9a-f]{6}$/i.test(group.color)
      ) {
        throw createStateError(`Group "${groupId}" must include a hex color.`);
      }

      if (group.collapsed !== undefined && typeof group.collapsed !== "boolean") {
        throw createStateError(`Group "${groupId}" collapsed must be a boolean.`);
      }

      if (!Array.isArray(group.conversationIds)) {
        throw createStateError(
          `Group "${groupId}" must include a conversationIds array.`,
        );
      }

      const conversationIds = group.conversationIds.map(
        (conversationId, conversationIndex) => {
          const normalizedId = normalizeId(
            conversationId,
            `groups["${groupId}"].conversationIds[${conversationIndex}]`,
          );

          if (!conversationsById[normalizedId]) {
            throw createStateError(
              `Group "${groupId}" references a missing conversation.`,
            );
          }

          if (assignedConversationIds.has(normalizedId)) {
            throw createStateError(
              `Conversation "${normalizedId}" can belong to only one group.`,
            );
          }

          assignedConversationIds.add(normalizedId);
          return normalizedId;
        },
      );

      return [
        groupId,
        {
          collapsed: Boolean(group.collapsed),
          color: group.color.toLowerCase(),
          conversationIds,
          id: groupId,
          name: group.name.trim(),
        },
      ];
    }),
  );
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

function normalizeGraphLayouts(input, conversationsById) {
  if (input === undefined || input === null) {
    return {};
  }

  if (typeof input !== "object" || Array.isArray(input)) {
    throw createStateError("graphLayouts must be a keyed object.");
  }

  return Object.fromEntries(
    Object.entries(input)
      .filter(([conversationId]) => Boolean(conversationsById[conversationId]))
      .map(([conversationId, layout]) => [
        conversationId,
        normalizeGraphLayout(conversationId, layout),
      ]),
  );
}

function normalizeGraphLayout(conversationId, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw createStateError(
      `graphLayouts["${conversationId}"] must be an object.`,
    );
  }

  if (
    input.positioned !== undefined &&
    typeof input.positioned !== "boolean"
  ) {
    throw createStateError(
      `graphLayouts["${conversationId}"].positioned must be a boolean.`,
    );
  }

  for (const coordinateName of ["treeOriginX", "treeOriginY"]) {
    if (input[coordinateName] !== undefined) {
      normalizeSignedInteger(
        input[coordinateName],
        `graphLayouts["${conversationId}"].${coordinateName}`,
      );
    }
  }

  return {
    height: normalizeGraphDimension(
      input.height,
      `graphLayouts["${conversationId}"].height`,
      320,
      1200,
    ),
    width: normalizeGraphDimension(
      input.width,
      `graphLayouts["${conversationId}"].width`,
      360,
      960,
    ),
    x: normalizeSignedInteger(input.x, `graphLayouts["${conversationId}"].x`),
    y: normalizeSignedInteger(input.y, `graphLayouts["${conversationId}"].y`),
    positioned: Boolean(input.positioned),
    treeOriginX:
      input.treeOriginX === undefined
        ? undefined
        : normalizeSignedInteger(
            input.treeOriginX,
            `graphLayouts["${conversationId}"].treeOriginX`,
          ),
    treeOriginY:
      input.treeOriginY === undefined
        ? undefined
        : normalizeSignedInteger(
            input.treeOriginY,
            `graphLayouts["${conversationId}"].treeOriginY`,
          ),
  };
}

function normalizeGraphDimension(value, label, minimum, maximum) {
  const parsed = normalizeInteger(value, label);

  if (parsed < minimum || parsed > maximum) {
    throw createStateError(
      `${label} must be between ${minimum} and ${maximum}.`,
    );
  }

  return parsed;
}

function normalizeSignedInteger(value, label) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    throw createStateError(`${label} must be an integer.`);
  }

  return parsed;
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
    kind:
      input.kind === undefined || input.kind === null
        ? "chat"
        : input.kind === "chat" || input.kind === "note"
          ? input.kind
          : (() => {
              throw createStateError(
                `Conversation "${expectedId}" must use a supported kind.`,
              );
            })(),
    messages: input.messages.map((message, index) =>
      normalizeMessage(expectedId, index, message),
    ),
    documents:
      input.documents === undefined
        ? []
        : normalizeDocuments(expectedId, input.documents),
    notes:
      input.notes === undefined
        ? []
        : normalizeNotes(expectedId, input.notes),
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

function normalizeDocuments(conversationId, input) {
  if (!Array.isArray(input)) {
    throw createStateError(
      `Conversation "${conversationId}" documents must be an array.`,
    );
  }

  const seen = new Set();

  return input.map((document, index) => {
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      throw createStateError(
        `Document ${index} in conversation "${conversationId}" must be an object.`,
      );
    }

    const id = normalizeId(
      document.id,
      `Document ${index} in conversation "${conversationId}" id`,
    );

    if (seen.has(id)) {
      throw createStateError(
        `Conversation "${conversationId}" contains duplicate document "${id}".`,
      );
    }

    if (typeof document.filename !== "string" || !document.filename.trim()) {
      throw createStateError(
        `Document "${id}" must include a filename.`,
      );
    }

    seen.add(id);
    return {
      createdAt: normalizeTimestamp(
        document.createdAt,
        `Document "${id}" createdAt`,
      ),
      error:
        typeof document.error === "string" && document.error.trim()
          ? document.error.trim()
          : null,
      filename: document.filename.trim().slice(0, 240),
      id,
      mimeType:
        typeof document.mimeType === "string" && document.mimeType.trim()
          ? document.mimeType.trim().slice(0, 160)
          : "application/octet-stream",
      sizeBytes: normalizeInteger(document.sizeBytes, `Document "${id}" sizeBytes`),
      status:
        document.status === "processing" ||
        document.status === "ready" ||
        document.status === "failed"
          ? document.status
          : "ready",
    };
  });
}

function normalizeNotes(conversationId, input) {
  if (!Array.isArray(input)) {
    throw createStateError(
      `Conversation "${conversationId}" notes must be an array.`,
    );
  }

  return input.map((note, index) => {
    if (!note || typeof note !== "object" || Array.isArray(note)) {
      throw createStateError(
        `Note ${index} in conversation "${conversationId}" must be an object.`,
      );
    }

    if (
      typeof note.content !== "string" ||
      (!note.content.trim() && note.kind !== "standalone")
    ) {
      throw createStateError(
        `Note "${note.id ?? index}" must include non-empty content.`,
      );
    }

    const sourceMessageId =
      note.sourceMessageId === null || note.sourceMessageId === undefined
        ? null
        : normalizeId(note.sourceMessageId, `Note "${note.id ?? index}" sourceMessageId`);
    const hasSelection =
      note.startOffset !== null && note.startOffset !== undefined;
    const startOffset = hasSelection
      ? normalizeInteger(note.startOffset, `Note "${note.id ?? index}" startOffset`)
      : null;
    const endOffset = hasSelection
      ? normalizeInteger(note.endOffset, `Note "${note.id ?? index}" endOffset`)
      : null;
    const quote = hasSelection ? note.quote : null;

    if (hasSelection) {
      if (!sourceMessageId || endOffset <= startOffset) {
        throw createStateError(
          `Note "${note.id ?? index}" must include a valid message selection.`,
        );
      }

      if (typeof quote !== "string" || !quote.trim()) {
        throw createStateError(
          `Note "${note.id ?? index}" must include its selected quote.`,
        );
      }
    }

    return {
      content: note.content,
      createdAt: normalizeTimestamp(
        note.createdAt,
        `Note "${note.id ?? index}" createdAt`,
      ),
      endOffset,
      id: normalizeId(note.id, `Note ${index} in conversation "${conversationId}" id`),
      kind:
        note.kind === undefined || note.kind === null
          ? "comment"
          : note.kind === "comment" ||
              note.kind === "side-chat" ||
              note.kind === "standalone"
            ? note.kind
            : (() => {
                throw createStateError(
                  `Note "${note.id ?? index}" must use a supported kind.`,
                );
              })(),
      quote: hasSelection ? quote : null,
      sourceMessageId,
      startOffset,
      updatedAt: normalizeTimestamp(
        note.updatedAt,
        `Note "${note.id ?? index}" updatedAt`,
      ),
    };
  });
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
