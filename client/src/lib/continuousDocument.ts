import { getDocumentBlockAuthorship, type DocumentBlock, type Message } from "@margin-chat/workspace-contracts";

/**
 * One continuous editor holds every block of a document. Each block is a
 * line: one paragraph, heading, list, table, code block, quote or media item.
 * A block keeps several of those only while a highlight, note or branch spans
 * them, because a saved passage points into exactly one block.
 */

export const freshDocumentBlockId = () => `block-${crypto.randomUUID()}`;
export const isDraftBlockId = (id: string) => id.startsWith("draft:");

export interface Span { from: number; to: number }

/**
 * Consecutive child indexes that must stay in one block. A range that starts in
 * one child and ends in a later one joins every child it touches.
 */
export function blockChildGroups(children: Span[], ranges: Span[]): number[][] {
  if (!children.length) return [];
  // joined[i] means child i stays with child i + 1.
  const joined = new Array(Math.max(0, children.length - 1)).fill(false);
  const indexAt = (position: number, end: boolean) => {
    const index = children.findIndex((child) => end ? position > child.from && position <= child.to : position >= child.from && position < child.to);
    return index < 0 ? (end ? children.length - 1 : 0) : index;
  };
  for (const range of ranges) {
    if (range.to <= range.from) continue;
    const first = indexAt(range.from, false);
    const last = indexAt(range.to, true);
    for (let index = first; index < last; index += 1) joined[index] = true;
  }
  const groups: number[][] = [[0]];
  for (let index = 1; index < children.length; index += 1) {
    if (joined[index - 1]) groups.at(-1)!.push(index);
    else groups.push([index]);
  }
  return groups;
}

export interface EditorBlockState {
  id: string;
  /** The block this one was split from, when an edit created it. */
  splitFrom?: string | null;
  markdown: string;
  changed: boolean;
}

/**
 * Build the saved block list from the editor's blocks, keeping each surviving
 * block's identity and provenance. Empty draft lines are not saved.
 */
export function reconcileDocumentBlocks(previous: DocumentBlock[], editorBlocks: EditorBlockState[], sourceMessages?: ReadonlyArray<Pick<Message, "id" | "role">>, now = new Date().toISOString()): DocumentBlock[] {
  const byId = new Map(previous.map((block) => [block.id, block]));
  const next: DocumentBlock[] = [];
  for (const item of editorBlocks) {
    if (isDraftBlockId(item.id)) {
      if (!item.markdown) continue;
    }
    const existing = byId.get(item.id);
    if (existing) {
      next.push(!item.changed || existing.content === item.markdown ? existing : { ...existing, content: item.markdown, updatedAt: now,
        authorship: getDocumentBlockAuthorship(existing, sourceMessages) === "user" ? "user" : "mixed" });
      continue;
    }
    const origin = item.splitFrom ? byId.get(item.splitFrom) : undefined;
    const originAuthorship = origin ? getDocumentBlockAuthorship(origin, sourceMessages) : "user";
    next.push({ id: isDraftBlockId(item.id) ? freshDocumentBlockId() : item.id, kind: "markdown", content: item.markdown, createdAt: now, updatedAt: now,
      ...(origin?.sourceMessageId ? { sourceMessageId: origin.sourceMessageId } : {}),
      ...(origin?.generationId ? { generationId: origin.generationId } : {}),
      authorship: item.markdown && origin ? originAuthorship : "user" });
  }
  return next;
}

/**
 * Join consecutive lines into the first of them, so a passage selected across
 * them can be saved in one block. The text is unchanged: blocks are saved with
 * a blank line between them. Returns null when the lines are no longer next to
 * each other.
 */
export function joinDocumentBlocks(blocks: DocumentBlock[], firstId: string, joinIds: string[], sourceMessages?: ReadonlyArray<Pick<Message, "id" | "role">>, now = new Date().toISOString()): DocumentBlock[] | null {
  const index = blocks.findIndex((block) => block.id === firstId);
  const joined = blocks.slice(index + 1, index + 1 + joinIds.length);
  if (index < 0 || !joinIds.length || joined.length !== joinIds.length || joined.some((block, offset) => block.id !== joinIds[offset])) return null;
  const lines = [blocks[index], ...joined];
  const authorship = new Set(lines.map((block) => getDocumentBlockAuthorship(block, sourceMessages)));
  const merged: DocumentBlock = { ...blocks[index], content: lines.map((block) => block.content).join("\n\n"), updatedAt: now,
    authorship: authorship.size === 1 ? [...authorship][0] : "mixed" };
  return [...blocks.slice(0, index), merged, ...blocks.slice(index + 1 + joinIds.length)];
}

export function sameBlockList(first: DocumentBlock[], second: DocumentBlock[]) {
  return first.length === second.length && first.every((block, index) => block === second[index]);
}
