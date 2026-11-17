import { writeSyncedSetting } from "./interfaceSettings";
import { isPlayable, parseMediaEmbed, parseTimestampLine } from "./documentMedia";
import { plainReadingText } from "./languageLearning";
import { splitSentences, termKey as sharedTermKey, tokenizeWords } from "@margin-chat/workspace-contracts/languageCourses";

/**
 * The interactive reader for Language learning mode: a document's text as words
 * that each show how well the reader knows them, phrases laid over the words,
 * and pages short enough to read in one sitting.
 */

/** How well a term is known: -1 ignored, 0 new (never rated), 1–3 learning, 4 familiar, 5 known. */
export type TermStatus = -1 | 0 | 1 | 2 | 3 | 4 | 5;

export type MeaningSource = "" | "user" | "wiktionary" | "google" | "deepl" | "ai";

export interface LanguageTerm {
  language: string;
  /** The word or phrase, lowercased; a phrase has single spaces between its words. */
  key: string;
  meaning: string;
  /** Where the meaning came from: typed by the reader, or picked from a dictionary, a machine translation or the AI. */
  source?: MeaningSource;
  status: TermStatus;
  tags: string[];
  /** Documents the term was rated or given a meaning in. */
  docIds: string[];
  /** The sentence the meaning was saved from, shown with the word in Review. */
  fragment?: string;
  /** When the word next comes up in Review (an FSRS card), once it has been reviewed. */
  srs?: TermSchedule | null;
  createdAt: string;
  updatedAt: string;
}

/** A word's review schedule, the same card state flashcards keep. */
export interface TermSchedule { state: "new" | "learning" | "review" | "relearning"; due: number; stability: number; difficulty: number; reps: number; lapses: number; lastReview: number | null; /** Learning step reached, while learning. */ step?: number }

export const MAX_PHRASE_WORDS = 8;
export const termId = (language: string, key: string) => `${language}\n${key}`;

/** A word as terms are keyed: lowercase, one composed form, no punctuation around it. Shared with the server's lesson tokenizer. */
export const termKey: (text: string) => string = sharedTermKey;

export interface ReaderToken { text: string; /** Set on words; punctuation and spaces have none. */ key?: string; word?: number }
export interface ReaderSentence { index: number; text: string; tokens: ReaderToken[]; words: number }
export interface ReaderParagraph {
  id: string; blockId: string; heading: 0 | 1 | 2 | 3; sentences: ReaderSentence[];
  /** In a lesson with a recording: the second this line starts at. */
  time?: number;
}

const WORDISH = /[\p{L}\p{M}\p{N}]/u;

/** Text split into words and what lies between them; the same cut the server makes of a lesson, so a word's key matches. */
export const tokenize: (text: string, language?: string) => ReaderToken[] = tokenizeWords;

const sentencesOf = (text: string, language?: string): string[] => splitSentences(text, language);

/**
 * A document's Markdown blocks as paragraphs of sentences of tokens. Code,
 * tables, pictures and embeds aren't reading text and are left out.
 */
export function readerParagraphs(blocks: ReadonlyArray<{ id: string; content: string }>, language?: string): ReaderParagraph[] {
  const paragraphs: ReaderParagraph[] = [];
  let sentence = 0;
  // In a document with a recording, a list line that starts with a time is what is said from then on.
  const recorded = blocks.some((block) => { const embed = /^\s*!\[/u.test(block.content) ? parseMediaEmbed(block.content.trim().split("\n")[0]) : null; return Boolean(embed && isPlayable(embed.kind)); });
  for (const block of blocks) {
    let fenced = false;
    let part = 0;
    let lines: string[] = [];
    const flush = (heading: 0 | 1 | 2 | 3 = 0, time?: number) => {
      const text = plainReadingText(lines.join(" "));
      lines = [];
      if (!text || !WORDISH.test(text)) return;
      const sentences = sentencesOf(text, language).map((value) => {
        const tokens = tokenize(value, language);
        return { index: sentence++, text: value.trim(), tokens, words: tokens.filter((token) => token.key !== undefined).length };
      });
      paragraphs.push({ id: `${block.id}:${part++}`, blockId: block.id, heading, sentences, ...(time !== undefined ? { time } : {}) });
    };
    for (const line of block.content.split("\n")) {
      if (/^\s*(```|~~~)/u.test(line)) { flush(); fenced = !fenced; continue; }
      if (fenced) continue;
      const trimmed = line.trim();
      if (!trimmed) { flush(); continue; }
      // Tables, pictures, embeds, rules and HTML are not text to read word by word.
      if (/^\|.*\|$/u.test(trimmed) || /^!\[/u.test(trimmed) || /^!\[\[/u.test(trimmed) || /^(-{3,}|\*{3,}|_{3,})$/u.test(trimmed) || /^<[a-z!/]/iu.test(trimmed)) { flush(); continue; }
      const heading = /^(#{1,6})\s+/u.exec(trimmed);
      if (heading) { flush(); lines = [trimmed]; flush(Math.min(3, heading[1].length) as 1 | 2 | 3); continue; }
      // Each list item is its own line to read.
      if (/^([-*+]|\d+[.)])\s+/u.test(trimmed)) {
        flush();
        const stamp = recorded ? parseTimestampLine(trimmed) : null;
        if (stamp?.note) { lines = [stamp.note]; flush(0, stamp.seconds); } else { lines = [trimmed]; flush(); }
        continue;
      }
      lines.push(trimmed);
    }
    flush();
  }
  return paragraphs;
}

export interface PhraseMatch { from: number; length: number; key: string }

/** The saved phrases in a sentence's words; where phrases overlap, the longest wins. */
export function findPhrases(wordKeys: ReadonlyArray<string>, isPhrase: (key: string) => boolean): PhraseMatch[] {
  const found: PhraseMatch[] = [];
  for (let from = 0; from < wordKeys.length; from++) {
    for (let length = Math.min(MAX_PHRASE_WORDS, wordKeys.length - from); length >= 2; length--) {
      const key = wordKeys.slice(from, from + length).join(" ");
      if (!isPhrase(key)) continue;
      found.push({ from, length, key });
      from += length - 1;
      break;
    }
  }
  return found;
}

/** Paragraphs gathered into pages of about `target` words; a page ends between paragraphs, and a heading starts with its text. */
export function paginate(paragraphs: ReadonlyArray<ReaderParagraph>, target = 300): ReaderParagraph[][] {
  const pages: ReaderParagraph[][] = [];
  let page: ReaderParagraph[] = [];
  let words = 0;
  const count = (paragraph: ReaderParagraph) => paragraph.sentences.reduce((sum, sentence) => sum + sentence.words, 0);
  paragraphs.forEach((paragraph, index) => {
    const size = count(paragraph);
    const headingAlone = paragraph.heading > 0 && words + size + (paragraphs[index + 1] ? count(paragraphs[index + 1]) : 0) > target * 1.3;
    if (page.length && (words + size > target * 1.3 || (headingAlone && words > target * 0.5))) { pages.push(page); page = []; words = 0; }
    page.push(paragraph);
    words += size;
    if (words >= target && paragraph.heading === 0) { pages.push(page); page = []; words = 0; }
  });
  if (page.length) pages.push(page);
  return pages.length ? pages : [[]];
}

export const isLearning = (status: number) => status >= 1 && status <= 3;
/** Terms the arrow keys stop at: the ones with a colour or underline of their own. */
export const isMarked = (status: number) => status >= 1 && status <= 4;

export const STATUS_LABELS: Record<TermStatus, string> = { "-1": "Ignored", 0: "New", 1: "Learning 1", 2: "Learning 2", 3: "Learning 3", 4: "Familiar", 5: "Known" };

export interface ReaderLook { theme: "system" | "paper" | "white" | "mint" | "navy" | "black"; size: number; font: number }
export const READER_THEMES: ReadonlyArray<{ id: ReaderLook["theme"]; name: string }> = [
  { id: "system", name: "App" }, { id: "paper", name: "Paper" }, { id: "white", name: "White" }, { id: "mint", name: "Mint" }, { id: "navy", name: "Navy" }, { id: "black", name: "Black" },
];
export const READER_SIZES = [15, 16, 17, 19, 21, 23, 26, 29];
export const READER_FONTS: ReadonlyArray<{ name: string; stack: string }> = [
  { name: "Reading", stack: "var(--reading-font, Georgia, serif)" },
  { name: "Georgia", stack: "Georgia, 'Times New Roman', serif" },
  { name: "Palatino", stack: "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', serif" },
  { name: "System", stack: "system-ui, -apple-system, 'Segoe UI', sans-serif" },
  { name: "Helvetica", stack: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  { name: "Verdana", stack: "Verdana, 'DejaVu Sans', sans-serif" },
  { name: "Rounded", stack: "ui-rounded, 'SF Pro Rounded', 'Hiragino Maru Gothic ProN', 'Nunito', system-ui, sans-serif" },
];
export const DEFAULT_READER_LOOK: ReaderLook = { theme: "system", size: 4, font: 0 };
const LOOK_KEY = "margin-chat:language-reader:look" as const;

export function normalizeReaderLook(value: unknown): ReaderLook {
  const look = value && typeof value === "object" ? value as Partial<ReaderLook> : {};
  return {
    theme: READER_THEMES.some((theme) => theme.id === look.theme) ? look.theme as ReaderLook["theme"] : DEFAULT_READER_LOOK.theme,
    size: Number.isInteger(look.size) && (look.size as number) >= 1 && (look.size as number) <= READER_SIZES.length ? look.size as number : DEFAULT_READER_LOOK.size,
    font: Number.isInteger(look.font) && (look.font as number) >= 0 && (look.font as number) < READER_FONTS.length ? look.font as number : DEFAULT_READER_LOOK.font,
  };
}
export function loadReaderLook(): ReaderLook {
  try { return normalizeReaderLook(JSON.parse(localStorage.getItem(LOOK_KEY) ?? "null")); } catch { return { ...DEFAULT_READER_LOOK }; }
}
export function saveReaderLook(look: ReaderLook) {
  // Saved to the account too, so the reader looks the same on every device.
  writeSyncedSetting(LOOK_KEY, JSON.stringify(look));
}
