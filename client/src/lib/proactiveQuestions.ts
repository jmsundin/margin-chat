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

/**
 * The paragraph the user just finished, if it is theirs, long enough, and hasn't been asked about.
 * `notedBlockIds` are the blocks that already carry a margin note.
 */
export function pickProactivePassage(conversation: Conversation, asked: ReadonlySet<string>, notedBlockIds: ReadonlySet<string> = new Set()): ProactivePassage | null {
  const blocks = getEditableDocument(conversation).blocks;
  const userWritten = (index: number) => getDocumentBlockAuthorship(blocks[index], conversation.messages) === "user";
  let latest = -1;
  blocks.forEach((block, index) => {
    if (!userWritten(index) || !block.content.trim()) return;
    if (latest < 0 || block.updatedAt > blocks[latest].updatedAt) latest = index;
  });
  if (latest < 0 || notedBlockIds.has(blocks[latest].id)) return null;
  const content = blocks[latest].content;
  // The last paragraph of the block, without its heading marks, and not so long the note covers a page.
  const end = content.trimEnd().length;
  const paragraphStart = content.lastIndexOf("\n\n", end - 1);
  let from = paragraphStart < 0 ? 0 : paragraphStart + 2;
  while (from < end && /\s/.test(content[from])) from += 1;
  const marks = /^(?:#{1,6}[ \t]+|[-*+][ \t]+|\d+[.)][ \t]+|>[ \t]*)/.exec(content.slice(from));
  if (marks) from += marks[0].length;
  if (end - from > MAX_PASSAGE_CHARS) from = end - MAX_PASSAGE_CHARS;
  if (end - from < MIN_PASSAGE_CHARS) return null;
  const sectionKey = `${conversation.id}:${blocks[latest].id}:${paragraphStart < 0 ? 0 : paragraphStart}`;
  if (asked.has(sectionKey)) return null;
  return { sectionKey, blockId: blocks[latest].id, from, to: end, quote: content.slice(from, end), sourceContent: content };
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
