import {
  getDefaultModelIdForService,
  isBackendModelIdForService,
} from "../lib/backendModels.mjs";
import { getWorkspaceSessionId, VALID_SERVICE_IDS } from "./constants.mjs";
import { createStateError } from "./errors.mjs";

export async function readState(client, userId) {
  const sessionResult = await client.query(
    `
      select
        id,
        user_id,
        root_conversation_id,
        active_conversation_id,
        default_service_id,
        default_model_id,
        rail_open,
        pinned_thread_ids,
        graph_layouts
      from app_sessions
      where user_id = $1
    `,
    [userId],
  );

  if (!sessionResult.rowCount) {
    return null;
  }

  const session = sessionResult.rows[0];
  const conversationResult = await client.query(
    `
      select
        id,
        title,
        parent_id,
        model_id,
        service_id,
        created_at,
        updated_at
      from conversations
      where session_id = $1
      order by created_at asc, id asc
    `,
    [session.id],
  );

  if (!conversationResult.rowCount) {
    return null;
  }

  const conversationIds = conversationResult.rows.map((row) => row.id);
  const messageResult = await client.query(
    `
      select
        id,
        conversation_id,
        role,
        content,
        created_at
      from messages
      where conversation_id = any($1::text[])
      order by created_at asc, id asc
    `,
    [conversationIds],
  );
  const anchorResult = await client.query(
    `
      select
        id,
        conversation_id,
        source_conversation_id,
        source_message_id,
        start_offset,
        end_offset,
        quote,
        prompt,
        created_at
      from branch_anchors
      where conversation_id = any($1::text[])
    `,
    [conversationIds],
  );

  const conversations = {};

  for (const row of conversationResult.rows) {
    conversations[row.id] = {
      branchAnchor: null,
      childIds: [],
      createdAt: toIsoString(row.created_at),
      id: row.id,
      messages: [],
      modelId: row.model_id,
      parentId: row.parent_id,
      serviceId: row.service_id,
      title: row.title,
      updatedAt: toIsoString(row.updated_at),
    };
  }

  for (const row of messageResult.rows) {
    const conversation = conversations[row.conversation_id];

    if (!conversation) {
      continue;
    }

    conversation.messages.push({
      content: row.content,
      createdAt: toIsoString(row.created_at),
      id: row.id,
      role: row.role,
    });
  }

  for (const row of anchorResult.rows) {
    const conversation = conversations[row.conversation_id];

    if (!conversation) {
      continue;
    }

    conversation.branchAnchor = {
      createdAt: toIsoString(row.created_at),
      endOffset: row.end_offset,
      id: row.id,
      prompt: row.prompt,
      quote: row.quote,
      sourceConversationId: row.source_conversation_id,
      sourceMessageId: row.source_message_id,
      startOffset: row.start_offset,
    };
  }

  for (const row of conversationResult.rows) {
    if (row.parent_id && conversations[row.parent_id]) {
      conversations[row.parent_id].childIds.push(row.id);
    }
  }

  const fallbackConversationId =
    session.active_conversation_id ??
    session.root_conversation_id ??
    conversationResult.rows.find((row) => row.parent_id === null)?.id ??
    conversationResult.rows[0]?.id ??
    null;
  const activeConversationId = conversations[fallbackConversationId]
    ? fallbackConversationId
    : conversationResult.rows.find((row) => row.parent_id === null)?.id ??
      conversationResult.rows[0]?.id;
  const rootConversationId =
    getRootConversationId(conversations, activeConversationId) ??
    getRootConversationId(conversations, session.root_conversation_id) ??
    conversationResult.rows.find((row) => row.parent_id === null)?.id ??
    conversationResult.rows[0]?.id;
  const { modelId: defaultModelId, serviceId: defaultServiceId } =
    normalizeDefaultSelection({
      activeConversationId,
      conversations,
      modelId: session.default_model_id,
      rootConversationId,
      serviceId: session.default_service_id,
    });

  return {
    activeConversationId,
    conversations,
    defaultModelId,
    defaultServiceId,
    graphLayouts:
      session.graph_layouts &&
      typeof session.graph_layouts === "object" &&
      !Array.isArray(session.graph_layouts)
        ? Object.fromEntries(
            Object.entries(session.graph_layouts).filter(([conversationId]) =>
              Boolean(conversations[conversationId]),
            ),
          )
        : {},
    pinnedThreadIds: (session.pinned_thread_ids ?? []).filter(
      (conversationId) => conversations[conversationId]?.parentId === null,
    ),
    railOpen: Boolean(session.rail_open),
    rootId: rootConversationId,
  };
}

export async function writeState(client, userId, normalizedState) {
  const sessionId = getWorkspaceSessionId(userId);

  await client.query("begin");

  try {
    await client.query(
      "delete from app_sessions where user_id = $1 or id = $2",
      [userId, sessionId],
    );
    await client.query(
      `
        insert into app_sessions (
          id,
          user_id,
          default_service_id,
          default_model_id,
          rail_open,
          pinned_thread_ids,
          graph_layouts
        )
        values ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        sessionId,
        userId,
        normalizedState.defaultServiceId,
        normalizedState.defaultModelId,
        normalizedState.railOpen,
        normalizedState.pinnedThreadIds,
        normalizedState.graphLayouts,
      ],
    );

    const orderedConversations = orderConversationsForInsert(
      normalizedState.conversations,
    );

    for (const conversation of orderedConversations) {
      await client.query(
        `
          insert into conversations (
            id,
            session_id,
            title,
            parent_id,
            model_id,
            service_id,
            created_at,
            updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          conversation.id,
          sessionId,
          conversation.title,
          conversation.parentId,
          conversation.modelId,
          conversation.serviceId,
          conversation.createdAt,
          conversation.updatedAt,
        ],
      );
    }

    for (const conversation of orderedConversations) {
      for (const message of conversation.messages) {
        await client.query(
          `
            insert into messages (
              id,
              conversation_id,
              role,
              content,
              created_at
            )
            values ($1, $2, $3, $4, $5)
          `,
          [
            message.id,
            conversation.id,
            message.role,
            message.content,
            message.createdAt,
          ],
        );
      }
    }

    for (const conversation of orderedConversations) {
      if (!conversation.branchAnchor) {
        continue;
      }

      await client.query(
        `
          insert into branch_anchors (
            id,
            conversation_id,
            source_conversation_id,
            source_message_id,
            start_offset,
            end_offset,
            quote,
            prompt,
            created_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
        [
          conversation.branchAnchor.id,
          conversation.id,
          conversation.branchAnchor.sourceConversationId,
          conversation.branchAnchor.sourceMessageId,
          conversation.branchAnchor.startOffset,
          conversation.branchAnchor.endOffset,
          conversation.branchAnchor.quote,
          conversation.branchAnchor.prompt,
          conversation.branchAnchor.createdAt,
        ],
      );
    }

    await client.query(
      `
        update app_sessions
        set
          active_conversation_id = $3,
          root_conversation_id = $4,
          updated_at = now()
        where id = $1
          and user_id = $2
      `,
      [
        sessionId,
        userId,
        normalizedState.activeConversationId,
        normalizedState.rootId,
      ],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

function orderConversationsForInsert(conversations) {
  const byId = new Map(
    conversations.map((conversation) => [conversation.id, conversation]),
  );
  const ordered = [];
  const inserted = new Set();

  while (ordered.length < conversations.length) {
    let progressed = false;

    for (const conversation of conversations) {
      if (inserted.has(conversation.id)) {
        continue;
      }

      if (conversation.parentId && !byId.has(conversation.parentId)) {
        throw createStateError(
          `Conversation "${conversation.id}" references a missing parent.`,
        );
      }

      if (conversation.parentId && !inserted.has(conversation.parentId)) {
        continue;
      }

      ordered.push(conversation);
      inserted.add(conversation.id);
      progressed = true;
    }

    if (!progressed) {
      throw createStateError(
        "Conversation graph contains a cycle or an invalid parent reference.",
      );
    }
  }

  return ordered;
}

function toIsoString(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeDefaultSelection({
  activeConversationId,
  conversations,
  modelId,
  rootConversationId,
  serviceId,
}) {
  const fallbackConversation =
    conversations[activeConversationId] ??
    conversations[rootConversationId] ??
    Object.values(conversations).find(
      (conversation) => conversation.parentId === null,
    ) ??
    Object.values(conversations)[0] ??
    null;
  const nextServiceId = VALID_SERVICE_IDS.has(serviceId)
    ? serviceId
    : fallbackConversation?.serviceId ?? "backend-services";
  const fallbackModelId =
    fallbackConversation?.serviceId === nextServiceId
      ? fallbackConversation.modelId
      : getDefaultModelIdForService(nextServiceId);

  return {
    modelId: isBackendModelIdForService(nextServiceId, modelId)
      ? modelId
      : fallbackModelId,
    serviceId: nextServiceId,
  };
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
