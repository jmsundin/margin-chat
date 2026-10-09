import {
  DOCUMENT_RELATION_TYPES,
  extractMarkdownWikiLinks,
  getDocumentRelationType,
  markdownIdentitySuffix,
  normalizeDocumentRelations,
  type MarkdownWikiLink,
} from "@margin-chat/workspace-contracts";
import type { AppState, Conversation, DocumentRelation, DocumentRelationOrigin, DocumentRelationTypeId } from "../types";

export { DOCUMENT_RELATION_TYPES, getDocumentRelationType };

/**
 * One edge of the document graph beyond the parent/child tree.
 * `relation` edges are saved typed relations; `mention` edges come from wiki
 * links written in a document's text, typed when written as an inline field.
 */
export interface DocumentGraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: DocumentRelationTypeId | null;
  kind: "relation" | "mention";
  directed: boolean;
  origin?: DocumentRelationOrigin;
  weight?: number;
  note?: string;
  /** Where in the source the edge comes from. */
  sourceBlockId?: string;
  sourceMessageId?: string;
  targetBlockId?: string;
}

type TextLink = MarkdownWikiLink & { sourceBlockId?: string; sourceMessageId?: string };
const linkCache = new WeakMap<Conversation, TextLink[]>();

/** Wiki links in every authored part of a document, remembered per immutable conversation. */
function conversationTextLinks(conversation: Conversation): TextLink[] {
  const cached = linkCache.get(conversation);
  if (cached) return cached;
  const links: TextLink[] = [];
  for (const block of conversation.document?.blocks ?? []) {
    for (const link of extractMarkdownWikiLinks(block.content)) links.push({ ...link, sourceBlockId: block.id });
  }
  // Messages superseded by an editable document are history, not the current text.
  if (!conversation.document?.blocks.length) {
    for (const message of conversation.messages) {
      for (const link of extractMarkdownWikiLinks(message.content)) links.push({ ...link, sourceMessageId: message.id });
    }
  }
  for (const note of conversation.notes ?? []) {
    if (note.kind === "standalone") links.push(...extractMarkdownWikiLinks(note.content));
  }
  linkCache.set(conversation, links);
  return links;
}

/**
 * Resolve a wiki link target the way people write it: a Margin Chat filename
 * (`Title — suffix`), a document id, or a unique title. Paths are ignored, so a
 * moved file still resolves.
 */
export function createDocumentLinkResolver(conversations: Record<string, Conversation>) {
  const bySuffix = new Map<string, string>();
  const byTitle = new Map<string, string | null>();
  for (const conversation of Object.values(conversations)) {
    bySuffix.set(markdownIdentitySuffix(conversation.id), conversation.id);
    const title = conversation.title.trim().toLowerCase();
    byTitle.set(title, byTitle.has(title) ? null : conversation.id);
  }
  return (target: string): string | null => {
    const name = target.replace(/\\/g, "/").split("/").at(-1)!.replace(/\.md$/i, "").trim();
    if (Object.hasOwn(conversations, name)) return name;
    const suffix = / — ([0-9a-z]+-[0-9a-z]+)(?: \(\d+\))?$/.exec(name)?.[1];
    if (suffix && bySuffix.has(suffix)) return bySuffix.get(suffix)!;
    return byTitle.get(name.toLowerCase()) ?? null;
  };
}

/** Saved relations and links written in text, deduplicated per pair and type. */
export function getDocumentGraphEdges(conversations: Record<string, Conversation>): DocumentGraphEdge[] {
  const edges = new Map<string, DocumentGraphEdge>();
  const pairs = new Set<string>();
  for (const conversation of Object.values(conversations)) {
    for (const relation of conversation.relations ?? []) {
      const targetId = relation.targetConversationId;
      if (!targetId || targetId === conversation.id || !Object.hasOwn(conversations, targetId)) continue;
      const definition = getDocumentRelationType(relation.type);
      if (!definition) continue;
      const id = JSON.stringify(["relation", relation.type, conversation.id, targetId]);
      edges.set(id, {
        id, sourceId: conversation.id, targetId, type: relation.type, kind: "relation", directed: definition.directed,
        ...(relation.origin ? { origin: relation.origin } : {}),
        ...(relation.weight !== undefined ? { weight: relation.weight } : {}),
        ...(relation.note ? { note: relation.note } : {}),
        ...(relation.sourceBlockId ? { sourceBlockId: relation.sourceBlockId } : {}),
        ...(relation.targetBlockId ? { targetBlockId: relation.targetBlockId } : {}),
      });
      pairs.add(JSON.stringify([conversation.id, targetId, relation.type]));
      pairs.add(JSON.stringify([conversation.id, targetId, null]));
    }
  }
  const linked = new Set<string>();
  for (const conversation of Object.values(conversations)) {
    for (const targetId of conversation.linkedConversationIds ?? []) linked.add([conversation.id, targetId].sort().join("\0"));
    if (conversation.parentId) linked.add([conversation.id, conversation.parentId].sort().join("\0"));
  }
  const resolve = createDocumentLinkResolver(conversations);
  for (const conversation of Object.values(conversations)) {
    for (const link of conversationTextLinks(conversation)) {
      const targetId = resolve(link.target);
      if (!targetId || targetId === conversation.id) continue;
      const type = link.type ?? null;
      // A saved relation, a personal link or the tree already draws this pair.
      if (pairs.has(JSON.stringify([conversation.id, targetId, type]))
        || !type && linked.has([conversation.id, targetId].sort().join("\0"))) continue;
      const id = JSON.stringify(["mention", type, conversation.id, targetId]);
      if (edges.has(id)) continue;
      edges.set(id, {
        id, sourceId: conversation.id, targetId, type, kind: "mention",
        directed: type ? getDocumentRelationType(type)!.directed : true,
        ...(link.sourceBlockId ? { sourceBlockId: link.sourceBlockId } : {}),
        ...(link.sourceMessageId ? { sourceMessageId: link.sourceMessageId } : {}),
        ...(link.blockId ? { targetBlockId: link.blockId } : {}),
      });
    }
  }
  return [...edges.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** The label an edge reads with from its source. */
export function documentGraphEdgeLabel(edge: Pick<DocumentGraphEdge, "type" | "kind">) {
  if (!edge.type) return "Mentions";
  return getDocumentRelationType(edge.type)?.label ?? edge.type;
}

/**
 * Set, change or remove the typed relation from source to target. An untyped
 * personal connection between the pair becomes the typed relation, and
 * `type: null` turns a relation back into an untyped connection.
 */
export function setDocumentRelation(state: AppState, args: {
  sourceId: string; targetId: string; type: DocumentRelationTypeId | null;
  previousType?: DocumentRelationTypeId | null; remove?: boolean; updatedAt: string; origin?: DocumentRelationOrigin;
}): AppState {
  const { sourceId, targetId, type, previousType = null, updatedAt } = args;
  const source = state.conversations[sourceId];
  const target = state.conversations[targetId];
  if (!source || !target || sourceId === targetId) return state;
  const conversations = { ...state.conversations };
  // Converting a connection replaces it; whichever endpoint owns it.
  for (const [ownerId, otherId] of [[sourceId, targetId], [targetId, sourceId]]) {
    const owner = conversations[ownerId];
    if (owner.linkedConversationIds?.includes(otherId)) {
      conversations[ownerId] = { ...owner, linkedConversationIds: owner.linkedConversationIds.filter((id) => id !== otherId), updatedAt };
    }
  }
  const current = conversations[sourceId];
  const existing = current.relations ?? [];
  const kept = existing.filter((relation) => !(relation.targetConversationId === targetId
    && (relation.type === previousType || relation.type === type)));
  const previous = existing.find((relation) => relation.targetConversationId === targetId && relation.type === previousType);
  const relations: DocumentRelation[] = type
    ? [...kept, { ...previous, type, targetConversationId: targetId, origin: args.origin ?? "user",
      createdAt: previous?.createdAt ?? updatedAt }]
    : kept;
  conversations[sourceId] = { ...current, relations: normalizeDocumentRelations(relations, sourceId, conversations) ?? [], updatedAt };
  if (!conversations[sourceId].relations?.length) delete conversations[sourceId].relations;
  if (!type && !args.remove) {
    // An untyped connection is a personal link, owned by the first id.
    const [ownerId, otherId] = [sourceId, targetId].sort();
    const owner = conversations[ownerId];
    conversations[ownerId] = { ...owner, linkedConversationIds: [...(owner.linkedConversationIds ?? []), otherId], updatedAt };
  }
  return { ...state, conversations };
}

/** Restore the connection fields of two documents, for undo. */
export function restoreDocumentConnections(state: AppState, previous: Pick<Conversation, "id" | "relations" | "linkedConversationIds">[], updatedAt: string): AppState {
  const conversations = { ...state.conversations };
  for (const snapshot of previous) {
    const conversation = conversations[snapshot.id];
    if (!conversation) continue;
    const next: Conversation = { ...conversation, updatedAt };
    if (snapshot.relations?.length) next.relations = snapshot.relations; else delete next.relations;
    if (snapshot.linkedConversationIds) next.linkedConversationIds = snapshot.linkedConversationIds; else delete next.linkedConversationIds;
    conversations[snapshot.id] = next;
  }
  return { ...state, conversations };
}
