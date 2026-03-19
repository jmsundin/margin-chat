function clipText(value, maxLength = 220) {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "";
  }

  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function buildConversationPreview(conversation) {
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const content = clipText(conversation.messages[index]?.content ?? "", 160);

    if (content) {
      return content;
    }
  }

  return conversation.branchAnchor?.quote
    ? clipText(conversation.branchAnchor.quote, 160)
    : "No messages yet.";
}

function getRootConversationId(conversations, conversationId) {
  if (!conversationId) {
    return null;
  }

  const visited = new Set();
  let current = conversations[conversationId];

  while (current && !visited.has(current.id)) {
    if (current.parentId === null) {
      return current.id;
    }

    visited.add(current.id);
    current = conversations[current.parentId];
  }

  return null;
}

function buildConversationSearchText(conversation) {
  return [
    conversation.title,
    conversation.branchAnchor?.quote ?? "",
    conversation.branchAnchor?.prompt ?? "",
    ...conversation.messages.slice(-8).map((message) => message.content),
  ]
    .join("\n")
    .toLowerCase();
}

function scoreConversationMatch(conversation, normalizedQuery) {
  if (!normalizedQuery) {
    return 0;
  }

  const title = conversation.title.toLowerCase();
  const anchorQuote = conversation.branchAnchor?.quote?.toLowerCase() ?? "";
  const anchorPrompt = conversation.branchAnchor?.prompt?.toLowerCase() ?? "";
  const haystack = buildConversationSearchText(conversation);
  let score = 0;

  if (title.includes(normalizedQuery)) {
    score += 12;
  }

  if (anchorQuote.includes(normalizedQuery) || anchorPrompt.includes(normalizedQuery)) {
    score += 7;
  }

  if (haystack.includes(normalizedQuery)) {
    score += 4;
  }

  for (const token of normalizedQuery.split(/\s+/).filter(Boolean)) {
    if (title.includes(token)) {
      score += 3;
    }

    if (haystack.includes(token)) {
      score += 1;
    }
  }

  return score;
}

function summarizeConversation(conversations, conversation) {
  return {
    conversation_id: conversation.id,
    title: conversation.title,
    parent_id: conversation.parentId,
    root_conversation_id:
      getRootConversationId(conversations, conversation.id) ?? conversation.id,
    updated_at: conversation.updatedAt,
    branch_anchor_quote: conversation.branchAnchor?.quote ?? null,
    message_count: conversation.messages.length,
    preview: buildConversationPreview(conversation),
    service_id: conversation.serviceId,
  };
}

function buildCurrentConversationSnapshot(chatRequest, existingConversation) {
  const firstMessage = chatRequest.messages[0];
  const lastMessage = chatRequest.messages[chatRequest.messages.length - 1];
  const now = new Date().toISOString();

  return {
    branchAnchor:
      chatRequest.conversation.branchAnchor ?? existingConversation?.branchAnchor ?? null,
    childIds: existingConversation?.childIds ?? [],
    createdAt:
      existingConversation?.createdAt ??
      firstMessage?.createdAt ??
      lastMessage?.createdAt ??
      now,
    id: chatRequest.conversation.id,
    messages: chatRequest.messages.map((message) => ({
      content: message.content,
      createdAt: message.createdAt,
      id: message.id,
      role: message.role,
    })),
    modelId: chatRequest.modelId,
    parentId: chatRequest.conversation.parentId,
    serviceId: chatRequest.serviceId,
    title: chatRequest.conversation.title,
    updatedAt: lastMessage?.createdAt ?? existingConversation?.updatedAt ?? now,
  };
}

function mergeWorkspaceState({ chatRequest, persistedState }) {
  const conversations = {
    ...(persistedState?.conversations ?? {}),
  };
  const existingConversation = conversations[chatRequest.conversation.id];
  const currentConversation = buildCurrentConversationSnapshot(
    chatRequest,
    existingConversation,
  );

  conversations[currentConversation.id] = currentConversation;

  if (
    currentConversation.parentId &&
    conversations[currentConversation.parentId] &&
    !conversations[currentConversation.parentId].childIds.includes(currentConversation.id)
  ) {
    conversations[currentConversation.parentId] = {
      ...conversations[currentConversation.parentId],
      childIds: [
        ...conversations[currentConversation.parentId].childIds,
        currentConversation.id,
      ],
      updatedAt: currentConversation.updatedAt,
    };
  }

  const rootId =
    getRootConversationId(conversations, currentConversation.id) ??
    persistedState?.rootId ??
    currentConversation.id;

  return {
    activeConversationId: currentConversation.id,
    conversations,
    defaultModelId: persistedState?.defaultModelId ?? currentConversation.modelId,
    defaultServiceId:
      persistedState?.defaultServiceId ?? currentConversation.serviceId,
    graphLayouts: persistedState?.graphLayouts ?? {},
    pinnedThreadIds: persistedState?.pinnedThreadIds ?? [],
    railOpen: persistedState?.railOpen ?? true,
    rootId,
  };
}

export const OPENAI_AGENT_TOOL_DEFINITIONS = [
  {
    type: "function",
    name: "search_conversations",
    description:
      "Search the current user's saved Margin Chat conversations by title, branch anchor text, and recent message content.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search phrase to match against saved conversations.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_recent_conversations",
    description:
      "List the user's most recently updated conversations when you need to browse the workspace before answering.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "How many conversations to return, between 1 and 10.",
        },
      },
      required: ["limit"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_conversation",
    description:
      "Retrieve a saved conversation, including recent messages, branch anchor details, and child branches.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        conversation_id: {
          type: "string",
          description: "Exact Margin Chat conversation id to inspect.",
        },
      },
      required: ["conversation_id"],
      additionalProperties: false,
    },
  },
];

export function createOpenAIAgentToolExecutor({
  chatRequest,
  database,
  userId,
}) {
  let workspaceStatePromise = null;

  async function getWorkspaceState() {
    if (!workspaceStatePromise) {
      workspaceStatePromise = database
        .loadState(userId)
        .then((persistedState) =>
          mergeWorkspaceState({
            chatRequest,
            persistedState,
          }),
        );
    }

    return workspaceStatePromise;
  }

  async function searchConversations({ query }) {
    const state = await getWorkspaceState();
    const normalizedQuery = String(query ?? "").trim().toLowerCase();
    const conversations = Object.values(state.conversations);

    if (!normalizedQuery) {
      return {
        matches: [],
        query: "",
        total_matches: 0,
      };
    }

    const matches = conversations
      .map((conversation) => ({
        conversation,
        score: scoreConversationMatch(conversation, normalizedQuery),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return right.conversation.updatedAt.localeCompare(left.conversation.updatedAt);
      })
      .slice(0, 6)
      .map((entry) => summarizeConversation(state.conversations, entry.conversation));

    return {
      matches,
      query: normalizedQuery,
      total_matches: matches.length,
    };
  }

  async function listRecentConversations({ limit }) {
    const state = await getWorkspaceState();
    const nextLimit = Math.min(10, Math.max(1, Number(limit) || 5));
    const conversations = Object.values(state.conversations)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, nextLimit)
      .map((conversation) => summarizeConversation(state.conversations, conversation));

    return {
      conversations,
      total_returned: conversations.length,
    };
  }

  async function getConversation({ conversation_id: conversationId }) {
    const state = await getWorkspaceState();
    const conversation = state.conversations[String(conversationId ?? "")];

    if (!conversation) {
      return {
        conversation_id: String(conversationId ?? ""),
        found: false,
      };
    }

    const childConversations = conversation.childIds
      .map((childId) => state.conversations[childId])
      .filter(Boolean)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((childConversation) => ({
        branch_anchor_quote: childConversation.branchAnchor?.quote ?? null,
        conversation_id: childConversation.id,
        title: childConversation.title,
        updated_at: childConversation.updatedAt,
      }));
    const visibleMessages = conversation.messages.slice(-12).map((message) => ({
      content: clipText(message.content, 700),
      created_at: message.createdAt,
      id: message.id,
      role: message.role,
    }));

    return {
      conversation: {
        branch_anchor: conversation.branchAnchor
          ? {
              prompt: conversation.branchAnchor.prompt,
              quote: conversation.branchAnchor.quote,
              source_conversation_id: conversation.branchAnchor.sourceConversationId,
              source_message_id: conversation.branchAnchor.sourceMessageId,
            }
          : null,
        child_conversations: childConversations,
        id: conversation.id,
        message_count: conversation.messages.length,
        messages: visibleMessages,
        model_id: conversation.modelId,
        parent_id: conversation.parentId,
        root_conversation_id:
          getRootConversationId(state.conversations, conversation.id) ?? conversation.id,
        service_id: conversation.serviceId,
        title: conversation.title,
        truncated_message_count: Math.max(0, conversation.messages.length - visibleMessages.length),
        updated_at: conversation.updatedAt,
      },
      found: true,
    };
  }

  return async function executeTool(name, args) {
    try {
      if (name === "search_conversations") {
        return await searchConversations(args);
      }

      if (name === "list_recent_conversations") {
        return await listRecentConversations(args);
      }

      if (name === "get_conversation") {
        return await getConversation(args);
      }

      return {
        error: `Unknown tool "${name}".`,
        ok: false,
      };
    } catch (error) {
      return {
        error:
          error instanceof Error && error.message
            ? error.message
            : "The workspace tool failed unexpectedly.",
        ok: false,
      };
    }
  };
}
