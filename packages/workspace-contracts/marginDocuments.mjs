/** A small document is still a normal conversation with authored document blocks. */
export function createMarginDocument(parent, note, documentId = note.id, { legacy = false } = {}) {
  const createdAt = Number.isFinite(Date.parse(note.createdAt)) ? note.createdAt : parent.createdAt;
  const updatedAt = Number.isFinite(Date.parse(note.updatedAt)) ? note.updatedAt : createdAt;
  const source = { sourceMessageId: note.sourceMessageId ?? null,
    ...(note.sourceBlockId ? { sourceBlockId: note.sourceBlockId } : {}),
    startOffset: note.startOffset ?? null, endOffset: note.endOffset ?? null, quote: note.quote ?? null };
  const sourceMessageId = source.sourceMessageId ?? (source.sourceBlockId ? `document:${source.sourceBlockId}` : null);
  const hasSource = sourceMessageId && ((parent.messages ?? []).some((message) => message.id === sourceMessageId)
    || parent.document?.blocks.some((block) => block.id === source.sourceBlockId && sourceMessageId === `document:${block.id}`)
    // A passage on a page of a PDF, or an area of an image, the parent shows.
    || (parent.vaultFile && sourceMessageId.startsWith("file:")));
  const anchored = hasSource && source.quote?.trim() && Number.isSafeInteger(source.startOffset)
    && source.startOffset >= 0 && Number.isSafeInteger(source.endOffset) && source.endOffset > source.startOffset;
  return {
    id: documentId, kind: "chat", title: note.content.replace(/[#*_>`~]/g, " ").trim().split(/\r?\n/)[0]?.slice(0, 72) || "Untitled margin note",
    parentId: parent.id, childIds: [], serviceId: parent.serviceId, modelId: parent.modelId,
    ...(parent.ai ? { ai: structuredClone(parent.ai) } : {}),
    createdAt, updatedAt, messages: [], documents: [], notes: [],
    branchAnchor: anchored ? { id: `anchor:${documentId}`, sourceConversationId: parent.id,
      ...source, sourceMessageId, prompt: "Margin note", createdAt } : null,
    document: { schemaVersion: 1, marginNote: { display: "compact", ...(legacy ? { legacyNoteId: note.id } : {}), source },
      blocks: [{ id: `note:${documentId}`, kind: "markdown", content: note.content,
        createdAt, updatedAt, authorship: "user" }], prompts: [], generations: [] },
  };
}

/** Deterministic, non-mutating migration. Reopening a legacy vault never changes identities. */
export function migrateMarginNotes(conversations) {
  let result = conversations;
  for (const original of Object.values(conversations)) {
    const notes = (original.notes ?? []).filter((note) => note.kind !== "standalone");
    if (!notes.length) continue;
    if (result === conversations) result = Object.assign(Object.create(null), conversations);
    const parent = { ...result[original.id], notes: (original.notes ?? []).filter((note) => note.kind === "standalone"), childIds: [...(original.childIds ?? [])] };
    result[original.id] = parent;
    for (const note of notes) {
      let documentId = note.id;
      // Notes and documents historically had separate ID namespaces. Never overwrite a document.
      for (let suffix = 1; Object.hasOwn(result, documentId); suffix++) {
        const existing = result[documentId];
        if (existing.parentId === parent.id && existing.document?.marginNote?.legacyNoteId === note.id) break;
        documentId = `${note.id.slice(0, 220)}:margin:${suffix}`;
      }
      if (!Object.hasOwn(result, documentId)) result[documentId] = createMarginDocument(parent, note, documentId, { legacy: true });
      if (!parent.childIds.includes(documentId)) parent.childIds.push(documentId);
    }
  }
  return result;
}

/**
 * A margin note that outgrew the margin, as a side document: same id, text and children,
 * minus the margin-note flag. A note on a passage keeps that passage as its anchor.
 */
export function marginNoteToSideDocument(conversation, updatedAt = new Date().toISOString()) {
  if (!conversation?.document?.marginNote) return conversation;
  const { marginNote: _marginNote, ...document } = conversation.document;
  return { ...conversation, updatedAt, document,
    branchAnchor: conversation.branchAnchor ? { ...conversation.branchAnchor, prompt: "Side document" } : conversation.branchAnchor ?? null };
}

export function isCompactDocument(conversation) {
  return conversation?.document?.marginNote?.display === "compact";
}
