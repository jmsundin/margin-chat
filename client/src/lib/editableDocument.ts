import type {
  Conversation, DocumentBlock, DocumentGeneration, DocumentInsertion, DocumentPrompt, EditableDocument,
} from "@margin-chat/workspace-contracts";
import { getStandaloneNote, getStandaloneNoteContextMessageId } from "./standaloneNotes";
import { latexMarkdownLexer } from "./latex";

export type { DocumentBlock, DocumentGeneration, DocumentInsertion, DocumentPrompt, EditableDocument } from "@margin-chat/workspace-contracts";

/** Complete top-level Markdown units; lists, fenced code and tables remain intact. */
export function splitDocumentMarkdown(markdown: string): string[] {
  if (!markdown) return [""];
  const parts: string[] = [];
  for (const token of latexMarkdownLexer.lexer(markdown)) {
    if (token.type === "space" && parts.length) parts[parts.length - 1] += token.raw;
    else parts.push(token.raw);
  }
  // Marked normalizes some input (for example CRLF). Never change the source bytes during migration.
  return parts.join("") === markdown && parts.length ? parts : [markdown];
}

function sourceBlocks(baseId: string, content: string, createdAt: string, sourceMessageId?: string, generationId?: string): DocumentBlock[] {
  let offset = 0;
  return splitDocumentMarkdown(content).map((part, index) => {
    const block: DocumentBlock = { id: index ? `${baseId}:part:${offset}` : baseId, kind: "markdown", content: part,
      createdAt, updatedAt: createdAt, ...(sourceMessageId ? { sourceMessageId } : {}), ...(generationId ? { generationId } : {}) };
    offset += part.length;
    return block;
  });
}

/** A read-only, deterministic projection: the first edit persists it, without rewriting history. */
export function getEditableDocument(conversation: Conversation): EditableDocument {
  if (conversation.document) return conversation.document;
  const document: EditableDocument = { schemaVersion: 1, blocks: [], prompts: [], generations: [] };
  const settings = { serviceId: conversation.serviceId, modelId: conversation.modelId, ...(conversation.ai ? { ai: conversation.ai } : {}) };
  const note = getStandaloneNote(conversation);
  if (note) {
    document.blocks.push(...sourceBlocks(`note:${note.id}`, note.content, note.createdAt).map((block) => ({ ...block, updatedAt: note.updatedAt })));
    return document;
  }
  let prompt: DocumentPrompt | undefined;
  for (const message of conversation.messages) {
    if (message.role === "user" && !message.id.startsWith("standalone-note-context-") && message.content.trim()) {
      prompt = { id: `prompt:${message.id}`, content: message.content, createdAt: message.createdAt,
        sourceMessageId: message.id, ...settings };
      document.prompts.push(prompt);
    } else if (message.role === "assistant") {
      const blockId = `message:${message.id}`;
      const generationId = prompt ? `generation:${message.id}` : undefined;
      const blocks = sourceBlocks(blockId, message.content, message.createdAt, message.id, generationId);
      document.blocks.push(...blocks);
      if (prompt && generationId) document.generations.push({ id: generationId, promptId: prompt.id,
        messageId: message.id, createdAt: message.createdAt, ...settings,
        status: message.execution?.status ?? "complete", blockIds: blocks.map((block) => block.id), acceptedAt: message.createdAt });
    }
  }
  if (!document.blocks.length) document.blocks.push({ id: `empty:${conversation.id}`, kind: "markdown", content: "", createdAt: conversation.createdAt, updatedAt: conversation.updatedAt });
  return document;
}

export function getEditableDocumentText(conversation: Conversation): string {
  return getEditableDocument(conversation).blocks.map((block) => block.content).join("\n\n");
}

/** Resolve current authored content. Deleted assistant output must never fall back to history. */
export function getDocumentSourceText(conversation: Conversation, messageId: string, sourceBlockId?: string): string | undefined {
  const document = getEditableDocument(conversation);
  const note = getStandaloneNote(conversation);
  if (sourceBlockId) {
    const block = document.blocks.find((candidate) => candidate.id === sourceBlockId);
    return block && (messageId === `document:${block.id}` || messageId === block.sourceMessageId ||
      note && messageId === getStandaloneNoteContextMessageId(note.id)) ? block.content : undefined;
  }
  if (messageId.startsWith("document:")) return document.blocks.find((block) => `document:${block.id}` === messageId)?.content;
  const matches = document.blocks.filter((block) => block.sourceMessageId === messageId);
  if (matches.length) return matches.map((block) => block.content).join("");
  if (note && messageId === getStandaloneNoteContextMessageId(note.id)) {
    return conversation.document ? getEditableDocumentText(conversation) : note.content;
  }
  const original = conversation.messages.find((message) => message.id === messageId);
  return original?.role === "user" && !original.id.startsWith("standalone-note-context-") ? original.content : undefined;
}

const timestamp = () => new Date().toISOString();
const save = (conversation: Conversation, document: EditableDocument, updatedAt: string): Conversation => ({ ...conversation, document, updatedAt });
const uniqueBlockId = (base: string, blocks: DocumentBlock[]): string => {
  const ids = new Set(blocks.map((block) => block.id));
  let candidate = base;
  for (let index = 2; ids.has(candidate); index += 1) candidate = `${base}:${index}`;
  return candidate;
};

export function updateDocumentBlock(conversation: Conversation, blockId: string, content: string, updatedAt = timestamp()): Conversation {
  const document = getEditableDocument(conversation);
  const existing = document.blocks.find((block) => block.id === blockId);
  if (!existing || existing.content === content) return conversation;
  return save(conversation, { ...document, blocks: document.blocks.map((block) => block.id === blockId ? { ...block, content, updatedAt } : block) }, updatedAt);
}

/** Inserting into a block splits it without losing its stable original ID or provenance. */
export function insertDocumentBlock(conversation: Conversation, block: DocumentBlock, location?: DocumentInsertion, updatedAt = timestamp()): Conversation {
  const document = getEditableDocument(conversation);
  if (document.blocks.some((candidate) => candidate.id === block.id)) return conversation;
  const blocks = [...document.blocks];
  let split: DocumentBlock | undefined;
  if (location?.blockId != null) {
    const index = blocks.findIndex((candidate) => candidate.id === location.blockId);
    if (index === -1 || !Number.isSafeInteger(location.offset) || location.offset < 0 || location.offset > blocks[index].content.length) return conversation;
    const target = blocks[index];
    const end = location.replaceTo ?? location.offset;
    if (!Number.isSafeInteger(end) || end < location.offset || end > target.content.length) return conversation;
    if (location.offset === 0 && end === 0) blocks.splice(index, 0, block);
    else if (location.offset === target.content.length && end === location.offset) blocks.splice(index + 1, 0, block);
    else {
      const prefix = { ...target, content: target.content.slice(0, location.offset), updatedAt };
      const suffixContent = target.content.slice(end);
      split = suffixContent ? { ...target, id: uniqueBlockId(`split:${target.id.slice(0, 100)}:after:${block.id.slice(0, 100)}`, [...blocks, block]), content: suffixContent, updatedAt } : undefined;
      blocks.splice(index, 1, prefix, block, ...(split ? [split] : []));
    }
  } else blocks.push(block);
  const generations = split?.generationId ? document.generations.map((generation) => generation.id === split!.generationId
    ? { ...generation, blockIds: [...generation.blockIds, split!.id] } : generation) : document.generations;
  return save(conversation, { ...document, blocks, generations }, updatedAt);
}

export function moveDocumentBlock(conversation: Conversation, blockId: string, beforeBlockId: string | null, updatedAt = timestamp()): Conversation {
  const document = getEditableDocument(conversation);
  if (blockId === beforeBlockId || beforeBlockId !== null && !document.blocks.some((block) => block.id === beforeBlockId)) return conversation;
  const block = document.blocks.find((candidate) => candidate.id === blockId);
  if (!block) return conversation;
  const blocks = document.blocks.filter((candidate) => candidate !== block);
  const index = beforeBlockId === null ? blocks.length : blocks.findIndex((candidate) => candidate.id === beforeBlockId);
  blocks.splice(index, 0, block);
  if (blocks.every((candidate, blockIndex) => candidate === document.blocks[blockIndex])) return conversation;
  return save(conversation, { ...document, blocks }, updatedAt);
}

export function removeDocumentBlock(conversation: Conversation, blockId: string, updatedAt = timestamp()): Conversation {
  const document = getEditableDocument(conversation);
  const block = document.blocks.find((candidate) => candidate.id === blockId);
  if (!block) return conversation;
  return save(retainDocumentBlockSource(conversation, block), { ...document, blocks: document.blocks.filter((candidate) => candidate.id !== blockId) }, updatedAt);
}

/** A deleted manual block can remain the historical source of a side chat or annotation. */
export function retainDocumentBlockSource(conversation: Conversation, block: DocumentBlock): Conversation {
  if (block.sourceMessageId || conversation.messages.some((message) => message.id === `document:${block.id}`)) return conversation;
  return { ...conversation, messages: [...conversation.messages, { id: `document:${block.id}`, role: "user", content: block.content, createdAt: block.createdAt }] };
}

export function upsertDocumentPrompt(conversation: Conversation, prompt: DocumentPrompt, updatedAt = timestamp()): Conversation {
  const document = getEditableDocument(conversation);
  const prompts = document.prompts.some((candidate) => candidate.id === prompt.id)
    ? document.prompts.map((candidate) => candidate.id === prompt.id ? prompt : candidate) : [...document.prompts, prompt];
  return save(conversation, { ...document, prompts }, updatedAt);
}

export function upsertDocumentGeneration(conversation: Conversation, generation: DocumentGeneration, updatedAt = timestamp()): Conversation {
  const document = getEditableDocument(conversation);
  if (!document.prompts.some((prompt) => prompt.id === generation.promptId)) return conversation;
  const generations = document.generations.some((candidate) => candidate.id === generation.id)
    ? document.generations.map((candidate) => candidate.id === generation.id ? generation : candidate) : [...document.generations, generation];
  return save(conversation, { ...document, generations }, updatedAt);
}

/** Accept a candidate explicitly. Reruns and streamed messages alone cannot replace authored text. */
export function insertDocumentGeneration(conversation: Conversation, generationId: string, location?: DocumentInsertion, updatedAt = timestamp()): Conversation {
  const document = getEditableDocument(conversation);
  const generation = document.generations.find((candidate) => candidate.id === generationId);
  const message = generation && conversation.messages.find((candidate) => candidate.id === generation.messageId && candidate.role === "assistant");
  if (!generation || generation.acceptedAt || !message?.content.trim()) return conversation;
  const insertion = location ?? generation.insertion;
  const target = insertion?.blockId ? document.blocks.find((block) => block.id === insertion.blockId) : undefined;
  const replacement = target && insertion?.replaceTo !== undefined && insertion.replaceTo > insertion.offset
    ? { blockId: target.id, offset: insertion.offset, content: target.content.slice(insertion.offset, insertion.replaceTo) } : undefined;
  const blocks = sourceBlocks(uniqueBlockId(`generation:${generation.id}`, document.blocks), message.content, updatedAt, message.id, generationId);
  for (let index = 0; index < blocks.length; index += 1) blocks[index] = { ...blocks[index], id: uniqueBlockId(blocks[index].id, [...document.blocks, ...blocks.slice(0, index)]) };
  let inserted = insertDocumentBlock(conversation, blocks[0], insertion, updatedAt);
  if (inserted === conversation) return conversation;
  for (let index = 1; index < blocks.length; index += 1) {
    inserted = insertDocumentBlock(inserted, blocks[index], { blockId: blocks[index - 1].id, offset: blocks[index - 1].content.length }, updatedAt);
  }
  return { ...inserted, document: { ...inserted.document!, generations: inserted.document!.generations.map((candidate) => candidate.id === generationId
    ? { ...candidate, blockIds: blocks.map((block) => block.id), acceptedAt: updatedAt, ...(insertion ? { insertion } : {}), ...(replacement ? { replacement } : {}) } : candidate) } };
}

/** Map a surviving selection through one block edit; overlapping edits intentionally become stale. */
export function remapDocumentRange(before: string, after: string, from: number, to: number): { from: number; to: number } | null {
  if (from < 0 || to < from || to > before.length) return null;
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  if (to <= prefix) return { from, to };
  if (from >= before.length - suffix) return { from: from + after.length - before.length, to: to + after.length - before.length };
  return null;
}
