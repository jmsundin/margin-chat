/**
 * Rediscover: once a day at most, when the app opens, one older note that seems to matter
 * comes back as a small card (thread "Brainstorm gentle reminders from the vault", concept A).
 * Nothing is sent as a notification. The timing adapts to the person's answers:
 * - "Glad I saw this" (or Open): it comes back later, each gap longer than the last.
 * - "Not now": it comes back in two weeks, with the gap it had.
 * - "Stop showing": it never comes back.
 * - No answer (the card closes by itself or with ×): back in a week, and after three cards in a
 *   row go unanswered, cards come every few days instead of daily.
 * The choice is made on the device from what the vault already knows (links to the note, margin
 * notes on it, how much the person wrote, when it was last opened or edited), so no AI is used.
 * Answers and the on/off switch are saved to the account, so every device agrees.
 */
import { isCompactDocument, type AppState, type Conversation } from "@margin-chat/workspace-contracts";
import { onSyncedSettingChange, writeSyncedSetting } from "./interfaceSettings";
import { getStandaloneNote } from "./standaloneNotes";

export const REDISCOVER_ON_KEY = "margin-chat:rediscover";
export const REDISCOVER_LOG_KEY = "margin-chat:rediscover-log";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A note seen or edited more recently than this is still fresh. */
export const MIN_UNSEEN_DAYS = 21;
const FIRST_GLAD_GAP = 30;
const MAX_GAP = 365;
const NOT_NOW_DAYS = 14;
const IGNORED_DAYS = 7;
/** After this many unanswered cards in a row, cards come less often. */
const IGNORE_STREAK = 3;
const SLOW_EVERY_DAYS = 4;
/** The synced value is capped at 4000 characters; this many entries fit with room to spare. */
const MAX_ENTRIES = 60;
/** Dates before this are placeholders for "unknown", not real edits. */
const KNOWN_DATES_FROM = Date.parse("2000-01-01T00:00:00Z");

export type RediscoverAnswer = "open" | "glad" | "notNow" | "stop" | "ignored";

/** One note's schedule: the day (since 1970) it may come back, and the last gap in days (-1 = never again). */
export interface RediscoverEntry { due: number; gap: number }
export interface RediscoverLog {
  /** The day the last card was shown. */
  shown: number;
  /** Unanswered cards in a row. */
  ignored: number;
  notes: Record<string, RediscoverEntry>;
}

export interface RediscoverPick {
  id: string;
  title: string;
  excerpt: string;
  blockId?: string;
  /** Plain reasons, most telling first: "6 notes link to it". Empty when it is just an older note of the person's own. */
  reasons: string[];
  /** "9 weeks ago", or null when the note's dates aren't known. */
  lastSeen: string | null;
}

export const dayNumber = (time: number) => Math.floor(time / DAY_MS);

export function parseRediscoverLog(raw: string | null): RediscoverLog {
  const empty: RediscoverLog = { shown: 0, ignored: 0, notes: {} };
  if (!raw) return empty;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object") return empty;
    const notes: Record<string, RediscoverEntry> = {};
    const stored = value.n && typeof value.n === "object" ? value.n as Record<string, unknown> : {};
    for (const [id, entry] of Object.entries(stored)) {
      if (!Array.isArray(entry)) continue;
      const [due, gap] = entry;
      if (Number.isFinite(due) && Number.isFinite(gap)) notes[id] = { due: Number(due), gap: Number(gap) };
    }
    return {
      shown: Number.isFinite(value.s) ? Number(value.s) : 0,
      ignored: Number.isFinite(value.i) ? Number(value.i) : 0,
      notes,
    };
  } catch {
    return empty;
  }
}

export function serializeRediscoverLog(log: RediscoverLog): string {
  let entries = Object.entries(log.notes);
  if (entries.length > MAX_ENTRIES) {
    // "Stop showing" is kept the longest; of the rest, the ones due soonest go first.
    entries = entries.sort(([, a], [, b]) => (a.gap < 0 ? 1 : 0) - (b.gap < 0 ? 1 : 0) || a.due - b.due)
      .slice(entries.length - MAX_ENTRIES);
  }
  return JSON.stringify({ s: log.shown, i: log.ignored, n: Object.fromEntries(entries.map(([id, e]) => [id, [e.due, e.gap]])) });
}

/** The log after an answer to the card about `id`, given on `today`. */
export function applyRediscoverAnswer(log: RediscoverLog, id: string, answer: RediscoverAnswer, today: number): RediscoverLog {
  const previous = log.notes[id];
  const lastGap = previous && previous.gap > 0 ? previous.gap : 0;
  let entry: RediscoverEntry;
  if (answer === "stop") entry = { due: Number.MAX_SAFE_INTEGER, gap: -1 };
  else if (answer === "glad" || answer === "open") {
    const gap = lastGap ? Math.min(MAX_GAP, Math.round(lastGap * 2.5)) : FIRST_GLAD_GAP;
    entry = { due: today + gap, gap };
  } else if (answer === "notNow") entry = { due: today + NOT_NOW_DAYS, gap: lastGap };
  else entry = { due: today + IGNORED_DAYS, gap: lastGap };
  return {
    shown: log.shown,
    ignored: answer === "ignored" ? log.ignored + 1 : 0,
    notes: { ...log.notes, [id]: entry },
  };
}

/** Whether a card may be shown today at all. */
export function rediscoverDueToday(log: RediscoverLog, today: number): boolean {
  if (log.shown >= today) return false;
  if (log.ignored >= IGNORE_STREAK && today - log.shown < SLOW_EVERY_DAYS) return false;
  return true;
}

const WIKI_LINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

/** Markdown reduced to readable words for a short excerpt. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n?/, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function excerptOf(text: string, max = 220): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sentence = cut.search(/[.!?](?=\s)[^.!?]*$/);
  if (sentence > 80) return cut.slice(0, sentence + 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 80 ? cut.lastIndexOf(" ") : max).trimEnd()}…`;
}

export function describeAge(days: number): string {
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  const years = Math.round(days / 365);
  return years === 1 ? "a year ago" : `${years} years ago`;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * The passages the person wrote themselves: document blocks they wrote or edited (imports and AI
 * text alone don't count), or the body of a Markdown note that hasn't been opened in the editor yet.
 */
function ownPassages(conversation: Conversation): { id?: string; content: string }[] {
  const blocks = conversation.document?.blocks;
  if (blocks?.length) {
    return blocks.filter((block) => block.authorship === "user" || block.authorship === "mixed"
      || (!block.authorship && !block.origin && !block.generationId));
  }
  const body = getStandaloneNote(conversation)?.content ?? "";
  return body.trim() ? body.split(/\n{2,}/).map((content) => ({ content })) : [];
}

/** A small, stable variety: the same day gives the same order, another day may not. */
function jitter(id: string, today: number): number {
  let hash = today * 2654435761;
  for (let i = 0; i < id.length; i += 1) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return ((hash >>> 0) % 1000) / 1000;
}

/**
 * The note to bring back today, or null when nothing is ready. "Seen" is the last edit on any
 * device, plus `opened` when given. This device's record of opened documents is not passed by
 * the app: it also lists every document downloaded here, so on a new device everything would look
 * just seen.
 */
export function pickRediscoverNote({ state, opened = new Map(), log, now, skipIds = [] }: {
  state: Pick<AppState, "conversations">;
  opened?: Map<string, number>;
  log: RediscoverLog;
  now: number;
  skipIds?: readonly string[];
}): RediscoverPick | null {
  const today = dayNumber(now);
  const conversations = Object.values(state.conversations);
  const byTitle = new Map<string, string>();
  for (const conversation of conversations) {
    const title = conversation.title.trim().toLowerCase();
    if (title && !byTitle.has(title)) byTitle.set(title, conversation.id);
  }

  // Who points at whom: connections, typed relations, passage links and [[wiki links]].
  const incoming = new Map<string, Set<string>>();
  const point = (from: string, to: string | undefined) => {
    if (!to || to === from) return;
    const set = incoming.get(to) ?? new Set<string>();
    set.add(from);
    incoming.set(to, set);
  };
  for (const conversation of conversations) {
    for (const id of conversation.linkedConversationIds ?? []) point(conversation.id, id);
    for (const relation of conversation.relations ?? []) point(conversation.id, relation.targetConversationId);
    for (const link of conversation.document?.links ?? []) point(conversation.id, link.targetConversationId);
    const passages = conversation.document?.blocks?.length ? conversation.document.blocks : ownPassages(conversation);
    for (const block of passages) {
      for (const match of block.content.matchAll(WIKI_LINK)) point(conversation.id, byTitle.get(match[1].trim().toLowerCase()));
    }
  }
  const isNoteOn = (conversation: Conversation) => isCompactDocument(conversation);
  const marginNotes = new Map<string, number>();
  for (const conversation of conversations) {
    if (conversation.parentId && isNoteOn(conversation)) marginNotes.set(conversation.parentId, (marginNotes.get(conversation.parentId) ?? 0) + 1);
  }

  let best: { score: number; pick: RediscoverPick } | null = null;
  for (const conversation of conversations) {
    if (skipIds.includes(conversation.id) || conversation.noteChat || isNoteOn(conversation)) continue;
    const entry = log.notes[conversation.id];
    if (entry && (entry.gap < 0 || entry.due > today)) continue;
    const titleText = conversation.title.trim().toLowerCase();
    const ownBlocks = ownPassages(conversation)
      .filter((block) => { const text = plainText(block.content); return text && text.toLowerCase() !== titleText; });
    const ownText = ownBlocks.map((block) => plainText(block.content));
    const ownLength = ownText.join(" ").length;
    if (ownLength < 60) continue;

    const seenAt = Math.max(opened.get(conversation.id) ?? 0, Date.parse(conversation.updatedAt) || 0);
    const unseenDays = Math.floor((now - seenAt) / DAY_MS);
    if (unseenDays < MIN_UNSEEN_DAYS) continue;

    const links = incoming.get(conversation.id)?.size ?? 0;
    const notes = marginNotes.get(conversation.id) ?? 0;
    const glad = entry && entry.gap > 0;
    const importance = 1 + links * 2 + notes * 1.5 + Math.min(3, Math.log10(1 + ownLength) - 1)
      + Math.min(2, conversation.childIds.length * 0.5) + (glad ? 3 : 0);
    // Older is more worth a reminder, up to about a year.
    const age = Math.min(1, unseenDays / 120) + 0.3;
    const score = importance * age * (0.85 + jitter(conversation.id, today) * 0.3);
    if (best && score <= best.score) continue;

    const reasons: string[] = [];
    if (glad) reasons.push("you were glad to see it last time");
    if (links) reasons.push(`${plural(links, "note")} ${links === 1 ? "links" : "link"} to it`);
    if (notes) reasons.push(`you wrote ${plural(notes, "margin note")} on it`);
    const firstOwn = ownBlocks.find((block) => plainText(block.content).length >= 40) ?? ownBlocks[0];
    best = {
      score,
      pick: {
        id: conversation.id,
        title: conversation.title.trim() || "Untitled",
        excerpt: excerptOf(plainText(firstOwn.content)),
        blockId: firstOwn.id,
        reasons,
        lastSeen: seenAt > KNOWN_DATES_FROM ? describeAge(unseenDays) : null,
      },
    };
  }
  return best?.pick ?? null;
}

// Saved state, shared with every device through the account.

const listeners = new Set<() => void>();

export function readRediscoverOn(): boolean {
  try { return localStorage.getItem(REDISCOVER_ON_KEY) !== "false"; } catch { return true; }
}

export function saveRediscoverOn(on: boolean) {
  writeSyncedSetting(REDISCOVER_ON_KEY, String(on));
  listeners.forEach((listener) => listener());
}

export function subscribeRediscoverOn(listener: () => void): () => void {
  listeners.add(listener);
  const stop = onSyncedSettingChange([REDISCOVER_ON_KEY], listener);
  return () => { listeners.delete(listener); stop(); };
}

export function readRediscoverLog(): RediscoverLog {
  try { return parseRediscoverLog(localStorage.getItem(REDISCOVER_LOG_KEY)); } catch { return parseRediscoverLog(null); }
}

export function saveRediscoverLog(log: RediscoverLog) {
  writeSyncedSetting(REDISCOVER_LOG_KEY, serializeRediscoverLog(log));
}
