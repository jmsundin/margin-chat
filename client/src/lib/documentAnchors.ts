import type { Conversation, DocumentBlock } from "@margin-chat/workspace-contracts";
import { getDocumentSourceText, getEditableDocument, remapDocumentRange } from "./editableDocument";

export interface DocumentAnchorRange {
  sourceMessageId: string | null;
  sourceBlockId?: string;
  startOffset: number | null;
  endOffset: number | null;
  quote: string | null;
}

function occurrences(content: string, quote: string): number[] {
  if (!quote) return [];
  const positions: number[] = [];
  for (let index = content.indexOf(quote); index !== -1; index = content.indexOf(quote, index + 1)) {
    positions.push(index);
    // Only uniqueness matters. Avoid scanning arbitrarily large repeated passages.
    if (positions.length === 2) break;
  }
  return positions;
}

function occurrenceCount(content: string, quote: string): number {
  if (!quote) return 0;
  let count = 0;
  for (let index = content.indexOf(quote); index !== -1; index = content.indexOf(quote, index + 1)) count += 1;
  return count;
}

function detach<T extends DocumentAnchorRange>(anchor: T, blocks: DocumentBlock[]): T {
  if (!anchor.sourceBlockId || anchor.sourceBlockId.startsWith("detached:")) return anchor;
  // A detached source is historical: its quote/range/message identity remain portable,
  // but it cannot decorate another passage or automatically rebind after later edits.
  const base = `detached:${anchor.sourceBlockId.slice(0, 900)}`;
  const ids = new Set(blocks.map((block) => block.id));
  let sourceBlockId = base;
  for (let index = 2; ids.has(sourceBlockId); index += 1) sourceBlockId = `${base}:${index}`;
  return { ...anchor, sourceBlockId };
}

/** Track a passage through ordinary edits and a block split without borrowing unrelated matches. */
export function remapDocumentAnchor<T extends DocumentAnchorRange>(anchor: T, beforeConversation: Conversation, afterConversation: Conversation): T {
  if (beforeConversation.id !== afterConversation.id || !anchor.sourceMessageId || anchor.startOffset === null || anchor.endOffset === null ||
      anchor.sourceBlockId?.startsWith("detached:")) return anchor;
  const before = getDocumentSourceText(beforeConversation, anchor.sourceMessageId, anchor.sourceBlockId);
  const after = getDocumentSourceText(afterConversation, anchor.sourceMessageId, anchor.sourceBlockId);
  const afterBlocks = getEditableDocument(afterConversation).blocks;
  if (before === undefined || after === undefined) return anchor.sourceBlockId ? detach(anchor, afterBlocks) : anchor;
  if (before === after) return anchor;

  const quote = anchor.quote ?? "";
  const oldMatches = occurrences(before, quote);
  const exactBefore = before.slice(anchor.startOffset, anchor.endOffset) === quote;
  const beforeFrom = exactBefore ? anchor.startOffset : oldMatches.length === 1 ? oldMatches[0] : null;
  const beforeTo = beforeFrom === null ? null : beforeFrom + quote.length;
  if (quote && beforeFrom === null) return anchor.sourceBlockId ? detach(anchor, afterBlocks) : anchor;

  // A legacy message reference uses offsets in its complete surviving source text.
  if (!anchor.sourceBlockId) {
    const range = remapDocumentRange(before, after, beforeFrom ?? anchor.startOffset, beforeTo ?? anchor.endOffset);
    if (range && (!quote || after.slice(range.from, range.to) === quote)) {
      return range.from === anchor.startOffset && range.to === anchor.endOffset ? anchor : { ...anchor, startOffset: range.from, endOffset: range.to };
    }
    const matches = occurrences(after, quote);
    return oldMatches.length === 1 && matches.length === 1 ? { ...anchor, startOffset: matches[0], endOffset: matches[0] + quote.length } : anchor;
  }

  const beforeBlocks = getEditableDocument(beforeConversation).blocks;
  const oldTarget = beforeBlocks.find((block) => block.id === anchor.sourceBlockId);
  const targetIndex = afterBlocks.findIndex((block) => block.id === anchor.sourceBlockId);
  if (!oldTarget || targetIndex < 0) return detach(anchor, afterBlocks);
  const priorIds = new Set(beforeBlocks.map((block) => block.id));
  const candidates = [afterBlocks[targetIndex]];
  // Both rich-editor splitting and insertion preserve the prefix's ID, followed
  // by fresh blocks. Existing neighboring blocks are never eligible for recovery.
  for (let index = targetIndex + 1; index < afterBlocks.length && !priorIds.has(afterBlocks[index].id); index += 1) {
    const block = afterBlocks[index];
    if (block.sourceMessageId === oldTarget.sourceMessageId && block.generationId === oldTarget.generationId) candidates.push(block);
  }
  const matches = candidates.flatMap((block) => occurrences(block.content, quote).map((from) => ({ block, from })));
  // Removing one occurrence of repeated text is ambiguous even when another now
  // happens to occupy the same offsets. Prefer a historical reference to a wrong mark.
  if (oldMatches.length > 1 && candidates.reduce((count, block) => count + occurrenceCount(block.content, quote), 0) < occurrenceCount(before, quote)) return detach(anchor, afterBlocks);
  const range = remapDocumentRange(before, after, beforeFrom ?? anchor.startOffset, beforeTo ?? anchor.endOffset);
  if (range && (!quote || after.slice(range.from, range.to) === quote)) {
    return range.from === anchor.startOffset && range.to === anchor.endOffset ? anchor : { ...anchor, startOffset: range.from, endOffset: range.to };
  }
  if (!quote || oldMatches.length !== 1 || matches.length !== 1) return detach(anchor, afterBlocks);
  const match = matches[0];
  return { ...anchor, sourceBlockId: match.block.id,
    sourceMessageId: match.block.sourceMessageId ?? `document:${match.block.id}`,
    startOffset: match.from, endOffset: match.from + quote.length };
}
