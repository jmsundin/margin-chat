import type { Conversation, DocumentBlock, DocumentGeneration, EditableDocument } from "@margin-chat/workspace-contracts";
import { insertDocumentGeneration, remapDocumentRange } from "./editableDocument";

function familyId(document: EditableDocument, generation: DocumentGeneration): string {
  const visited = new Set<string>();
  let current = generation;
  while (current.alternativeOf && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = document.generations.find((candidate) => candidate.id === current.alternativeOf);
    if (!parent) return current.alternativeOf;
    current = parent;
  }
  return current.id;
}

function refreshMembership(document: EditableDocument): EditableDocument {
  return { ...document, generations: document.generations.map((generation) => ({ ...generation,
    blockIds: document.blocks.filter((block) => block.generationId === generation.id || !block.generationId && generation.blockIds.includes(block.id)).map((block) => block.id),
  })) };
}

/** Explicitly replace the visible response, retaining the user's current edited version. */
export function acceptDocumentVersion(conversation: Conversation, generationId: string, updatedAt = new Date().toISOString()): Conversation {
  const document = conversation.document;
  if (!document) return conversation;
  const candidate = document.generations.find((generation) => generation.id === generationId);
  if (!candidate || candidate.acceptedAt || candidate.status === "streaming" || candidate.status === "failed") return conversation;
  const output = conversation.messages.find((message) => message.id === candidate.messageId && message.role === "assistant");
  if (!output?.content.trim()) return conversation;
  if (!candidate.alternativeOf) return insertDocumentGeneration(conversation, generationId, undefined, updatedAt);

  const family = familyId(document, candidate);
  const current = [...document.generations].reverse().find((generation) => generation.acceptedAt &&
    familyId(document, generation) === family && document.blocks.some((block) => block.generationId === generation.id || generation.blockIds.includes(block.id)));
  const oldIds = new Set(current ? document.blocks.filter((block) => block.generationId === current.id || current.blockIds.includes(block.id)).map((block) => block.id) : []);
  const insertionIndex = document.blocks.findIndex((block) => oldIds.has(block.id));
  const nextBlock = insertionIndex < 0 ? undefined : document.blocks.slice(insertionIndex).find((block) => !oldIds.has(block.id));
  const previousBlocks = document.blocks.filter((block) => oldIds.has(block.id)).map((block) => ({ ...block }));
  const replaced: Conversation = { ...conversation, document: { ...document,
    blocks: document.blocks.filter((block) => !oldIds.has(block.id)),
    generations: document.generations.map((generation) => generation.id === generationId ? { ...generation, previousBlocks } : generation),
  } };
  const inserted = insertDocumentGeneration(replaced, generationId, { blockId: nextBlock?.id ?? null, offset: 0 }, updatedAt);
  // A failed insertion must leave the visible response untouched, even for malformed imported data.
  return inserted === replaced ? conversation : { ...inserted, document: refreshMembership(inserted.document!) };
}

function restoredBlockId(generationId: string, blocks: DocumentBlock[]): string {
  const ids = new Set(blocks.map((block) => block.id));
  const base = `restored:${generationId.slice(0, 900)}`;
  let id = base;
  for (let index = 2; ids.has(id); index += 1) id = `${base}:${index}`;
  return id;
}

/** Undo only this visible insertion; unrelated new blocks and subsequent edits remain. */
export function undoDocumentInsertion(conversation: Conversation, generationId: string, updatedAt = new Date().toISOString()): Conversation {
  const document = conversation.document;
  const generation = document?.generations.find((candidate) => candidate.id === generationId);
  if (!document || !generation || !generation.acceptedAt || generation.status === "streaming") return conversation;
  const ownedIds = new Set(generation.blockIds);
  const removed = document.blocks.filter((block) => block.generationId === generationId || ownedIds.has(block.id));
  if (!removed.length) return conversation;
  const removedIds = new Set(removed.map((block) => block.id));
  const insertionIndex = document.blocks.findIndex((block) => removedIds.has(block.id));
  let blocks = document.blocks.filter((block) => !removedIds.has(block.id));
  const replacement = generation.replacement;
  const restored: DocumentBlock[] = [];
  if (replacement?.content) {
    const target = blocks.find((block) => block.id === replacement.blockId);
    if (target && Number.isSafeInteger(replacement.offset) && replacement.offset >= 0 && replacement.offset <= target.content.length) {
      blocks = blocks.map((block) => block === target ? { ...block, updatedAt,
        content: block.content.slice(0, replacement.offset) + replacement.content + block.content.slice(replacement.offset),
      } : block);
    } else {
      restored.push({ id: restoredBlockId(generationId, blocks), kind: "markdown", content: replacement.content, createdAt: updatedAt, updatedAt });
    }
  }
  const presentIds = new Set([...blocks, ...restored].map((block) => block.id));
  for (const previous of generation.previousBlocks ?? []) {
    if (presentIds.has(previous.id)) continue;
    presentIds.add(previous.id);
    restored.push({ ...previous });
  }
  blocks.splice(insertionIndex, 0, ...restored);
  // Keep immutable messages, statuses, acceptedAt and prior authored snapshots as history.
  // With no visible blocks, a repeated undo is a no-op rather than inserting the quote twice.
  return { ...conversation, updatedAt, document: refreshMembership({ ...document, blocks }) };
}

/** Rebase the point where Undo restores selected text after an ordinary document edit. */
export function remapDocumentReplacement(generation: DocumentGeneration, beforeBlocks: DocumentBlock[], afterBlocks: DocumentBlock[]): DocumentGeneration {
  const replacement = generation.replacement;
  if (!replacement) return generation;
  const before = beforeBlocks.find((block) => block.id === replacement.blockId);
  const after = afterBlocks.find((block) => block.id === replacement.blockId);
  if (!before || before.content === after?.content) return generation;
  const range = after ? remapDocumentRange(before.content, after.content, replacement.offset, replacement.offset) : null;
  return { ...generation, replacement: range ? { ...replacement, offset: range.from }
    : { ...replacement, blockId: `restore:${generation.id}`, offset: 0 } };
}
