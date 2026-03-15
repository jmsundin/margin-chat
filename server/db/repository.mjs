import { DEFAULT_SESSION_ID } from "./constants.mjs";
import { createStateError } from "./errors.mjs";

export async function readState(client) {
  const sessionResult = await client.query(
    `
      select
        id,
        root_conversation_id,
        active_conversation_id,
        rail_open,
        pinned_thread_ids
      from app_sessions
      where id = $1
    `,
    [DEFAULT_SESSION_ID],
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
        service_id,
        created_at,
        updated_at
      from conversations
      where session_id = $1
      order by created_at asc, id asc
    `,
    [DEFAULT_SESSION_ID],
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

  return {
    activeConversationId,
    conversations,
    pinnedThreadIds: (session.pinned_thread_ids ?? []).filter(
      (conversationId) => conversations[conversationId]?.parentId === null,
    ),
    railOpen: Boolean(session.rail_open),
    rootId: rootConversationId,
  };
}

export async function writeState(client, normalizedState) {
  await client.query("begin");

  try {
    await client.query("delete from app_sessions where id = $1", [
      DEFAULT_SESSION_ID,
    ]);
    await client.query(
      `
        insert into app_sessions (
          id,
          rail_open,
          pinned_thread_ids
        )
        values ($1, $2, $3)
      `,
      [
        DEFAULT_SESSION_ID,
        normalizedState.railOpen,
        normalizedState.pinnedThreadIds,
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
            service_id,
            created_at,
            updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          conversation.id,
          DEFAULT_SESSION_ID,
          conversation.title,
          conversation.parentId,
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
          active_conversation_id = $2,
          root_conversation_id = $3,
          updated_at = now()
        where id = $1
      `,
      [
        DEFAULT_SESSION_ID,
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
