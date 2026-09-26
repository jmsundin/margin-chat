import { normalizeEditableDocument, type AppState, type Conversation, type DocumentBlock, type DocumentGeneration, type DocumentLink, type EditableDocument, type Message } from "@margin-chat/workspace-contracts";
import { getEditableDocument, retainDocumentBlockSource } from "./editableDocument";
import { remapDocumentAnchor } from "./documentAnchors";
import { remapDocumentReplacement } from "./documentVersions";
import { remapDocumentLinks } from "./documentLinks";

function isStreamingBlock(document: EditableDocument, id: string): boolean {
  const block = document.blocks.find((candidate) => candidate.id === id);
  return document.generations.some((generation) => generation.status === "streaming"
    && (block?.generationId === generation.id || generation.blockIds.includes(id)));
}

/** Move authored content in one state transition; source history and ancestry remain intact. */
export function transferDocumentBlock(
  state: AppState,
  sourceConversationId: string,
  blockId: string,
  targetConversationId: string,
  beforeBlockId: string | null,
  updatedAt = new Date().toISOString(),
  newId = `block-${crypto.randomUUID()}`,
): AppState {
  if (sourceConversationId === targetConversationId || !Object.hasOwn(state.conversations, sourceConversationId)
    || !Object.hasOwn(state.conversations, targetConversationId) || !Number.isFinite(Date.parse(updatedAt))
    || typeof newId !== "string" || !newId.trim() || newId.length > 1000) return state;
  const source = state.conversations[sourceConversationId];
  const target = state.conversations[targetConversationId];
  const sourceDocument = getEditableDocument(source);
  const targetDocument = getEditableDocument(target);
  if (!normalizeEditableDocument(sourceDocument) || !normalizeEditableDocument(targetDocument)) return state;
  const block = sourceDocument.blocks.find((candidate) => candidate.id === blockId);
  const insertionIndex = beforeBlockId === null ? targetDocument.blocks.length
    : targetDocument.blocks.findIndex((candidate) => candidate.id === beforeBlockId);
  if (!block || insertionIndex < 0 || isStreamingBlock(sourceDocument, block.id)
    || beforeBlockId !== null && isStreamingBlock(targetDocument, beforeBlockId)) return state;

  // Messages are globally unique. Reserve block IDs and their possible future
  // historical snapshot IDs too, so moving/deleting the result remains valid.
  const usedIds = new Set<string>();
  for (const conversation of Object.values(state.conversations)) {
    usedIds.add(conversation.id);
    for (const message of conversation.messages) usedIds.add(message.id);
    for (const note of conversation.notes ?? []) usedIds.add(note.id);
    const document = getEditableDocument(conversation);
    for (const item of document.blocks) { usedIds.add(item.id); usedIds.add(`document:${item.id}`); }
    for (const prompt of document.prompts) usedIds.add(prompt.id);
    for (const link of document.links ?? []) usedIds.add(link.id);
    for (const generation of document.generations) {
      usedIds.add(generation.id);
      for (const previous of generation.previousBlocks ?? []) {
        usedIds.add(previous.id);
        usedIds.add(`document:${previous.id}`);
      }
    }
  }
  if (usedIds.has(newId) || usedIds.has(`document:${newId}`)) return state;
  usedIds.add(newId);
  usedIds.add(`document:${newId}`);
  function freshId(kind: string): string {
    const base = `transfer:${newId.slice(0, 880)}:${kind}`;
    let id = base;
    for (let index = 2; usedIds.has(id); index += 1) id = `${base}:${index}`;
    usedIds.add(id);
    return id;
  }

  const generation = block.generationId
    ? sourceDocument.generations.find((candidate) => candidate.id === block.generationId)
    : sourceDocument.generations.find((candidate) => candidate.blockIds.includes(block.id));
  const prompt = generation && sourceDocument.prompts.find((candidate) => candidate.id === generation.promptId);
  const output = generation && source.messages.find((message) => message.id === generation.messageId && message.role === "assistant");
  const sourceMessage = block.sourceMessageId && source.messages.find((message) => message.id === block.sourceMessageId);
  if (block.generationId && !generation || generation && (!prompt || !output?.content.trim())
    || block.sourceMessageId && !sourceMessage || sourceMessage && sourceMessage.execution?.status === "streaming") return state;

  const copiedMessages: Message[] = [];
  const messageIds = new Map<string, string>();
  function copyMessage(id: string | undefined): string | undefined {
    if (!id) return undefined;
    const existing = messageIds.get(id);
    if (existing) return existing;
    const message = source.messages.find((candidate) => candidate.id === id);
    if (!message?.content.trim()) return undefined;
    const nextId = freshId(`message:${copiedMessages.length + 1}`);
    messageIds.set(id, nextId);
    copiedMessages.push({ ...structuredClone(message), id: nextId });
    return nextId;
  }

  const copiedPrompt = prompt ? { ...structuredClone(prompt), id: freshId("prompt") } : undefined;
  if (copiedPrompt) {
    const sourceMessageId = copyMessage(prompt!.sourceMessageId);
    if (sourceMessageId) copiedPrompt.sourceMessageId = sourceMessageId;
    else delete copiedPrompt.sourceMessageId;
  }
  const copiedGeneration: DocumentGeneration | undefined = generation && copiedPrompt ? {
    id: freshId("generation"), promptId: copiedPrompt.id, messageId: copyMessage(generation.messageId)!,
    createdAt: generation.createdAt, serviceId: generation.serviceId, modelId: generation.modelId,
    ...(generation.ai ? { ai: structuredClone(generation.ai) } : {}), status: generation.status,
    blockIds: [newId], acceptedAt: generation.acceptedAt ?? updatedAt,
    // This insertion owns only the moved block. Source replacements, alternatives
    // and prior versions must never restore unrelated text into the destination.
  } : undefined;
  const copiedSourceMessageId = copyMessage(block.sourceMessageId);
  const moved: DocumentBlock = {
    id: newId, kind: block.kind, content: block.content, createdAt: block.createdAt, updatedAt,
    ...(copiedSourceMessageId ? { sourceMessageId: copiedSourceMessageId } : {}),
    ...(copiedGeneration ? { generationId: copiedGeneration.id } : {}),
  };

  const snapshotId = `document:${block.id}`;
  if (!block.sourceMessageId && block.content.trim() && !source.messages.some((message) => message.id === snapshotId)
    && Object.values(state.conversations).some((conversation) => conversation.id !== source.id
      && conversation.messages.some((message) => message.id === snapshotId))) return state;
  const retained = !block.sourceMessageId && block.content.trim() ? retainDocumentBlockSource(source, block) : source;
  const remainingBlocks = sourceDocument.blocks.filter((candidate) => candidate.id !== block.id);
  let sourceAfter: Conversation = { ...retained, updatedAt, document: {
    ...sourceDocument, blocks: remainingBlocks,
    generations: sourceDocument.generations.map((item) => {
      const remapped = remapDocumentReplacement(item, sourceDocument.blocks, remainingBlocks);
      const blockIds = item.blockIds.filter((id) => id !== block.id);
      return blockIds.length === item.blockIds.length ? remapped : { ...remapped, blockIds };
    }),
  } };
  sourceAfter = remapDocumentLinks(source, sourceAfter);
  sourceAfter.notes = sourceAfter.notes?.map((note) => remapDocumentAnchor(note, source, sourceAfter));
  const copiedLinks: DocumentLink[] = [];
  const sourceId = block.sourceMessageId ?? `document:${block.id}`;
  const precedingSourceLength = sourceDocument.blocks.slice(0, sourceDocument.blocks.indexOf(block))
    .filter((candidate) => candidate.sourceMessageId && candidate.sourceMessageId === block.sourceMessageId)
    .reduce((length, candidate) => length + candidate.content.length, 0);
  for (const link of sourceDocument.links ?? []) {
    if (link.sourceBlockId ? link.sourceBlockId !== block.id : link.sourceMessageId !== sourceId) continue;
    const from = link.startOffset - (link.sourceBlockId ? 0 : precedingSourceLength);
    const to = link.endOffset - (link.sourceBlockId ? 0 : precedingSourceLength);
    if (from < 0 || to > block.content.length || to <= from || block.content.slice(from, to) !== link.quote) continue;
    copiedLinks.push({ ...link, id: freshId("link"), sourceBlockId: newId,
      sourceMessageId: moved.sourceMessageId ?? `document:${newId}`, startOffset: from, endOffset: to });
  }
  const targetBlocks = [...targetDocument.blocks];
  const placeholder = targetBlocks.length === 1 ? targetBlocks[0] : undefined;
  const replacesPlaceholder = placeholder?.content === "" && !placeholder.sourceMessageId && !placeholder.generationId
    && !targetDocument.prompts.length && !targetDocument.generations.length
    && !(target.notes ?? []).some((note) => note.sourceBlockId === placeholder.id || note.sourceMessageId === `document:${placeholder.id}`)
    && !Object.values(state.conversations).some((conversation) => {
      const anchor = conversation.branchAnchor;
      if (anchor?.sourceConversationId === target.id
        && (anchor.sourceBlockId === placeholder.id || anchor.sourceMessageId === `document:${placeholder.id}`)) return true;
      return (getEditableDocument(conversation).links ?? []).some((link) =>
        link.targetConversationId === target.id && link.targetBlockId === placeholder.id
        || conversation.id === target.id && (link.sourceBlockId === placeholder.id || link.sourceMessageId === `document:${placeholder.id}`));
    });
  if (replacesPlaceholder) targetBlocks.splice(0, 1, moved);
  else targetBlocks.splice(insertionIndex, 0, moved);
  const targetAfter: Conversation = { ...target, updatedAt, messages: [...target.messages, ...copiedMessages], document: {
    ...targetDocument, blocks: targetBlocks,
    prompts: copiedPrompt ? [...targetDocument.prompts, copiedPrompt] : targetDocument.prompts,
    generations: copiedGeneration ? [...targetDocument.generations, copiedGeneration] : targetDocument.generations,
    ...(copiedLinks.length ? { links: [...targetDocument.links ?? [], ...copiedLinks] } : {}),
  } };
  const conversations = { ...state.conversations, [source.id]: sourceAfter, [target.id]: targetAfter };
  for (const conversation of Object.values(conversations)) {
    let updated = conversation;
    if (conversation.branchAnchor?.sourceConversationId === source.id) {
      const branchAnchor = remapDocumentAnchor(conversation.branchAnchor, source, sourceAfter);
      if (branchAnchor !== conversation.branchAnchor) updated = { ...updated, branchAnchor };
    }
    if (updated.document?.links?.some((link) => link.targetConversationId === source.id && link.targetBlockId === block.id)) {
      updated = { ...updated, updatedAt, document: { ...updated.document, links: updated.document.links.map((link) =>
        link.targetConversationId === source.id && link.targetBlockId === block.id
          ? { ...link, targetConversationId: target.id, targetBlockId: newId } : link) } };
    }
    if (updated !== conversation) conversations[conversation.id] = updated;
  }
  return { ...state, conversations };
}
