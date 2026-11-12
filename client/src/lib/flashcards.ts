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
 *   :::card                            a card whose sides may hold blank lines, lists,
 *   Front                              code or images, with `?` (or `??`) between them;
 *   ?                                  without one, a block holding {{c1::…}} is a cloze
 *   Back
 *   :::
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

interface SourceLine { text: string; from: number; to: number }
type Paragraph = { kind: "prose"; lines: SourceLine[] } | { kind: "card"; lines: SourceLine[]; from: number; to: number };

const CARD_OPEN = /^\s{0,3}:::\s*card\s*$/iu;
const CARD_CLOSE = /^\s{0,3}:::\s*$/u;
const SEPARATOR = /^\s*\?{1,2}\s*$/u;

function sourceLines(markdown: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let from = 0;
  for (const raw of markdown.split("\n")) {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    lines.push({ text, from, to: from + text.length });
    from += raw.length + 1;
  }
  return lines;
}

/** The index of the line closing a code fence opened by `opener`, or -1. */
function fenceEnd(lines: SourceLine[], start: number, opener: string) {
  for (let index = start; index < lines.length; index++) {
    const close = FENCE.exec(lines[index].text)?.[1];
    if (close && close[0] === opener[0] && close.length >= opener.length && !lines[index].text.trim().slice(close.length)) return index;
  }
  return -1;
}

/** Lines between `:::card` and `:::` (skipping fenced code inside), or null when the block isn't closed. */
function cardBlockEnd(lines: SourceLine[], start: number) {
  for (let index = start; index < lines.length; index++) {
    const opener = FENCE.exec(lines[index].text)?.[1];
    if (opener) { const end = fenceEnd(lines, index + 1, opener); if (end < 0) return -1; index = end; continue; }
    if (CARD_CLOSE.test(lines[index].text)) return index;
  }
  return -1;
}

/** The document's paragraphs outside fenced code, and its `:::card` blocks. */
function proseParagraphs(markdown: string): Paragraph[] {
  const lines = sourceLines(markdown);
  const paragraphs: Paragraph[] = [];
  let current: SourceLine[] = [];
  const flush = () => { if (current.length) paragraphs.push({ kind: "prose", lines: current }); current = []; };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (CARD_OPEN.test(line.text)) {
      const end = cardBlockEnd(lines, index + 1);
      if (end >= 0) {
        flush();
        paragraphs.push({ kind: "card", lines: lines.slice(index + 1, end), from: line.from, to: lines[end].to });
        index = end;
        continue;
      }
    }
    const opener = FENCE.exec(line.text)?.[1];
    if (opener) {
      flush();
      const end = fenceEnd(lines, index + 1, opener);
      index = end < 0 ? lines.length : end;
      continue;
    }
    if (!line.text.trim()) { flush(); continue; }
    current.push(line);
  }
  flush();
  return paragraphs;
}

/**
 * Where a card is written, as offsets in the Markdown it was read from, and what it says
 * in the direction it was written: a two-way card's source is its first direction.
 */
export type FlashcardSource =
  | { format: "inline" | "lines" | "block"; from: number; to: number; front: string; back: string; both: boolean; cardIds: string[] }
  | { format: "cloze" | "cloze-block"; from: number; to: number; text: string; cardIds: string[] };

/** Every card written in this Markdown, with where each is written. */
export function parseFlashcardSources(docId: string, markdown: string): { cards: Flashcard[]; sources: FlashcardSource[] } {
  const cards: Flashcard[] = [];
  const sources: FlashcardSource[] = [];
  const ordinals: Record<FlashcardKind, number> = { basic: 0, reverse: 0, cloze: 0 };
  const seen = new Set<string>();
  const add = (ids: string[], kind: FlashcardKind, key: string, front: string, back: string, cloze?: number, source?: string) => {
    if (!front.trim() || !back.trim()) return;
    const id = cardId(docId, kind, key, cloze);
    if (seen.has(id)) return; // the same card written twice is one card
    seen.add(id);
    ids.push(id);
    cards.push({ id, docId, kind, front, back, ...(cloze ? { cloze } : {}), ...(source ? { source } : {}), ordinal: ordinals[kind]++ });
  };
  const addPair = (format: "inline" | "lines" | "block", from: number, to: number, front: string, back: string, both: boolean) => {
    const ids: string[] = [];
    add(ids, "basic", front, front, back);
    if (both) add(ids, "reverse", back, back, front);
    if (ids.length) sources.push({ format, from, to, front, back, both, cardIds: ids });
  };
  const addCloze = (format: "cloze" | "cloze-block", from: number, to: number, body: string) => {
    const ids: string[] = [];
    for (const number of clozeNumbers(body)) {
      const sides = clozeSides(body, number);
      add(ids, "cloze", body, sides.front, sides.back, number, body);
    }
    if (ids.length) sources.push({ format, from, to, text: body, cardIds: ids });
  };

  for (const paragraph of proseParagraphs(markdown)) {
    const { lines } = paragraph;
    if (paragraph.kind === "card") {
      // Inside a card block the first `?` line outside code splits the sides; blank lines and code are allowed.
      let separator = -1;
      for (let index = 0; index < lines.length; index++) {
        const opener = FENCE.exec(lines[index].text)?.[1];
        if (opener) { const end = fenceEnd(lines, index + 1, opener); index = end < 0 ? lines.length : end; continue; }
        if (SEPARATOR.test(lines[index].text)) { separator = index; break; }
      }
      const text = (part: SourceLine[]) => part.map((line) => line.text).join("\n").trim();
      if (separator >= 0) addPair("block", paragraph.from, paragraph.to, text(lines.slice(0, separator)), text(lines.slice(separator + 1)), lines[separator].text.trim() === "??");
      else if (clozeNumbers(text(lines)).length) addCloze("cloze-block", paragraph.from, paragraph.to, text(lines));
      continue;
    }
    const from = lines[0].from, to = lines[lines.length - 1].to;
    const separator = lines.findIndex((line) => SEPARATOR.test(line.text));
    if (separator > 0 && separator < lines.length - 1) {
      const front = lines.slice(0, separator).map((line) => line.text).join("\n").trim();
      const back = lines.slice(separator + 1).map((line) => line.text).join("\n").trim();
      addPair("lines", from, to, front, back, lines[separator].text.trim() === "??");
      continue;
    }
    const text = lines.map((line) => line.text).join("\n");
    if (clozeNumbers(text).length) {
      const body = lines.map((line) => line.text.replace(LIST_PREFIX, "")).join("\n").trim();
      // A one-line cloze keeps its list bullet when rewritten.
      const prefix = lines.length === 1 ? (LIST_PREFIX.exec(lines[0].text)?.[0].length ?? 0) : 0;
      addCloze("cloze", from + prefix, to, body);
      continue;
    }
    for (const line of lines) {
      const stripped = line.text.replace(LIST_PREFIX, "").replace(/^\s*>\s?/u, "");
      const inline = splitInline(stripped);
      if (!inline) continue;
      // The card's own text, after any bullet or quote mark.
      const start = line.text.length - stripped.length;
      addPair("inline", line.from + start, line.to, inline.front, inline.back, inline.both);
    }
  }
  return { cards, sources };
}

/** Every card written in this Markdown. */
export function parseFlashcards(docId: string, markdown: string): Flashcard[] {
  return parseFlashcardSources(docId, markdown).cards;
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
