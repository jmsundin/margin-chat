import {
  getDefaultModelIdForService,
  isBackendModelIdForService,
} from "../lib/backendModels.mjs";
import { getWorkspaceSessionId, VALID_SERVICE_IDS } from "./constants.mjs";
import { createStateError } from "./errors.mjs";
import { createStatusError } from "../lib/errors.mjs";
import { deleteDocument, restoreVaultAttachment } from "./documentRepository.mjs";

const WORKSPACE_ENTITY_ID_SEPARATOR = "::";

export function toWorkspaceEntityId(sessionId, entityId) {
  return `${sessionId}${WORKSPACE_ENTITY_ID_SEPARATOR}${entityId}`;
}

export function fromWorkspaceEntityId(sessionId, storedEntityId) {
  const prefix = `${sessionId}${WORKSPACE_ENTITY_ID_SEPARATOR}`;
  return typeof storedEntityId === "string" && storedEntityId.startsWith(prefix)
    ? storedEntityId.slice(prefix.length)
    : storedEntityId;
}

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
        graph_layouts,
        conversation_groups
      from marginchat_app_sessions
      where user_id = $1
    `,
    [userId],
  );

  if (!sessionResult.rowCount) {
    return null;
  }

  const session = sessionResult.rows[0];
  const fromStorageId = (entityId) =>
    fromWorkspaceEntityId(session.id, entityId);
  const conversationResult = await client.query(
    `
      select
        id,
        title,
        conversation_kind,
        parent_id,
        model_id,
        service_id,
        created_at,
        updated_at
      from marginchat_conversations
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
      from marginchat_messages
      where conversation_id = any($1::text[])
      order by created_at asc, id asc
    `,
    [conversationIds],
  );
  const documentResult = await client.query(
    `
      select
        cd.conversation_id,
        d.id,
        d.filename,
        d.mime_type,
        d.size_bytes,
        d.status,
        d.error_message,
        d.created_at
      from marginchat_conversation_documents cd
      join marginchat_documents d on d.id = cd.document_id
      where cd.conversation_id = any($1::text[])
        and d.user_id = $2
      order by cd.attached_at asc, d.id asc
    `,
    [conversationIds, userId],
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
      from marginchat_branch_anchors
      where conversation_id = any($1::text[])
    `,
    [conversationIds],
  );
  const noteResult = await client.query(
    `
      select
        id,
        conversation_id,
        source_message_id,
        content,
        note_kind,
        start_offset,
        end_offset,
        quote,
        created_at,
        updated_at
      from marginchat_conversation_notes
      where conversation_id = any($1::text[])
      order by created_at asc, id asc
    `,
    [conversationIds],
  );

  const conversations = {};

  for (const row of conversationResult.rows) {
    const conversationId = fromStorageId(row.id);
    conversations[conversationId] = {
      branchAnchor: null,
      childIds: [],
      createdAt: toIsoString(row.created_at),
      id: conversationId,
      kind: row.conversation_kind,
      documents: [],
      messages: [],
      notes: [],
      modelId: row.model_id,
      parentId: row.parent_id ? fromStorageId(row.parent_id) : null,
      serviceId: row.service_id,
      title: row.title,
      updatedAt: toIsoString(row.updated_at),
    };
  }

  for (const row of messageResult.rows) {
    const conversation = conversations[fromStorageId(row.conversation_id)];

    if (!conversation) {
      continue;
    }

    conversation.messages.push({
      content: row.content,
      createdAt: toIsoString(row.created_at),
      id: fromStorageId(row.id),
      role: row.role,
    });
  }

  for (const row of documentResult.rows) {
    const conversation = conversations[fromStorageId(row.conversation_id)];

    if (!conversation) {
      continue;
    }

    conversation.documents.push({
      createdAt: toIsoString(row.created_at),
      error: row.error_message ?? null,
      filename: row.filename,
      id: row.id,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
      status: row.status,
    });
  }

  for (const row of anchorResult.rows) {
    const conversation = conversations[fromStorageId(row.conversation_id)];

    if (!conversation) {
      continue;
    }

    conversation.branchAnchor = {
      createdAt: toIsoString(row.created_at),
      endOffset: row.end_offset,
      id: fromStorageId(row.id),
      prompt: row.prompt,
      quote: row.quote,
      sourceConversationId: fromStorageId(row.source_conversation_id),
      sourceMessageId: fromStorageId(row.source_message_id),
      startOffset: row.start_offset,
    };
  }

  for (const row of noteResult.rows) {
    const conversation = conversations[fromStorageId(row.conversation_id)];

    if (!conversation) {
      continue;
    }

    conversation.notes.push({
      content: row.content,
      createdAt: toIsoString(row.created_at),
      endOffset: row.end_offset,
      id: fromStorageId(row.id),
      kind: row.note_kind,
      quote: row.quote,
      sourceMessageId: row.source_message_id
        ? fromStorageId(row.source_message_id)
        : null,
      startOffset: row.start_offset,
      updatedAt: toIsoString(row.updated_at),
    });
  }

  for (const row of conversationResult.rows) {
    const conversationId = fromStorageId(row.id);
    const parentId = row.parent_id ? fromStorageId(row.parent_id) : null;
    if (parentId && conversations[parentId]) {
      conversations[parentId].childIds.push(conversationId);
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
    groups:
      session.conversation_groups &&
      typeof session.conversation_groups === "object" &&
      !Array.isArray(session.conversation_groups)
        ? session.conversation_groups
        : {},
    pinnedThreadIds: (session.pinned_thread_ids ?? []).filter(
      (conversationId) => conversations[conversationId]?.parentId === null,
    ),
    railOpen: Boolean(session.rail_open),
    rootId: rootConversationId,
  };
}

export async function readWorkspace(client, userId) {
  const state = await readState(client, userId);
  if (!state) return null;

  const revisionResult = await client.query(
    `
      select revision
      from marginchat_app_sessions
      where user_id = $1
    `,
    [userId],
  );

  return {
    revision: Number(revisionResult.rows[0]?.revision ?? 0),
    state,
  };
}

export async function writeState(
  client,
  userId,
  normalizedState,
  {
    expectedRevision = null,
    vaultRevision = null,
    forceVaultProjection = false,
    vaultAttachments = [],
    deletedVaultAttachmentIds = [],
  } = {},
) {
  if (
    vaultRevision !== null &&
    (!Number.isSafeInteger(vaultRevision) || vaultRevision < 0)
  ) {
    throw createStateError("Vault revision must be a non-negative safe integer.");
  }
  const requestedSessionId = getWorkspaceSessionId(userId);

  await client.query("begin");

  try {
    if (vaultRevision !== null) {
      // The lock covers both checking the marker and rebuilding the projection.
      // Its transaction lifetime also prevents a failed rebuild publishing a marker.
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`marginchat-vault-projection:${userId}`],
      );
      const projectionResult = await client.query(
        "select vault_revision from marginchat_vault_projections where user_id = $1",
        [userId],
      );
      const indexedRevision = projectionResult.rowCount
        ? Number(projectionResult.rows[0].vault_revision)
        : -1;
      if (indexedRevision > vaultRevision || (indexedRevision === vaultRevision && !forceVaultProjection)) {
        await client.query("commit");
        return { projected: false, vaultRevision: indexedRevision };
      }
      for (const documentId of deletedVaultAttachmentIds) {
        await deleteDocument(client, { userId, documentId });
      }
      for (const { attachment, bytes } of vaultAttachments) {
        await restoreVaultAttachment(client, { userId, attachment, bytes });
      }
      if (normalizedState === null) {
        // An intentionally empty vault has no synthetic conversation. Removing
        // the session clears its dependent content indexes through foreign keys.
        await client.query("delete from marginchat_app_sessions where user_id = $1", [userId]);
        await client.query(
          `insert into marginchat_vault_projections (user_id, vault_revision)
           values ($1, $2)
           on conflict (user_id) do update set
             vault_revision = excluded.vault_revision,
             projected_at = now()`,
          [userId, vaultRevision],
        );
        await client.query("commit");
        return { projected: true, vaultRevision };
      }
    }
    const sessionResult = await client.query(
      `
        select id, revision
        from marginchat_app_sessions
        where user_id = $1 or id = $2
        order by (user_id = $1) desc
        limit 1
        for update
      `,
      [userId, requestedSessionId],
    );
    const currentRevision = Number(sessionResult.rows[0]?.revision ?? 0);

    if (
      expectedRevision !== null &&
      Number(expectedRevision) !== currentRevision
    ) {
      throw createStatusError(
        409,
        `Cloud workspace revision changed from ${expectedRevision} to ${currentRevision}.`,
      );
    }

    const sessionId = sessionResult.rows[0]?.id ?? requestedSessionId;
    const nextRevision = currentRevision + 1;
    const toStorageId = (entityId) => toWorkspaceEntityId(sessionId, entityId);

    await client.query(
      `
        insert into marginchat_app_sessions (
          id,
          user_id,
          default_service_id,
          default_model_id,
          rail_open,
          pinned_thread_ids,
          graph_layouts,
          conversation_groups,
          active_conversation_id,
          root_conversation_id,
          revision
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        on conflict (id) do update set
          user_id = excluded.user_id,
          default_service_id = excluded.default_service_id,
          default_model_id = excluded.default_model_id,
          rail_open = excluded.rail_open,
          pinned_thread_ids = excluded.pinned_thread_ids,
          graph_layouts = excluded.graph_layouts,
          conversation_groups = excluded.conversation_groups,
          active_conversation_id = excluded.active_conversation_id,
          root_conversation_id = excluded.root_conversation_id,
          revision = excluded.revision,
          updated_at = now()
      `,
      [
        sessionId,
        userId,
        normalizedState.defaultServiceId,
        normalizedState.defaultModelId,
        normalizedState.railOpen,
        normalizedState.pinnedThreadIds,
        normalizedState.graphLayouts,
        normalizedState.groups,
        normalizedState.activeConversationId,
        normalizedState.rootId,
        nextRevision,
      ],
    );

    const orderedConversations = orderConversationsForInsert(
      normalizedState.conversations,
    );

    for (const conversation of orderedConversations) {
      await client.query(
        `
          insert into marginchat_conversations (
            id,
            session_id,
            title,
            conversation_kind,
            parent_id,
            model_id,
            service_id,
            created_at,
            updated_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          on conflict (id) do update set
            session_id = excluded.session_id,
            title = excluded.title,
            conversation_kind = excluded.conversation_kind,
            parent_id = excluded.parent_id,
            model_id = excluded.model_id,
            service_id = excluded.service_id,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at
        `,
        [
          toStorageId(conversation.id),
          sessionId,
          conversation.title,
          conversation.kind,
          conversation.parentId ? toStorageId(conversation.parentId) : null,
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
            insert into marginchat_messages (
              id,
              conversation_id,
              role,
              content,
              created_at
            )
            values ($1, $2, $3, $4, $5)
            on conflict (id) do update set
              conversation_id = excluded.conversation_id,
              role = excluded.role,
              content = excluded.content,
              created_at = excluded.created_at
          `,
          [
            toStorageId(message.id),
            toStorageId(conversation.id),
            message.role,
            message.content,
            message.createdAt,
          ],
        );
      }
    }

    for (const conversation of orderedConversations) {
      for (const document of conversation.documents ?? []) {
        const result = await client.query(
          `
            insert into marginchat_conversation_documents (
              conversation_id,
              document_id,
              attached_at
            )
            select $1, id, $4
            from marginchat_documents
            where id = $2 and user_id = $3
            on conflict (conversation_id, document_id) do update set
              attached_at = excluded.attached_at
          `,
          [toStorageId(conversation.id), document.id, userId, document.createdAt],
        );

        if (!result.rowCount) {
          throw createStateError(
            `Document "${document.id}" is unavailable for this workspace.`,
          );
        }
      }
    }

    for (const conversation of orderedConversations) {
      for (const note of conversation.notes ?? []) {
        await client.query(
          `
            insert into marginchat_conversation_notes (
              id,
              conversation_id,
              source_message_id,
              content,
              note_kind,
              start_offset,
              end_offset,
              quote,
              created_at,
              updated_at
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            on conflict (id) do update set
              conversation_id = excluded.conversation_id,
              source_message_id = excluded.source_message_id,
              content = excluded.content,
              note_kind = excluded.note_kind,
              start_offset = excluded.start_offset,
              end_offset = excluded.end_offset,
              quote = excluded.quote,
              created_at = excluded.created_at,
              updated_at = excluded.updated_at
          `,
          [
            toStorageId(note.id),
            toStorageId(conversation.id),
            note.sourceMessageId ? toStorageId(note.sourceMessageId) : null,
            note.content,
            note.kind,
            note.startOffset,
            note.endOffset,
            note.quote,
            note.createdAt,
            note.updatedAt,
          ],
        );
      }
    }

    const anchorIds = orderedConversations.flatMap((conversation) =>
      conversation.branchAnchor
        ? [toStorageId(conversation.branchAnchor.id)]
        : [],
    );
    await client.query(
      `
        delete from marginchat_branch_anchors
        where conversation_id in (
          select id from marginchat_conversations where session_id = $1
        )
          and not (id = any($2::text[]))
      `,
      [sessionId, anchorIds],
    );

    for (const conversation of orderedConversations) {
      if (!conversation.branchAnchor) {
        continue;
      }

      await client.query(
        `
          insert into marginchat_branch_anchors (
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
          on conflict (id) do update set
            conversation_id = excluded.conversation_id,
            source_conversation_id = excluded.source_conversation_id,
            source_message_id = excluded.source_message_id,
            start_offset = excluded.start_offset,
            end_offset = excluded.end_offset,
            quote = excluded.quote,
            prompt = excluded.prompt,
            created_at = excluded.created_at
        `,
        [
          toStorageId(conversation.branchAnchor.id),
          toStorageId(conversation.id),
          toStorageId(conversation.branchAnchor.sourceConversationId),
          toStorageId(conversation.branchAnchor.sourceMessageId),
          conversation.branchAnchor.startOffset,
          conversation.branchAnchor.endOffset,
          conversation.branchAnchor.quote,
          conversation.branchAnchor.prompt,
          conversation.branchAnchor.createdAt,
        ],
      );
    }

    const conversationIds = orderedConversations.map((conversation) =>
      toStorageId(conversation.id),
    );
    const messageIds = orderedConversations.flatMap((conversation) =>
      conversation.messages.map((message) => toStorageId(message.id)),
    );
    const noteIds = orderedConversations.flatMap((conversation) =>
      (conversation.notes ?? []).map((note) => toStorageId(note.id)),
    );
    await client.query(
      `
        delete from marginchat_conversation_notes
        where conversation_id in (
          select id from marginchat_conversations where session_id = $1
        )
          and not (id = any($2::text[]))
      `,
      [sessionId, noteIds],
    );

    for (const conversation of orderedConversations) {
      const documentIds = (conversation.documents ?? []).map(
        (document) => document.id,
      );
      await client.query(
        `
          delete from marginchat_conversation_documents
          where conversation_id = $1
            and not (document_id = any($2::text[]))
        `,
        [toStorageId(conversation.id), documentIds],
      );
    }

    await client.query(
      `
        delete from marginchat_messages
        where conversation_id in (
          select id from marginchat_conversations where session_id = $1
        )
          and not (id = any($2::text[]))
      `,
      [sessionId, messageIds],
    );
    await client.query(
      `
        delete from marginchat_conversations
        where session_id = $1
          and not (id = any($2::text[]))
      `,
      [sessionId, conversationIds],
    );

    if (vaultRevision !== null) {
      await client.query(
        `insert into marginchat_vault_projections (user_id, vault_revision)
         values ($1, $2)
         on conflict (user_id) do update set
           vault_revision = excluded.vault_revision,
           projected_at = now()`,
        [userId, vaultRevision],
      );
    }
    await client.query("commit");
    return vaultRevision === null
      ? nextRevision
      : { projected: true, vaultRevision };
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
