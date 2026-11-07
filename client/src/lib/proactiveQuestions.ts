import type { Conversation } from "../types";
import { getDocumentBlockAuthorship } from "@margin-chat/workspace-contracts";
import { getEditableDocument } from "./editableDocument";
import type { AIStance } from "./notebookPrefs";

/**
 * The AI asks on its own (Customise → "AI asks questions": On). After the user stops writing for a
 * while, it may post one question in the margin beside the paragraph they just wrote, at most once
 * per section of the document while the page stays open, and never on text it wrote itself.
 */

/** How long the user's last edit must sit before the AI asks. */
export const PROACTIVE_IDLE_MS = 20_000;
/** At least this much of the user's own writing in a section before a question is worth asking. */
const MIN_SECTION_CHARS = 100;
const MIN_PASSAGE_CHARS = 60;
const MAX_PASSAGE_CHARS = 900;

export interface ProactivePassage {
  /** Where this passage sits: the document and the heading above it. One question per key per session. */
  sectionKey: string;
  blockId: string;
  from: number;
  to: number;
  quote: string;
  sourceContent: string;
}

const HEADING = /^#{1,6}[ \t]+(.+)$/m;

/**
 * The paragraph the user most recently wrote, if its section has had no question yet this session
 * and holds enough of their own words. Blocks the AI wrote, or empty ones, never count.
 */
export function pickProactivePassage(conversation: Conversation, asked: ReadonlySet<string>): ProactivePassage | null {
  const blocks = getEditableDocument(conversation).blocks;
  let section = "top";
  const sections = blocks.map((block) => {
    const heading = /^\s*#{1,6}[ \t]+(.+)$/.exec(block.content.split("\n")[0] ?? "") ?? HEADING.exec(block.content);
    if (heading) section = heading[1].trim().toLowerCase();
    return section;
  });
  const userWritten = (index: number) => getDocumentBlockAuthorship(blocks[index], conversation.messages) === "user";
  let latest = -1;
  blocks.forEach((block, index) => {
    if (!userWritten(index) || block.content.trim().length < MIN_PASSAGE_CHARS) return;
    if (latest < 0 || block.updatedAt > blocks[latest].updatedAt) latest = index;
  });
  if (latest < 0) return null;
  const sectionKey = `${conversation.id}:${sections[latest]}`;
  if (asked.has(sectionKey)) return null;
  const sectionChars = blocks.reduce((sum, block, index) => sections[index] === sections[latest] && userWritten(index) ? sum + block.content.trim().length : sum, 0);
  if (sectionChars < MIN_SECTION_CHARS) return null;
  const content = blocks[latest].content;
  // The last paragraph of the block, without a heading line, and not so long the note covers a page.
  const paragraphStart = content.lastIndexOf("\n\n", content.trimEnd().length - 1);
  let from = paragraphStart < 0 ? 0 : paragraphStart + 2;
  const firstLine = content.slice(from).split("\n")[0];
  if (/^\s*#{1,6}[ \t]/.test(firstLine)) from += firstLine.length + 1;
  while (from < content.length && /\s/.test(content[from])) from += 1;
  let to = content.trimEnd().length;
  if (to - from > MAX_PASSAGE_CHARS) from = to - MAX_PASSAGE_CHARS;
  if (to - from < MIN_PASSAGE_CHARS) return null;
  return { sectionKey, blockId: blocks[latest].id, from, to, quote: content.slice(from, to), sourceContent: content };
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
