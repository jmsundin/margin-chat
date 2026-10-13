import type { DocumentBlock } from "@margin-chat/workspace-contracts";

export type SelectionResponseDestination = "inline" | "side";

/**
 * Words outside the selected passage up to which the document still counts as
 * nearly empty, about two short paragraphs. Above it the answer opens in a
 * side document so it doesn't push existing writing apart.
 */
export const SIDE_DOCUMENT_MIN_OTHER_WORDS = 80;

function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

/**
 * The destination preselected when AI is asked about a passage: in this
 * document when the passage is the last thing in it or there is little else,
 * otherwise a side document.
 */
export function defaultSelectionDestination(
  blocks: ReadonlyArray<Pick<DocumentBlock, "id" | "content">>,
  selection: { sourceBlockId?: string; joinBlockIds?: string[]; quote: string },
): SelectionResponseDestination {
  if (!selection.sourceBlockId) return "side";
  const selectedIds = [selection.sourceBlockId, ...(selection.joinBlockIds ?? [])];
  const lastSelectedIndex = Math.max(...selectedIds.map((id) => blocks.findIndex((block) => block.id === id)));
  if (lastSelectedIndex < 0) return "side";
  let lastFilledIndex = blocks.length - 1;
  while (lastFilledIndex >= 0 && !blocks[lastFilledIndex].content.trim()) lastFilledIndex -= 1;
  if (lastSelectedIndex >= lastFilledIndex) return "inline";
  const totalWords = blocks.reduce((sum, block) => sum + countWords(block.content), 0);
  return totalWords - countWords(selection.quote) <= SIDE_DOCUMENT_MIN_OTHER_WORDS ? "inline" : "side";
}
