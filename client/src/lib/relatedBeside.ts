/**
 * Beside what you're writing (concept B of "Brainstorm gentle reminders from the vault"): while the
 * person writes, an older note of theirs that is about the same thing comes up once, quietly, with
 * the words the two share. It is chosen by what is being written, never at random.
 * On the device, with no AI: word weights (TF-IDF) over the person's own words in notes not edited
 * for three weeks or more, compared with the passage being written.
 */
import { isCompactDocument, type AppState, type Conversation } from "@margin-chat/workspace-contracts";
import { plainText, ownPassages, describeAge, MIN_UNSEEN_DAYS, type RediscoverLog } from "./rediscover";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Words a note is compared on; the rest of a long note adds little. */
const MAX_TERMS_PER_NOTE = 1500;
/** How alike the passage and a note must be (cosine of word weights). */
export const RELATED_MIN_SCORE = 0.16;
/** And how many meaningful words they must share, so one rare word can't carry it. */
export const RELATED_MIN_SHARED = 3;
/** The passage needs this many words before it says enough to match on. */
const MIN_QUERY_WORDS = 12;

const STOP = new Set(("about above after again against all also although always among another any are aren't around "
  + "because been before being below between both but can cannot could did does doing don't down during each even every few "
  + "for from further had has have having here hers herself him himself his how however into its itself just least less like "
  + "made make many may maybe might more most much must myself near need never not now off often once one only other others our "
  + "ours out over own per perhaps quite rather really same seem seemed seems shall she should since some something still such "
  + "than that the their theirs them themselves then there these they thing things this those though through thus too toward "
  + "under until upon very was wasn't way well were weren't what when where whether which while who whom whose why will with "
  + "within without would yet you your yours yourself week weeks today time times good better best first last next new "
  + "want wants think thought know knew going goes went come came use used using said says lot lots little").split(" "));

/** A light stem, so "doses" and "dose" or "studies" and "study" meet. */
function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 6 && /(ing|ed)$/.test(word)) return word.replace(/(ing|ed)$/, "");
  if (word.length > 4 && word.endsWith("s") && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

export function terms(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []) {
    const word = raw.replace(/'s$/, "").replace(/^-+|-+$/g, "");
    if (word.length < 4 || STOP.has(word) || /^\d+$/.test(word)) continue;
    out.push(stem(word));
    if (out.length >= MAX_TERMS_PER_NOTE) break;
  }
  return out;
}

interface IndexedNote { id: string; title: string; seenAt: number; weights: Map<string, number>; norm: number; display: Map<string, string> }
export interface RelatedIndex { notes: IndexedNote[]; idf: Map<string, number>; builtAt: number; size: number }

/** Older notes' word weights. Rebuild when the vault grows or every few minutes; old notes rarely change. */
export function buildRelatedIndex(state: Pick<AppState, "conversations">, now: number): RelatedIndex {
  const conversations = Object.values(state.conversations);
  const docs: { id: string; title: string; seenAt: number; counts: Map<string, number>; display: Map<string, string> }[] = [];
  const df = new Map<string, number>();
  for (const conversation of conversations) {
    if (conversation.noteChat || isCompactDocument(conversation)) continue;
    const seenAt = Date.parse(conversation.updatedAt) || 0;
    const counts = new Map<string, number>();
    const display = new Map<string, string>();
    const text = `${conversation.title}\n${ownPassages(conversation).map((p) => plainText(p.content)).join("\n")}`;
    const words = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
    for (const word of terms(text)) counts.set(word, (counts.get(word) ?? 0) + 1);
    for (const word of words) { const [stem] = terms(word); if (stem && !display.has(stem)) display.set(stem, word); }
    for (const term of counts.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    // Every note counts toward how common a word is; only older ones can be suggested.
    if ((now - seenAt) / DAY_MS >= MIN_UNSEEN_DAYS && counts.size >= 5) docs.push({ id: conversation.id, title: conversation.title.trim() || "Untitled", seenAt, counts, display });
  }
  const total = Math.max(1, conversations.length);
  const idf = new Map<string, number>();
  for (const [term, count] of df) idf.set(term, Math.log(1 + total / count));
  const notes = docs.map(({ id, title, seenAt, counts, display }) => {
    const weights = new Map<string, number>();
    let sum = 0;
    for (const [term, count] of counts) {
      const weight = (1 + Math.log(count)) * (idf.get(term) ?? 0);
      weights.set(term, weight);
      sum += weight * weight;
    }
    return { id, title, seenAt, weights, norm: Math.sqrt(sum) || 1, display };
  });
  return { notes, idf, builtAt: now, size: conversations.length };
}

export interface RelatedPick { id: string; title: string; shared: string[]; lastEdited: string | null; score: number }

/** Dates before this are placeholders for "unknown". */
const KNOWN_DATES_FROM = Date.parse("2000-01-01T00:00:00Z");

/**
 * The older note most about the passage being written, or null when none is close enough.
 * `exclude` holds the document itself and what it already links to; `log` drops notes the person
 * asked Rediscover to stop showing.
 */
export function findRelatedNote({ index, passage, exclude, log, now }: {
  index: RelatedIndex; passage: string; exclude: ReadonlySet<string>; log?: RediscoverLog; now: number;
}): RelatedPick | null {
  const words = terms(passage);
  if (words.length < MIN_QUERY_WORDS) return null;
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  const query = new Map<string, number>();
  let sum = 0;
  for (const [term, count] of counts) {
    const weight = (1 + Math.log(count)) * (index.idf.get(term) ?? Math.log(1 + index.size));
    query.set(term, weight);
    sum += weight * weight;
  }
  const norm = Math.sqrt(sum) || 1;
  let best: RelatedPick | null = null;
  for (const note of index.notes) {
    if (exclude.has(note.id)) continue;
    const entry = log?.notes[note.id];
    if (entry && entry.gap < 0) continue;
    let dot = 0;
    const shared: [string, number][] = [];
    for (const [term, weight] of query) {
      const other = note.weights.get(term);
      if (!other) continue;
      dot += weight * other;
      shared.push([term, weight * other]);
    }
    if (shared.length < RELATED_MIN_SHARED) continue;
    const score = dot / (norm * note.norm);
    if (score < RELATED_MIN_SCORE || (best && score <= best.score)) continue;
    best = {
      id: note.id, title: note.title, score,
      shared: shared.sort((a, b) => b[1] - a[1]).slice(0, 3).map(([term]) => note.display.get(term) ?? term),
      lastEdited: note.seenAt > KNOWN_DATES_FROM ? describeAge(Math.floor((now - note.seenAt) / DAY_MS)) : null,
    };
  }
  return best;
}

/** The passage being written: the most recently changed part of the document, with what's just before it. */
export function currentPassage(conversation: Conversation): string {
  const blocks = conversation.document?.blocks ?? [];
  if (!blocks.length) return ownPassages(conversation).map((p) => p.content).join("\n").slice(-1200);
  let latest = 0;
  for (let i = 1; i < blocks.length; i += 1) if ((Date.parse(blocks[i].updatedAt) || 0) >= (Date.parse(blocks[latest].updatedAt) || 0)) latest = i;
  return plainText(blocks.slice(Math.max(0, latest - 1), latest + 1).map((block) => block.content).join("\n")).slice(-1200);
}

/** Documents this one already points at or is pointed at by, which need no reminder. */
export function alreadyConnected(conversation: Conversation, state: Pick<AppState, "conversations">): Set<string> {
  const ids = new Set<string>([conversation.id]);
  if (conversation.parentId) ids.add(conversation.parentId);
  for (const id of conversation.childIds) ids.add(id);
  for (const id of conversation.linkedConversationIds ?? []) ids.add(id);
  for (const relation of conversation.relations ?? []) if (relation.targetConversationId) ids.add(relation.targetConversationId);
  for (const link of conversation.document?.links ?? []) ids.add(link.targetConversationId);
  const text = (conversation.document?.blocks ?? []).map((block) => block.content).join("\n");
  const titles = new Set([...text.matchAll(/\[\[([^\]|#]+)/g)].map((match) => match[1].trim().toLowerCase()));
  if (titles.size) for (const other of Object.values(state.conversations)) if (titles.has(other.title.trim().toLowerCase())) ids.add(other.id);
  for (const other of Object.values(state.conversations)) {
    if (other.linkedConversationIds?.includes(conversation.id) || other.document?.links?.some((link) => link.targetConversationId === conversation.id)) ids.add(other.id);
  }
  return ids;
}
