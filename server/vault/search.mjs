/** Projected sources searched for passages, each answered separately. */
export const PASSAGE_SOURCES = ["documents", "messages", "notes"];

const MAX_TERMS = 8;
const MAX_TERM_LENGTH = 64;
const SNIPPET_BEFORE = 60;
const SNIPPET_LENGTH = 180;

const fold = (value) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Words of a query, case-folded. Every term must appear for a result to match. */
export function vaultSearchTerms(query) {
  if (typeof query !== "string") return [];
  return [...new Set(query.normalize("NFC").toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    .map((term) => term.slice(0, MAX_TERM_LENGTH)))].slice(0, MAX_TERMS);
}

/** Case-insensitive SQL LIKE patterns, one per term. */
export const likePatterns = (terms) => terms.map((term) => `%${term.replace(/[\\%_]/gu, "\\$&")}%`);

/** Whether a title contains every term, ignoring case and accents. */
export function titleMatcher(terms) {
  const folded = terms.map(fold);
  return (title) => {
    const value = fold(title);
    return folded.every((term) => value.includes(term));
  };
}

/**
 * The passage around the first term found in `text`. `start` and `end` are
 * character offsets of the match in `text`; `match` is its range in `snippet`.
 */
export function passageSnippet(text, terms) {
  if (typeof text !== "string" || !text) return null;
  let found = null;
  for (const term of terms) {
    const match = new RegExp(escapeRegExp(term), "iu").exec(text);
    if (match && (!found || match.index < found.start)) found = { start: match.index, end: match.index + match[0].length };
  }
  if (!found) return null;
  let from = Math.max(0, found.start - SNIPPET_BEFORE);
  let to = Math.min(text.length, from + SNIPPET_LENGTH);
  // Start and end on word boundaries where one is near.
  if (from > 0) {
    const space = text.slice(from, found.start).search(/\s/u);
    if (space >= 0) from += space + 1;
  }
  if (to < text.length) {
    const space = text.slice(found.end, to).lastIndexOf(" ");
    if (space >= 0) to = found.end + space;
  }
  const raw = text.slice(from, to);
  const leading = raw.length - raw.trimStart().length;
  const snippet = raw.trim().replace(/\s+/gu, " ");
  const prefix = from > 0 ? "…" : "";
  // Collapsing whitespace before the match shifts its offset in the snippet.
  const before = text.slice(from + leading, found.start).replace(/\s+/gu, " ");
  const matchStart = prefix.length + before.length;
  return {
    snippet: `${prefix}${snippet}${to < text.length ? "…" : ""}`,
    match: { start: matchStart, end: matchStart + (found.end - found.start) },
    start: found.start, end: found.end,
  };
}
