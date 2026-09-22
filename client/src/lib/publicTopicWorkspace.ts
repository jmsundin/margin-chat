import { normalizePublicTopicId, normalizePublicTopicSource } from "@margin-chat/workspace-contracts";
import { createStandaloneNoteConversation } from "../initialState";
import type { AppState, Conversation, PublicTopicSource } from "../types";
import { addRootConversation } from "./workspaceCommands";

type TopicIdentity = Pick<PublicTopicSource, "id"> & Partial<Pick<PublicTopicSource, "aliases">>;

export function findSavedPublicTopic(
  conversations: Record<string, Conversation>,
  topicOrId: TopicIdentity | string,
): Conversation | null {
  const topic = typeof topicOrId === "string" ? { id: topicOrId } : topicOrId;
  const ids = new Set([topic.id, ...(topic.aliases ?? [])].map(normalizePublicTopicId).filter(Boolean));
  if (!ids.size) return null;
  const saved = Object.values(conversations).filter((conversation) => conversation.publicTopic);
  // Prefer the canonical identity if older imported records contain duplicates.
  const canonicalId = normalizePublicTopicId(topic.id);
  return (canonicalId ? saved.find((conversation) => normalizePublicTopicId(conversation.publicTopic!.id) === canonicalId) : null)
    ?? saved.find((conversation) => [conversation.publicTopic!.id, ...(conversation.publicTopic!.aliases ?? [])]
      .some((id) => ids.has(normalizePublicTopicId(id))))
    ?? null;
}

/** Saves public provenance separately from an empty personal note; never changes navigation. */
export function savePublicTopic(state: AppState, topic: PublicTopicSource): {
  state: AppState;
  conversationId: string;
  created: boolean;
} {
  const publicTopic = normalizePublicTopicSource(topic);
  if (!publicTopic) throw new Error("The public topic has no valid source identity.");
  const existing = findSavedPublicTopic(state.conversations, publicTopic);
  if (existing) {
    const previous = normalizePublicTopicSource(existing.publicTopic)!;
    const updated = normalizePublicTopicSource({
      ...(previous.id === publicTopic.id ? previous : publicTopic),
      aliases: [...previous.aliases, previous.id, ...publicTopic.aliases],
    })!;
    const changed = updated.id !== previous.id || updated.aliases.length !== previous.aliases.length
      || updated.aliases.some((alias, index) => alias !== previous.aliases[index]);
    return {
      state: changed ? { ...state, conversations: { ...state.conversations, [existing.id]: { ...existing, publicTopic: updated } } } : state,
      conversationId: existing.id,
      created: false,
    };
  }

  // Deterministic identities make repeated evaluation of the same update safe.
  const baseId = `public-topic-${publicTopic.id}`;
  const noteIds = new Set(Object.values(state.conversations).flatMap((conversation) => (conversation.notes ?? []).map((note) => note.id)));
  let id = baseId;
  for (let suffix = 2; state.conversations[id] || noteIds.has(`${id}-note`); suffix += 1) id = `${baseId}-${suffix}`;
  const conversation = createStandaloneNoteConversation({
    id,
    noteId: `${id}-note`,
    createdAt: publicTopic.retrievedAt,
    modelId: state.defaultModelId,
    serviceId: state.defaultServiceId,
  });
  conversation.title = publicTopic.label;
  conversation.publicTopic = publicTopic;
  const next = addRootConversation(state, conversation);
  return {
    state: { ...next, activeConversationId: state.activeConversationId, rootId: state.rootId },
    conversationId: id,
    created: true,
  };
}
