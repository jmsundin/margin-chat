import { createHash } from "node:crypto";

/**
 * Splitting saved documents into passages for search by keyword and by meaning.
 *
 * A source's first passage is its title and opening, exactly the text its topic
 * embedding is made from (server/documents/topics.mjs), so one embedding serves
 * both. The rest of the text follows in passages that start at headings where
 * it can, each labelled with the headings it sits under.
 */

/** Characters of a source's opening; the same as the topic embedding's. */
export const LEAD_CHARACTERS = 2_000;
/** Most characters indexed from one source. */
export const MAX_SOURCE_CHARACTERS = 400_000;
const TARGET_CHARACTERS = 2_000;
const MAX_CHARACTERS = 2_400;
const OVERLAP_CHARACTERS = 240;
const MAX_HEADING_CHARACTERS = 300;

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/u;
const FENCE = /^[ \t]{0,3}(```|~~~)/u;

export const md5 = (value) => createHash("md5").update(value).digest("hex");

/** The exact text sent for a passage's embedding. */
export function passageEmbeddingInput({ title, heading, content }) {
  return `${title}\n\n${heading ? `${heading}\n\n` : ""}${content}`.trim();
}

/** Heading lines in `text` with their offsets, skipping fenced code. */
function headingsIn(text) {
  const found = [];
  let fenced = false;
  let offset = 0;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    else if (!fenced) {
      const match = HEADING.exec(line);
      if (match) found.push({ offset, level: match[1].length, text: match[2].trim().slice(0, MAX_HEADING_CHARACTERS) });
    }
    offset += line.length + 1;
  }
  return found;
}

/** The heading path in force at `offset`, such as "Setup › Install". */
function headingPathAt(headings, offset) {
  const stack = [];
  for (const heading of headings) {
    if (heading.offset > offset) break;
    while (stack.length && stack.at(-1).level >= heading.level) stack.pop();
    stack.push(heading);
  }
  return stack.map((heading) => heading.text).join(" › ").slice(0, MAX_HEADING_CHARACTERS) || null;
}

/** Where a passage starting at `start` should end: a paragraph, line, sentence or word break near `limit`. */
function breakBefore(text, start, limit) {
  if (limit >= text.length) return text.length;
  const floor = start + Math.floor((limit - start) * 0.6);
  for (const separator of ["\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " "]) {
    const index = text.lastIndexOf(separator, limit - separator.length);
    if (index >= floor) return index + separator.length;
  }
  return limit;
}

/**
 * Passage ranges over `text` from `from`: a new passage starts at each heading
 * once the current one is long enough, and a long section is cut at breaks
 * with a little overlap so no sentence is lost between two passages.
 */
function passageRanges(text, from, headings) {
  const starts = headings.map((heading) => heading.offset).filter((offset) => offset > from);
  const ranges = [];
  let start = from;
  while (start < text.length) {
    const nextHeading = starts.find((offset) => offset > start && offset - start >= TARGET_CHARACTERS / 2);
    let end;
    if (nextHeading !== undefined && nextHeading - start <= MAX_CHARACTERS) end = nextHeading;
    else end = breakBefore(text, start, Math.min(text.length, start + TARGET_CHARACTERS));
    if (end <= start) end = Math.min(text.length, start + TARGET_CHARACTERS);
    ranges.push({ start, end });
    if (end >= text.length) break;
    // Overlap only when cutting inside a section; a heading starts cleanly.
    start = starts.includes(end) ? end : Math.max(start + 1, breakBefore(text, Math.max(start + 1, end - OVERLAP_CHARACTERS), end));
    if (start >= end) start = end;
  }
  return ranges;
}

/**
 * Passages of one saved document, note or chat. `body` is its AI-readable text
 * and `lead` the opening its topic embedding uses (a prefix of `body`). For an
 * editable document, `blocks` (its block ids and contents, in order) lets each
 * passage name the block it starts in.
 */
export function buildSourcePassages({ title, body, lead, blocks = null, topicHash = null }) {
  const text = String(body ?? "");
  if (!text.trim()) return [];
  const shared = typeof lead === "string" && lead.trim() !== "" && text.startsWith(lead);
  const opening = shared ? lead : text.slice(0, LEAD_CHARACTERS);
  const headings = headingsIn(text);
  // Block offsets, when the blocks join to exactly this text.
  let blockStarts = null;
  if (Array.isArray(blocks)) {
    const contents = blocks.filter((block) => typeof block?.content === "string");
    if (contents.map((block) => block.content).join("\n\n") === text) {
      let offset = 0;
      blockStarts = contents.map((block) => {
        const entry = { id: typeof block.id === "string" ? block.id : null, offset };
        offset += block.content.length + 2;
        return entry;
      });
    }
  }
  const blockAt = (offset) => {
    if (!blockStarts) return null;
    let found = null;
    for (const entry of blockStarts) {
      if (entry.offset > offset) break;
      found = entry;
    }
    return found?.id ?? null;
  };
  const passages = [{ index: 0, heading: null, content: opening, charStart: 0, blockId: blockAt(0), topicHash: shared ? topicHash : null }];
  if (text.length > opening.length) {
    // Start the rest at a clean break inside the opening, so the two overlap a little.
    const from = breakBefore(text, Math.floor(opening.length * 0.7), opening.length);
    for (const range of passageRanges(text, from, headings)) {
      const raw = text.slice(range.start, range.end);
      const content = raw.trim();
      if (!content) continue;
      const charStart = range.start + (raw.length - raw.trimStart().length);
      passages.push({ index: passages.length, heading: headingPathAt(headings, charStart), content, charStart, blockId: blockAt(charStart), topicHash: null });
    }
  }
  return withHashes(title, passages);
}

/** Passages of an uploaded file, from its extracted and chunked text. */
export function buildFilePassages({ title, chunks }) {
  return withHashes(title, chunks.map((chunk, index) => ({
    index, heading: chunk.pageNumber ? `Page ${chunk.pageNumber}` : null, content: chunk.content,
    charStart: 0, blockId: null, pageNumber: chunk.pageNumber ?? null, topicHash: null,
  })));
}

/** Adds each passage's content hash and drops exact repeats within one source. */
function withHashes(title, passages) {
  const seen = new Set();
  const result = [];
  for (const passage of passages) {
    const contentHash = md5(passageEmbeddingInput({ title, heading: passage.heading, content: passage.content }));
    if (seen.has(contentHash)) continue;
    seen.add(contentHash);
    result.push({ ...passage, index: result.length, title, contentHash });
  }
  return result;
}
