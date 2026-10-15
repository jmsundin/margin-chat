import { parser as markdownParser, GFM } from "@lezer/markdown";
import { getRichDocumentFallbackReason } from "./richDocumentMarkdown";
import { parseMediaBlock } from "./documentMedia";
import { isDrawingMarkdown } from "./documentDrawing";
import { readBlockLatex } from "./latex";
import { freshDocumentBlockId, isDraftBlockId } from "./continuousDocument";

/**
 * The Live Preview document editor holds a document as one Markdown text: its
 * blocks joined by a blank line, exactly as the file saves them. Each block
 * keeps a range in that text, so a block offset is a text offset.
 */

export const BLOCK_SEPARATOR = "\n\n";
const SEPARATOR_LENGTH = BLOCK_SEPARATOR.length;

export interface LiveBlock {
  id: string;
  from: number;
  to: number;
  /** For a block an edit split off another one: the block whose text it holds. */
  splitFrom?: string | null;
}

export interface TextSpan { from: number; to: number }
/** A string, or an editor document read through the same two members. */
export interface TextSource { readonly length: number; slice(from: number, to?: number): string }

const parser = markdownParser.configure([GFM]);

export function layoutBlocks(blocks: ReadonlyArray<{ id: string; content: string }>): { text: string; layout: LiveBlock[] } {
  const layout: LiveBlock[] = [];
  let position = 0;
  blocks.forEach((block, index) => {
    if (index) position += SEPARATOR_LENGTH;
    layout.push({ id: block.id, from: position, to: position + block.content.length });
    position += block.content.length;
  });
  return { text: blocks.map((block) => block.content).join(BLOCK_SEPARATOR), layout };
}

/** The block holding a position. A position between two blocks belongs to the earlier one. */
export function blockIndexAt(layout: ReadonlyArray<LiveBlock>, position: number): number {
  let low = 0;
  let high = layout.length - 1;
  let found = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (layout[middle].from <= position) { found = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return found;
}

/**
 * Where a block's visible text ends. Trailing blank lines saved with a block
 * (older files keep them) are hidden; spaces on its last line are not.
 */
export function visibleEnd(text: TextSource, block: LiveBlock): number {
  let end = block.to;
  while (end > block.from && /\s/.test(text.slice(end - 1, end))) end -= 1;
  const tail = text.slice(end, block.to);
  const newline = tail.indexOf("\n");
  return newline < 0 ? block.to : end + newline;
}

function trailingNewlines(value: string) {
  let count = 0;
  for (let index = value.length - 1; index >= 0 && value[index] === "\n"; index -= 1) count += 1;
  return count;
}

/** Top-level Markdown items of a text: paragraphs, headings, lists, tables, code, quotes. */
function topLevelNodes(value: string): TextSpan[] {
  const nodes: TextSpan[] = [];
  const cursor = parser.parse(value).cursor();
  if (!cursor.firstChild()) return nodes;
  do nodes.push({ from: cursor.from, to: cursor.to }); while (cursor.nextSibling());
  return nodes;
}

export type LiveBlockKind = "text" | "media" | "drawing" | "rendered";
export interface LiveBlockInfo {
  kind: LiveBlockKind;
  /** Blank lines between paragraphs inside the block, as [first newline, last newline) offsets. */
  collapsed: TextSpan[];
}

function isTableBlock(content: string) {
  const lines = content.trim().split("\n");
  return lines.length >= 2 && lines.every((line) => line.trim().startsWith("|")) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[1]);
}

const infoCache = new Map<string, LiveBlockInfo>();
/** How a block is shown when the cursor is elsewhere, cached by its Markdown. */
export function liveBlockInfo(content: string): LiveBlockInfo {
  const cached = infoCache.get(content);
  if (cached) return cached;
  let kind: LiveBlockKind = "text";
  if (content.trim()) {
    if (parseMediaBlock(content)) kind = "media";
    else if (isDrawingMarkdown(content)) kind = "drawing";
    else if (isTableBlock(content)) kind = "rendered";
    else {
      const math = readBlockLatex(content.trim());
      const reason = math && !math.trailing.trim() ? "Math" : getRichDocumentFallbackReason(content);
      // A comment-only block would render as nothing, leaving no line to click into.
      if (reason && reason !== "Hidden comment") kind = "rendered";
    }
  }
  const collapsed: TextSpan[] = [];
  if (kind === "text" && content.includes(BLOCK_SEPARATOR)) {
    const nodes = topLevelNodes(content);
    for (let index = 1; index < nodes.length; index += 1) {
      const gap = content.slice(nodes[index - 1].to, nodes[index].from);
      if (gap.length >= 2 && /^\n+$/.test(gap)) collapsed.push({ from: nodes[index - 1].to, to: nodes[index].from - 1 });
    }
  }
  const info = { kind, collapsed };
  if (infoCache.size > 4000) infoCache.clear();
  infoCache.set(content, info);
  return info;
}

/**
 * Text ranges Live Preview hides so that blocks read as consecutive lines:
 * the blank line between blocks, blank lines saved at a block's end, and
 * blank lines between paragraphs a note joined into one block. Each range
 * keeps the last line break before the next visible line.
 */
export function hiddenGaps(text: TextSource, layout: ReadonlyArray<LiveBlock>): TextSpan[] {
  const gaps: TextSpan[] = [];
  layout.forEach((block, index) => {
    const content = text.slice(block.from, block.to);
    for (const run of liveBlockInfo(content).collapsed) gaps.push({ from: block.from + run.from, to: block.from + run.to });
    const end = visibleEnd(text, block);
    const next = layout[index + 1];
    const gapTo = next ? next.from - 1 : text.length;
    if (gapTo > end) gaps.push({ from: end, to: gapTo });
  });
  return gaps;
}

/**
 * Where the text between two visible lines collapses to one place, the
 * cursor may not stop inside it: typing there would write into a hidden line.
 * `direction` is 1 when the cursor is moving forward.
 */
export function snapOutOfGaps(text: TextSource, layout: ReadonlyArray<LiveBlock>, position: number, direction: 1 | -1): number {
  if (!layout.length) return position;
  const index = blockIndexAt(layout, position);
  const block = layout[index];
  const content = text.slice(block.from, block.to);
  for (const run of liveBlockInfo(content).collapsed) {
    const from = block.from + run.from, to = block.from + run.to + 1;
    if (position > from && position < to) return direction > 0 ? to : from;
  }
  const end = visibleEnd(text, block);
  const next = layout[index + 1];
  if (!next) return position > end ? end : position;
  if (position > end && position < next.from) return direction > 0 ? next.from : end;
  return position;
}

/**
 * Split a changed span of the text into blocks. Blank lines between top-level
 * items separate blocks, lists, tables, code and quotes stay whole, and a saved
 * passage (`keepTogether`) keeps the items it spans in one block. Extra blank
 * lines become empty blocks. The result covers the span exactly, with one
 * separator between consecutive blocks. Offsets are relative to the span.
 */
export function splitSpan(value: string, keepTogether: TextSpan[] = [], keepTrailing = 0): TextSpan[] {
  // Lines that are empty and not inside a list, table, code block or quote may separate blocks.
  const nodes = topLevelNodes(value);
  const units: TextSpan[] = [];
  let lineStart = 0;
  let unit: TextSpan | null = null;
  while (lineStart <= value.length) {
    const newline = value.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? value.length : newline;
    const blank = lineEnd === lineStart && !nodes.some((node) => node.from < lineStart && node.to > lineStart);
    if (blank) { if (unit) units.push(unit); unit = null; }
    else if (unit) unit.to = lineEnd;
    else unit = { from: lineStart, to: lineEnd };
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  if (unit) units.push(unit);

  // Nothing but line breaks: each blank line pair is an empty block.
  if (!units.length) {
    const count = Math.floor(value.length / SEPARATOR_LENGTH) + 1;
    const remainder = value.length % SEPARATOR_LENGTH;
    return Array.from({ length: count }, (_, index) => index ? { from: remainder + index * SEPARATOR_LENGTH, to: remainder + index * SEPARATOR_LENGTH } : { from: 0, to: remainder });
  }

  // Units joined by a saved passage stay one block.
  const joined = new Array(Math.max(0, units.length - 1)).fill(false);
  for (const range of keepTogether) {
    if (range.to <= range.from) continue;
    const first = units.findIndex((item) => range.from < item.to);
    if (first < 0) continue;
    let last = -1;
    units.forEach((item, index) => { if (item.from < range.to) last = index; });
    if (last < first) continue;
    for (let index = first; index < last; index += 1) joined[index] = true;
  }
  const groups: TextSpan[] = [];
  units.forEach((item, index) => {
    if (index && joined[index - 1]) groups.at(-1)!.to = item.to;
    else groups.push({ ...item });
  });

  const chunks: TextSpan[] = [];
  const pushEmpties = (start: number, count: number) => {
    for (let index = 1; index <= count; index += 1) chunks.push({ from: start + index * SEPARATOR_LENGTH, to: start + index * SEPARATOR_LENGTH });
  };
  // Line breaks before the first block: empty blocks, then the block keeps any odd one.
  const leading = groups[0].from;
  const leadingEmpty = Math.floor(leading / SEPARATOR_LENGTH);
  for (let index = 0; index < leadingEmpty; index += 1) chunks.push({ from: index * SEPARATOR_LENGTH, to: index * SEPARATOR_LENGTH });
  groups.forEach((group, index) => {
    const chunk = { from: index ? group.from : leadingEmpty * SEPARATOR_LENGTH, to: group.to };
    const next = groups[index + 1];
    if (next) {
      const breaks = next.from - group.to - SEPARATOR_LENGTH;
      const empties = Math.floor(breaks / SEPARATOR_LENGTH);
      chunk.to += breaks % SEPARATOR_LENGTH;
      chunks.push(chunk);
      pushEmpties(chunk.to, empties);
    } else {
      // Blank lines the last block already kept stay with it; new ones are new lines.
      const trailing = value.length - group.to;
      const kept = Math.min(trailing, keepTrailing);
      const added = trailing - kept;
      chunk.to += kept + added % SEPARATOR_LENGTH;
      chunks.push(chunk);
      pushEmpties(chunk.to, Math.floor(added / SEPARATOR_LENGTH));
    }
  });
  return chunks;
}

export interface ChangedSpan {
  /** Indexes of the old blocks the change touched, inclusive. */
  first: number;
  last: number;
  /** The span those blocks now cover in the new text. */
  from: number;
  to: number;
}

export interface BlockMapping {
  mapPos(position: number, assoc?: number): number;
  /** The new position, or null when the text after `position` was deleted. */
  mapStart(position: number): number | null;
}

/**
 * Give each new block an identity: a block whose start survived keeps its ID,
 * a new block that holds text split off an old one names it as its origin, and
 * a new draft line that gained text becomes a real block.
 */
export function assignBlockIds(
  oldBlocks: ReadonlyArray<LiveBlock & { markdown: string }>,
  chunks: ReadonlyArray<TextSpan & { markdown: string }>,
  mapping: BlockMapping,
): LiveBlock[] {
  const starts = oldBlocks.map((block) => mapping.mapStart(block.from));
  const used = new Set<number>();
  const ids: Array<{ id: string; splitFrom?: string | null } | null> = chunks.map((chunk) => {
    const match = starts.findIndex((start, index) => start === chunk.from && !used.has(index));
    if (match < 0) return null;
    used.add(match);
    const id = oldBlocks[match].id;
    return isDraftBlockId(id) && chunk.markdown ? { id: freshDocumentBlockId(), splitFrom: null } : { id };
  });
  return chunks.map((chunk, index) => {
    const assigned = ids[index];
    if (assigned) return { ...assigned, from: chunk.from, to: chunk.to };
    // The old block this text now sits in.
    const holder = oldBlocks.findIndex((block) => mapping.mapPos(block.from, -1) <= chunk.from && mapping.mapPos(block.to, 1) >= chunk.from);
    const origin = holder >= 0 ? oldBlocks[holder] : undefined;
    // Its first block keeps a block whose start was typed over or deleted.
    if (origin && !used.has(holder) && !isDraftBlockId(origin.id)) {
      used.add(holder);
      return { id: origin.id, from: chunk.from, to: chunk.to };
    }
    const text = chunk.markdown.trim();
    const holds = Boolean(origin && text && !isDraftBlockId(origin.id) && origin.markdown.includes(text));
    return { id: freshDocumentBlockId(), splitFrom: holds ? origin!.id : null, from: chunk.from, to: chunk.to };
  });
}

/**
 * Re-derive the blocks an edit touched. `changes` lists the edited ranges in
 * the old text; everything outside the touched blocks only shifts.
 */
export function reflowBlocks(options: {
  oldText: TextSource;
  newText: TextSource;
  layout: ReadonlyArray<LiveBlock>;
  changes: ReadonlyArray<{ fromA: number; toA: number }>;
  mapping: BlockMapping;
  /** Saved passages in the new text. */
  keepTogether: TextSpan[];
}): LiveBlock[] {
  const { oldText, newText, layout, changes, mapping } = options;
  if (!layout.length) {
    return splitSpan(newText.slice(0, newText.length), options.keepTogether).map((chunk) => ({ id: freshDocumentBlockId(), splitFrom: null, ...chunk }));
  }
  let first = Infinity;
  let last = -1;
  for (const change of changes) {
    let start = layout.findIndex((block) => block.to >= change.fromA);
    if (start < 0) start = layout.length - 1;
    let end = -1;
    layout.forEach((block, index) => { if (block.from <= change.toA) end = index; });
    if (end < 0) end = 0;
    // A change inside a separator touches the blocks on both sides.
    if (end < start) [start, end] = [end, start];
    first = Math.min(first, start);
    last = Math.max(last, end);
  }
  if (last < 0) return layout.map((block) => ({ ...block, from: mapping.mapPos(block.from, 1), to: mapping.mapPos(block.to, 1) }));
  const from = mapping.mapPos(layout[first].from, -1);
  const to = mapping.mapPos(layout[last].to, 1);
  const lastOld = layout[last];
  const keepTrailing = trailingNewlines(oldText.slice(lastOld.from, lastOld.to));
  const keepTogether = options.keepTogether
    .filter((range) => range.from < to && range.to > from)
    .map((range) => ({ from: Math.max(0, range.from - from), to: Math.min(to, range.to) - from }));
  const chunks = splitSpan(newText.slice(from, to), keepTogether, keepTrailing)
    .map((chunk) => ({ from: chunk.from + from, to: chunk.to + from, markdown: newText.slice(chunk.from + from, chunk.to + from) }));
  const oldBlocks = layout.slice(first, last + 1).map((block) => ({ ...block, markdown: oldText.slice(block.from, block.to) }));
  const reflowed = assignBlockIds(oldBlocks, chunks, mapping);
  // Blocks before the change keep their positions; blocks after it only shift.
  const after = layout.slice(last + 1).map((block) => ({ id: block.id, from: mapping.mapPos(block.from, 1), to: mapping.mapPos(block.to, 1) }));
  return [...layout.slice(0, first).map((block) => ({ id: block.id, from: block.from, to: block.to })), ...reflowed, ...after];
}

/**
 * The selection as offsets in one block's Markdown. A selection across blocks
 * is reported in those blocks joined with a blank line, which is how the text
 * already holds them, with the blocks after the first to join.
 */
export function blockSelection(text: TextSource, layout: ReadonlyArray<LiveBlock>, from: number, to: number) {
  if (!layout.length) return null;
  let first = blockIndexAt(layout, from);
  let last = blockIndexAt(layout, to);
  // A selection that only reaches the start of a block, or starts at the end of one, leaves it out.
  if (last > first && to <= layout[last].from) { last -= 1; to = Math.max(from, layout[last].to); }
  if (last > first && from >= visibleEnd(text, layout[first])) { first += 1; from = Math.min(to, layout[first].from); }
  const head = layout[first];
  const tail = layout[last];
  const start = Math.max(head.from, Math.min(from, head.to));
  const end = Math.max(start, Math.min(to, tail.to));
  return {
    index: first,
    id: head.id,
    markdown: text.slice(head.from, tail.to),
    from: start - head.from,
    to: end - head.from,
    joinBlockIds: layout.slice(first + 1, last + 1).map((block) => block.id),
  };
}
