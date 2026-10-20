import type { Conversation, DocumentBlock } from "@margin-chat/workspace-contracts";
import { getDocumentSourceText, getEditableDocument, remapDocumentPassage, remapDocumentRange } from "./editableDocument";

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

/**
 * Joining a line onto the one above it (Backspace at its start, or a passage
 * selected across lines) appends its text to the previous surviving block and
 * removes its block, or only its first line. Follow the passage there when its
 * quote appears exactly once in the joined part.
 */
function mergedAnchor<T extends DocumentAnchorRange>(anchor: T, oldTarget: DocumentBlock, beforeBlocks: DocumentBlock[], afterBlocks: DocumentBlock[]): T | null {
  const quote = anchor.quote ?? "";
  if (!quote) return null;
  const afterIds = new Set(afterBlocks.map((block) => block.id));
  const index = beforeBlocks.indexOf(oldTarget);
  let previous: DocumentBlock | undefined;
  for (let cursor = index - 1; cursor >= 0 && !previous; cursor -= 1) if (afterIds.has(beforeBlocks[cursor].id)) previous = beforeBlocks[cursor];
  if (!previous) return null;
  const joined = afterBlocks.find((block) => block.id === previous!.id)!;
  if (joined.sourceMessageId !== previous.sourceMessageId || joined.content.length <= previous.content.length) return null;
  // Only the part beyond the surviving prefix of the previous block can hold the joined line.
  let shared = 0;
  while (shared < previous.content.length && previous.content[shared] === joined.content[shared]) shared += 1;
  const matches = occurrences(joined.content.slice(shared), quote).map((from) => from + shared);
  if (matches.length !== 1) return null;
  return { ...anchor, sourceBlockId: joined.id, sourceMessageId: joined.sourceMessageId ?? `document:${joined.id}`,
    startOffset: matches[0], endOffset: matches[0] + quote.length };
}

/** A passage whose own text was edited keeps what survives of it, with that as its quote. */
function editedAnchor<T extends DocumentAnchorRange>(anchor: T, before: string, after: string, from: number | null, to: number | null): T | null {
  if (from === null || to === null) return null;
  const range = remapDocumentPassage(before, after, from, to);
  if (!range || !after.slice(range.from, range.to).trim()) return null;
  return { ...anchor, startOffset: range.from, endOffset: range.to, quote: after.slice(range.from, range.to) };
}

/** Track a passage through ordinary edits and a block split without borrowing unrelated matches. */
export function remapDocumentAnchor<T extends DocumentAnchorRange>(anchor: T, beforeConversation: Conversation, afterConversation: Conversation): T {
  if (beforeConversation.id !== afterConversation.id || !anchor.sourceMessageId || anchor.startOffset === null || anchor.endOffset === null ||
      anchor.sourceBlockId?.startsWith("detached:")) return anchor;
  const before = getDocumentSourceText(beforeConversation, anchor.sourceMessageId, anchor.sourceBlockId);
  const after = getDocumentSourceText(afterConversation, anchor.sourceMessageId, anchor.sourceBlockId);
  const afterBlocks = getEditableDocument(afterConversation).blocks;
  if (before !== undefined && after === undefined && anchor.sourceBlockId) {
    const beforeBlocks = getEditableDocument(beforeConversation).blocks;
    const oldTarget = beforeBlocks.find((block) => block.id === anchor.sourceBlockId);
    const merged = oldTarget && !afterBlocks.some((block) => block.id === oldTarget.id) ? mergedAnchor(anchor, oldTarget, beforeBlocks, afterBlocks) : null;
    if (merged) return merged;
  }
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
    if (oldMatches.length === 1 && matches.length === 1) return { ...anchor, startOffset: matches[0], endOffset: matches[0] + quote.length };
    return (quote && !matches.length ? editedAnchor(anchor, before, after, beforeFrom, beforeTo) : null) ?? anchor;
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
  // A block split into lines: follow the passage's offset into the line that now holds it, even when its text repeats.
  if (candidates.length > 1) {
    const spread = remapDocumentRange(before, candidates.map((block) => block.content).join("\n\n"), beforeFrom ?? anchor.startOffset, beforeTo ?? anchor.endOffset);
    let start = 0;
    for (const block of spread ? candidates : []) {
      const from = spread!.from - start, to = spread!.to - start;
      if (from >= 0 && to <= block.content.length && (!quote || block.content.slice(from, to) === quote)) {
        if (block.id === anchor.sourceBlockId) return from === anchor.startOffset && to === anchor.endOffset ? anchor : { ...anchor, startOffset: from, endOffset: to };
        return { ...anchor, sourceBlockId: block.id, sourceMessageId: block.sourceMessageId ?? `document:${block.id}`, startOffset: from, endOffset: to };
      }
      start += block.content.length + 2;
    }
  }
  const range = remapDocumentRange(before, after, beforeFrom ?? anchor.startOffset, beforeTo ?? anchor.endOffset);
  if (range && (!quote || after.slice(range.from, range.to) === quote)) {
    return range.from === anchor.startOffset && range.to === anchor.endOffset ? anchor : { ...anchor, startOffset: range.from, endOffset: range.to };
  }
  if (!quote || oldMatches.length !== 1 || matches.length !== 1) {
    // Its line may have been joined onto the line above, or text inside the passage was edited.
    return (quote && !matches.length ? mergedAnchor(anchor, oldTarget, beforeBlocks, afterBlocks) ?? editedAnchor(anchor, before, after, beforeFrom, beforeTo) : null) ?? detach(anchor, afterBlocks);
  }
  const match = matches[0];
  return { ...anchor, sourceBlockId: match.block.id,
    sourceMessageId: match.block.sourceMessageId ?? `document:${match.block.id}`,
    startOffset: match.from, endOffset: match.from + quote.length };
}
