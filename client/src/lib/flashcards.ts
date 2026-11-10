/**
 * Flashcards written inside documents.
 *
 *   Question :: Answer                 one card
 *   Question ::: Answer                two cards, one each way
 *   Front lines                        a card over several lines: the front, a line
 *   ?                                  holding only `?` (`??` for both ways), then
 *   Back lines                         the back, up to the next blank line
 *   The {{c1::mitochondria}} makes ATP  a cloze card for each c-number
 *
 * Images are ordinary embeds (`![[x.png]]`, `![](Attachments/x.png)`) on either side.
 * A card's id comes from its document and its text, so the same card on another
 * device has the same id; editing the front makes a new id, and
 * {@link relinkFlashcards} carries the old card's history over to it.
 */

export type FlashcardKind = "basic" | "reverse" | "cloze";

export interface Flashcard {
  id: string;
  docId: string;
  kind: FlashcardKind;
  /** Markdown shown first. A cloze front has `[...]` (or its hint) in place of the hidden text. */
  front: string;
  /** Markdown shown after the reveal. */
  back: string;
  /** The cloze number, for cloze cards. */
  cloze?: number;
  /** A cloze card's paragraph as written, with every {{c…}} in it (for export). */
  source?: string;
  /** The card's position among the document's cards of its kind, used to keep history across edits. */
  ordinal: number;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/u;
const LIST_PREFIX = /^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/u;
const CLOZE = /\{\{c(\d{1,3})::([\s\S]*?)(?:::([^{}]*?))?\}\}/gu;

/** A short, stable id: 53-bit hash in base 36. */
export function flashcardHash(text: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();

function cardId(docId: string, kind: FlashcardKind, key: string, cloze?: number) {
  return `${flashcardHash(`${docId}\u0000${kind}\u0000${normalize(key)}${cloze ? `\u0000${cloze}` : ""}`)}`;
}

/** `{{c1::text::hint}}` → front shows `[hint]`/`[...]` for the asked number, plain text for others. */
export function clozeSides(text: string, number: number): { front: string; back: string } {
  const front = text.replace(CLOZE, (_match, n: string, hidden: string, hint?: string) =>
    Number(n) === number ? `**[${hint?.trim() || "..."}]**` : hidden);
  const back = text.replace(CLOZE, (_match, n: string, hidden: string) => (Number(n) === number ? `**${hidden}**` : hidden));
  return { front, back };
}

export function clozeNumbers(text: string): number[] {
  const numbers = new Set<number>();
  for (const match of text.matchAll(CLOZE)) if (Number(match[1]) > 0) numbers.add(Number(match[1]));
  return [...numbers].sort((a, b) => a - b);
}

/** Split `front :: back` (or `:::`). Spaces are required around the marker, so `std::io` is not a card. */
function splitInline(line: string): { front: string; back: string; both: boolean } | null {
  const match = /^(.*?\S)\s+(:{2,3})\s+(\S.*)$/u.exec(line);
  if (!match) return null;
  // Inline code holding the marker isn't a card.
  if ((match[1].match(/`/gu)?.length ?? 0) % 2 === 1) return null;
  return { front: match[1].trim(), back: match[3].trim(), both: match[2].length === 3 };
}

/** The lines of a document's Markdown that are outside fenced code. */
function proseParagraphs(markdown: string): string[][] {
  const paragraphs: string[][] = [];
  let current: string[] = [];
  let fence: string | null = null;
  const flush = () => { if (current.length) paragraphs.push(current); current = []; };
  for (const line of markdown.split(/\r?\n/u)) {
    const opener = FENCE.exec(line)?.[1];
    if (fence) {
      if (opener && opener[0] === fence[0] && opener.length >= fence.length && !line.trim().slice(opener.length)) fence = null;
      continue;
    }
    if (opener) { flush(); fence = opener; continue; }
    if (!line.trim()) { flush(); continue; }
    current.push(line);
  }
  flush();
  return paragraphs;
}

/** Every card written in this Markdown. */
export function parseFlashcards(docId: string, markdown: string): Flashcard[] {
  const cards: Flashcard[] = [];
  const ordinals: Record<FlashcardKind, number> = { basic: 0, reverse: 0, cloze: 0 };
  const seen = new Set<string>();
  const add = (kind: FlashcardKind, key: string, front: string, back: string, cloze?: number, source?: string) => {
    if (!front.trim() || !back.trim()) return;
    const id = cardId(docId, kind, key, cloze);
    if (seen.has(id)) return; // the same card written twice is one card
    seen.add(id);
    cards.push({ id, docId, kind, front, back, ...(cloze ? { cloze } : {}), ...(source ? { source } : {}), ordinal: ordinals[kind]++ });
  };
  const addPair = (front: string, back: string, both: boolean) => {
    add("basic", front, front, back);
    if (both) add("reverse", back, back, front);
  };

  for (const paragraph of proseParagraphs(markdown)) {
    const separator = paragraph.findIndex((line) => /^\s*\?{1,2}\s*$/u.test(line));
    if (separator > 0 && separator < paragraph.length - 1) {
      const front = paragraph.slice(0, separator).join("\n").trim();
      const back = paragraph.slice(separator + 1).join("\n").trim();
      addPair(front, back, paragraph[separator].trim() === "??");
      continue;
    }
    const text = paragraph.join("\n");
    const numbers = clozeNumbers(text);
    if (numbers.length) {
      const body = paragraph.map((line) => line.replace(LIST_PREFIX, "")).join("\n").trim();
      for (const number of numbers) {
        const sides = clozeSides(body, number);
        add("cloze", body, sides.front, sides.back, number, body);
      }
      continue;
    }
    for (const line of paragraph) {
      const inline = splitInline(line.replace(LIST_PREFIX, "").replace(/^\s*>\s?/u, ""));
      if (inline) addPair(inline.front, inline.back, inline.both);
    }
  }
  return cards;
}

/** Cards in a document made of several Markdown blocks. */
export function parseDocumentFlashcards(docId: string, blocks: ReadonlyArray<{ content: string }>): Flashcard[] {
  return parseFlashcards(docId, blocks.map((block) => block.content).join("\n\n"));
}

const words = (text: string) => new Set(normalize(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));

function similarity(a: string, b: string) {
  const left = words(a), right = words(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared);
}

/**
 * When a card's text was edited, its id changed. Pair each card that disappeared
 * from a document with the new card that replaced it, so its history carries over:
 * the most similar new card of the same kind, or the one in the same position.
 * Returns new id → old id.
 */
export function relinkFlashcards(
  removed: ReadonlyArray<Pick<Flashcard, "id" | "kind" | "front" | "back" | "ordinal" | "cloze">>,
  added: ReadonlyArray<Pick<Flashcard, "id" | "kind" | "front" | "back" | "ordinal" | "cloze">>,
): Map<string, string> {
  const pairs = new Map<string, string>();
  const free = new Set(added.map((card) => card.id));
  for (const old of removed) {
    let best: string | null = null, bestScore = 0;
    for (const card of added) {
      if (!free.has(card.id) || card.kind !== old.kind || (card.cloze ?? 0) !== (old.cloze ?? 0)) continue;
      const score = Math.max(similarity(old.front, card.front), similarity(old.back, card.back) * 0.9) + (card.ordinal === old.ordinal ? 0.3 : 0);
      if (score > bestScore) { best = card.id; bestScore = score; }
    }
    if (best && bestScore >= 0.5) { pairs.set(best, old.id); free.delete(best); }
  }
  return pairs;
}
