import { writeSyncedSetting } from "./interfaceSettings";
import { plainReadingText } from "./languageLearning";

/**
 * The interactive reader for Language learning mode: a document's text as words
 * that each show how well the reader knows them, phrases laid over the words,
 * and pages short enough to read in one sitting.
 */

/** How well a term is known: -1 ignored, 0 new (never rated), 1–3 learning, 4 familiar, 5 known. */
export type TermStatus = -1 | 0 | 1 | 2 | 3 | 4 | 5;

export interface LanguageTerm {
  language: string;
  /** The word or phrase, lowercased; a phrase has single spaces between its words. */
  key: string;
  meaning: string;
  status: TermStatus;
  tags: string[];
  /** Documents the term was rated or given a meaning in. */
  docIds: string[];
  createdAt: string;
  updatedAt: string;
}

export const MAX_PHRASE_WORDS = 8;
export const termId = (language: string, key: string) => `${language}\n${key}`;

/** A word as terms are keyed: lowercase, one composed form, no punctuation around it. */
export function termKey(text: string): string {
  return text.normalize("NFC").toLocaleLowerCase().replace(/[^\p{L}\p{M}\p{N}'’\s-]+/gu, " ").replace(/’/gu, "'").replace(/\s+/gu, " ").trim();
}

export interface ReaderToken { text: string; /** Set on words; punctuation and spaces have none. */ key?: string; word?: number }
export interface ReaderSentence { index: number; text: string; tokens: ReaderToken[]; words: number }
export interface ReaderParagraph { id: string; blockId: string; heading: 0 | 1 | 2 | 3; sentences: ReaderSentence[] }

const WORDISH = /[\p{L}\p{M}\p{N}]/u;

/** Text split into words and what lies between them. Languages written without spaces use the browser's word breaker. */
export function tokenize(text: string, language?: string): ReaderToken[] {
  const tokens: ReaderToken[] = [];
  let word = 0;
  const push = (part: string, isWord: boolean) => {
    if (!part) return;
    if (isWord) tokens.push({ text: part, key: termKey(part), word: word++ });
    else if (tokens.length && tokens[tokens.length - 1].key === undefined) tokens[tokens.length - 1].text += part;
    else tokens.push({ text: part });
  };
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    let pending = "";
    // Joined by an apostrophe or hyphen (l'eau, grand-mère) is one word to a learner; the browser splits some of these.
    const parts = [...new Intl.Segmenter(language, { granularity: "word" }).segment(text)];
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      // Not `isWordLike`: some engines (older Safari among them) say no for a word with a digit in it.
      const wordLike = WORDISH.test(part.segment);
      if (wordLike) { pending += part.segment; continue; }
      const next = parts[index + 1];
      if (pending && /^['’-]$/u.test(part.segment) && next && WORDISH.test(next.segment)) { pending += part.segment; continue; }
      push(pending, true); pending = "";
      push(part.segment, false);
    }
    push(pending, true);
    return tokens;
  }
  const pattern = /[\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+)*/gu;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    push(text.slice(last, match.index), false);
    push(match[0], true);
    last = match.index + match[0].length;
  }
  push(text.slice(last), false);
  return tokens;
}

function sentencesOf(text: string, language?: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return [...new Intl.Segmenter(language, { granularity: "sentence" }).segment(text)].map((part) => part.segment).filter((part) => part.trim());
  }
  return text.match(/[^.!?。！？]+[.!?。！？]*["”»')\]]*\s*/gu)?.filter((part) => part.trim()) ?? [text];
}

/**
 * A document's Markdown blocks as paragraphs of sentences of tokens. Code,
 * tables, pictures and embeds aren't reading text and are left out.
 */
export function readerParagraphs(blocks: ReadonlyArray<{ id: string; content: string }>, language?: string): ReaderParagraph[] {
  const paragraphs: ReaderParagraph[] = [];
  let sentence = 0;
  for (const block of blocks) {
    let fenced = false;
    let part = 0;
    let lines: string[] = [];
    const flush = (heading: 0 | 1 | 2 | 3 = 0) => {
      const text = plainReadingText(lines.join(" "));
      lines = [];
      if (!text || !WORDISH.test(text)) return;
      const sentences = sentencesOf(text, language).map((value) => {
        const tokens = tokenize(value, language);
        return { index: sentence++, text: value.trim(), tokens, words: tokens.filter((token) => token.key !== undefined).length };
      });
      paragraphs.push({ id: `${block.id}:${part++}`, blockId: block.id, heading, sentences });
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
      if (/^([-*+]|\d+[.)])\s+/u.test(trimmed)) { flush(); lines = [trimmed]; flush(); continue; }
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
