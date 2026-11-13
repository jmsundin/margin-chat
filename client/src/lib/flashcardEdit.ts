import { parseFlashcardSources, type Flashcard, type FlashcardSource } from "./flashcards";

/**
 * Editing a card from Review or Browse rewrites the text it is written in, in its document.
 *
 * A card is edited in the direction it was written: a two-way card shows its first side as
 * the front. The new text is written in the plainest form that holds it: `Front :: Back` on
 * one line, `Front` / `?` / `Back` lines, or a card block when a side has blank lines or code:
 *
 *   :::card
 *   Front, with paragraphs, lists, code or images
 *   ?
 *   Back
 *   :::
 */

export type FlashcardDraft =
  | { kind: "pair"; front: string; back: string; both: boolean }
  | { kind: "cloze"; text: string };

interface BlockLike { id: string; content: string; updatedAt?: string }

const SEPARATOR = "\n\n";

function sourceOf(sources: FlashcardSource[], cardId: string) {
  return sources.find((source) => source.cardIds.includes(cardId)) ?? null;
}

function draftOf(source: FlashcardSource): FlashcardDraft {
  if ("text" in source) return { kind: "cloze", text: source.text };
  return { kind: "pair", front: source.front, back: source.back, both: source.both };
}

/** What the editor opens with for this card, or null when it isn't written in these blocks. */
export function flashcardDraftFor(docId: string, blocks: ReadonlyArray<BlockLike>, cardId: string): FlashcardDraft | null {
  const { sources } = parseFlashcardSources(docId, blocks.map((block) => block.content).join(SEPARATOR));
  const source = sourceOf(sources, cardId);
  return source ? draftOf(source) : null;
}

const clean = (text: string) => text.replace(/\r\n?/gu, "\n").replace(/[ \t]+$/gmu, "").trim();

function sameDraft(a: FlashcardDraft, b: FlashcardDraft) {
  if (a.kind === "cloze" || b.kind === "cloze") return a.kind === "cloze" && b.kind === "cloze" && clean(a.text) === clean(b.text);
  return clean(a.front) === clean(b.front) && clean(a.back) === clean(b.back) && a.both === b.both;
}

/** Why this draft can't be saved, or null. */
export function flashcardDraftProblem(draft: FlashcardDraft): string | null {
  if (draft.kind === "cloze") {
    return /\{\{c\d{1,3}::[\s\S]+?\}\}/u.test(draft.text) ? null : "Hide at least one part with {{c1::…}}.";
  }
  if (!clean(draft.front)) return "Write a front.";
  if (!clean(draft.back)) return "Write a back.";
  return null;
}

/** The draft as document text, in the plainest form that reads back as the same card. */
export function formatFlashcard(draft: FlashcardDraft): string | null {
  const candidates = draft.kind === "cloze"
    ? [clean(draft.text), `:::card\n${clean(draft.text)}\n:::`]
    : (() => {
      const front = clean(draft.front), back = clean(draft.back);
      const mark = draft.both ? "??" : "?";
      return [`${front} ${draft.both ? ":::" : "::"} ${back}`, `${front}\n${mark}\n${back}`, `:::card\n${front}\n${mark}\n${back}\n:::`];
    })();
  for (const text of candidates) {
    const { sources } = parseFlashcardSources("check", text);
    if (sources.length === 1 && sources[0].from === 0 && sources[0].to === text.length && sameDraft(draftOf(sources[0]), draft)) return text;
  }
  return null;
}

export type FlashcardEditResult<Block extends BlockLike = BlockLike> =
  | {
    blocks: Block[];
    /** Every card in the document after the edit. */
    cards: Flashcard[];
    /** New card id → the id it replaces, so its review history carries over. */
    links: Map<string, string>;
    /** Old card id → its new id, for the cards of the edited text that are still there. */
    renamed: Map<string, string>;
  }
  | { error: string };

const cardKey = (card: Pick<Flashcard, "kind" | "cloze">) => `${card.kind}:${card.cloze ?? 0}`;

/**
 * Write `draft` in place of the card's text. Only the block(s) holding the card change;
 * the first keeps its id, and a card that ran across blocks becomes one block.
 */
export function applyFlashcardEdit<Block extends BlockLike>(
  docId: string,
  blocks: ReadonlyArray<Block>,
  cardId: string,
  draft: FlashcardDraft,
  options: { now?: string; touch?: (block: Block, content: string) => Block } = {},
): FlashcardEditResult<Block> {
  const problem = flashcardDraftProblem(draft);
  if (problem) return { error: problem };
  const markdown = blocks.map((block) => block.content).join(SEPARATOR);
  const before = parseFlashcardSources(docId, markdown);
  const source = sourceOf(before.sources, cardId);
  if (!source) return { error: "This card was changed or removed in its document. Close it and try again." };
  const text = formatFlashcard(draft);
  if (text === null) return { error: "That can't be written as one card. A line holding only ::: ends a card block." };

  let from = source.from, to = source.to;
  let replacement = text;
  if (text.includes("\n")) {
    // Text over several lines is its own paragraph: it takes the whole line, bullet and all, with blank lines around it.
    from = markdown.lastIndexOf("\n", from - 1) + 1;
    if (from > 0 && !markdown.slice(0, from).endsWith(SEPARATOR)) replacement = `\n${replacement}`;
    if (to < markdown.length && !markdown.slice(to).startsWith(SEPARATOR)) replacement = `${replacement}\n`;
  }
  const insertedAt = from + (replacement.startsWith("\n") ? 1 : 0);

  // The blocks the range touches.
  const starts: number[] = [];
  let offset = 0;
  for (const block of blocks) { starts.push(offset); offset += block.content.length + SEPARATOR.length; }
  const blockAt = (position: number) => {
    for (let index = blocks.length - 1; index >= 0; index--) if (starts[index] <= position) return index;
    return 0;
  };
  const first = blockAt(from), last = blockAt(to);
  const content = blocks[first].content.slice(0, from - starts[first]) + replacement + blocks[last].content.slice(to - starts[last]);
  const now = options.now ?? new Date().toISOString();
  const touch = options.touch ?? ((block: Block, value: string) => ({ ...block, content: value, updatedAt: now }));
  const nextBlocks = [...blocks.slice(0, first), touch(blocks[first], content), ...blocks.slice(last + 1)];

  const after = parseFlashcardSources(docId, nextBlocks.map((block) => block.content).join(SEPARATOR));
  const edited = after.sources.find((candidate) => candidate.from === insertedAt);
  if (!edited) return { error: "That edit wouldn't read back as a card. Nothing was changed." };

  const oldCards = new Map(before.cards.map((card) => [card.id, card]));
  const newCards = new Map(after.cards.map((card) => [card.id, card]));
  const links = new Map<string, string>(), renamed = new Map<string, string>();
  const replacements = new Map(edited.cardIds.map((id) => [cardKey(newCards.get(id)!), id]));
  for (const oldId of source.cardIds) {
    const newId = replacements.get(cardKey(oldCards.get(oldId)!));
    if (!newId) continue;
    renamed.set(oldId, newId);
    if (newId !== oldId) links.set(newId, oldId);
  }
  return { blocks: nextBlocks, cards: after.cards, links, renamed };
}
