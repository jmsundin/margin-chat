import type { Conversation } from "../types";
import { getDocumentBlockAuthorship } from "@margin-chat/workspace-contracts";
import { getEditableDocument } from "./editableDocument";
import type { AIStance } from "./notebookPrefs";

/**
 * Thinks with you: when the user presses Enter after a line or paragraph of their own, the AI reads
 * it with the rest of the note and puts one question in the margin beside it. At most one per
 * paragraph, never on text the AI wrote, and never on a paragraph that already has a note.
 */

/** Shorter than this and a line is too thin to question ("Notes", "Todo"). */
const MIN_PASSAGE_CHARS = 12;
const MAX_PASSAGE_CHARS = 900;

export interface ProactivePassage {
  /** The paragraph's place: document, block and where it starts. One question per key per session. */
  sectionKey: string;
  blockId: string;
  from: number;
  to: number;
  quote: string;
  sourceContent: string;
}

/** A passage that already has a margin note: its block and, when known, where in the block. */
export interface NotedPassage { blockId: string; from?: number; to?: number }

/** Where the caret was when the user pressed Enter: a block and an offset in its Markdown. */
export interface EnterCaret { blockId: string; offset: number }

const LINE_MARKS = /^(?:#{1,6}[ \t]+|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+|>[ \t]*)/;
/** A line that is a passage of its own: a list item or a heading. */
const OWN_LINE = /^[ \t]*(?:[-*+][ \t]+|\d+[.)][ \t]+|#{1,6}[ \t]+)/;

/**
 * The unit around `offset` in a block: one list item when the caret is on a list line, otherwise
 * the paragraph (lines between blank lines, stopping at list items and headings) it sits in.
 */
function unitAround(content: string, offset: number) {
  const lineStart = (at: number) => content.lastIndexOf("\n", at - 1) + 1;
  const lineEnd = (at: number) => { const next = content.indexOf("\n", at); return next < 0 ? content.length : next; };
  let from = lineStart(Math.min(offset, content.length));
  // Enter on an empty line (a list's next marker, or a blank line) finishes the line above it.
  while (from > 0 && !content.slice(from, lineEnd(from)).replace(LINE_MARKS, "").trim()) from = lineStart(from - 1);
  let to = lineEnd(from);
  if (!OWN_LINE.test(content.slice(from, to))) {
    while (from > 0) {
      const previous = lineStart(from - 1), text = content.slice(previous, from - 1);
      if (!text.trim() || OWN_LINE.test(text)) break;
      from = previous;
    }
    while (to < content.length) {
      const text = content.slice(to + 1, lineEnd(to + 1));
      if (!text.trim() || OWN_LINE.test(text)) break;
      to = lineEnd(to + 1);
    }
  }
  return { from, to };
}

/**
 * The paragraph the user just finished, if it is theirs, long enough, and hasn't been asked about.
 * With `caret` (where Enter was pressed) it is the line or list item there, so Enter on bullet 2
 * questions bullet 2 alone; without it, the last line or paragraph of the block edited most recently.
 * `noted` are passages that already carry a margin note.
 */
export function pickProactivePassage(conversation: Conversation, asked: ReadonlySet<string>, noted: readonly NotedPassage[] = [], caret?: EnterCaret): ProactivePassage | null {
  const blocks = getEditableDocument(conversation).blocks;
  const userWritten = (index: number) => getDocumentBlockAuthorship(blocks[index], conversation.messages) === "user";
  let latest = -1;
  if (caret) {
    latest = blocks.findIndex((block) => block.id === caret.blockId);
    if (latest >= 0 && (!userWritten(latest) || !blocks[latest].content.trim())) return null;
  }
  if (latest < 0) blocks.forEach((block, index) => {
    if (!userWritten(index) || !block.content.trim()) return;
    if (latest < 0 || block.updatedAt > blocks[latest].updatedAt) latest = index;
  });
  if (latest < 0) return null;
  const blockId = blocks[latest].id;
  const content = blocks[latest].content;
  const unit = unitAround(content, caret?.blockId === blockId ? caret.offset : content.trimEnd().length);
  const start = unit.from, end = start + content.slice(start, unit.to).trimEnd().length;
  let from = start;
  // Without its heading, list or quote marks, and not so long the note covers a page.
  while (from < end && /\s/.test(content[from])) from += 1;
  const marks = LINE_MARKS.exec(content.slice(from));
  if (marks) from += marks[0].length;
  if (end - from > MAX_PASSAGE_CHARS) from = end - MAX_PASSAGE_CHARS;
  if (end - from < MIN_PASSAGE_CHARS) return null;
  // A note anywhere on this passage (or on the whole block, when its place isn't known) means it was already asked about.
  if (noted.some((note) => note.blockId === blockId && (note.from === undefined || note.to === undefined || (note.from < end && note.to > from)))) return null;
  const sectionKey = `${conversation.id}:${blockId}:${start}`;
  if (asked.has(sectionKey)) return null;
  return { sectionKey, blockId, from, to: end, quote: content.slice(from, end), sourceContent: content };
}

const STANCE_LINES: Record<AIStance, string> = {
  supportive: " Be on my side: ask what would make the strongest version of this idea even better supported.",
  neutral: "",
  antagonistic: " Take the opposite side, as a sharp sceptic would: press on the weakest assumption.",
};

/** The Question this prompt in the stance the user chose. */
export function stanceQuestionPrompt(base: string, stance: AIStance): string {
  return base + STANCE_LINES[stance];
}
