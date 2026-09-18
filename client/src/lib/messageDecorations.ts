import type { ConversationNote, MessageAnchorLink, SelectionDraft } from "../types";

type DecorationRange = { startOffset: number; endOffset: number };

export type MessageDecoration = DecorationRange & (
  | { type: "anchor"; branchConversationId: string; title: string }
  | { type: "note"; noteId: string }
  | { type: "preview" }
);

export interface DecoratedTextSegment {
  start: number;
  end: number;
  value: string;
  active: MessageDecoration[];
}

function hasValidRange(range: DecorationRange) {
  return Number.isFinite(range.startOffset) && Number.isFinite(range.endOffset) &&
    range.endOffset > range.startOffset;
}

/** Offsets address visible text; the adapters supply plain text or each DOM text node. */
export function buildMessageDecorations(
  anchors: MessageAnchorLink[],
  notes: ConversationNote[],
  pendingSelection: SelectionDraft | null,
): MessageDecoration[] {
  const decorations: MessageDecoration[] = anchors.map((link) => ({
    type: "anchor",
    startOffset: link.anchor.startOffset,
    endOffset: link.anchor.endOffset,
    branchConversationId: link.branchConversationId,
    title: link.title,
  }));

  for (const note of notes) {
    if (note.startOffset === null || note.endOffset === null) continue;
    decorations.push({
      type: "note",
      startOffset: note.startOffset,
      endOffset: note.endOffset,
      noteId: note.id,
    });
  }

  if (pendingSelection && hasValidRange(pendingSelection) && !anchors.some(
    ({ anchor }) => hasValidRange(anchor) &&
      pendingSelection.startOffset < anchor.endOffset &&
      pendingSelection.endOffset > anchor.startOffset,
  )) {
    decorations.push({
      type: "preview",
      startOffset: pendingSelection.startOffset,
      endOffset: pendingSelection.endOffset,
    });
  }

  return decorations.filter(hasValidRange)
    .sort((left, right) => left.startOffset - right.startOffset);
}

/** Include every rendered field, including the branch title used by its accessible label. */
export function getMessageDecorationKey(decorations: MessageDecoration[]) {
  return JSON.stringify(decorations);
}

/** Partition a text range without losing characters, including partially streamed ranges. */
export function partitionDecoratedText(
  text: string,
  decorations: MessageDecoration[],
  startOffset = 0,
): DecoratedTextSegment[] {
  const endOffset = startOffset + text.length;
  const overlapping = decorations.filter((decoration) =>
    hasValidRange(decoration) &&
    decoration.startOffset < endOffset && decoration.endOffset > startOffset,
  );
  const boundaries = [...new Set([
    startOffset,
    endOffset,
    ...overlapping.flatMap((decoration) => [
      Math.max(startOffset, decoration.startOffset),
      Math.min(endOffset, decoration.endOffset),
    ]),
  ])].sort((left, right) => left - right);

  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    return {
      start,
      end,
      value: text.slice(start - startOffset, end - startOffset),
      active: overlapping.filter((decoration) =>
        decoration.startOffset < end && decoration.endOffset > start,
      ),
    };
  });
}
