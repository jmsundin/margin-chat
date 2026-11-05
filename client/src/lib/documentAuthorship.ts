import { useEffect, useMemo, useRef, useState } from "react";
import { getDocumentBlockAuthorship, type DocumentBlock, type Message } from "@margin-chat/workspace-contracts";
import { apiFetch } from "./apiTransport";

/**
 * Who wrote each line of a document, as the app shows it (spec §9). The server
 * keeps line authorship with every saved revision; this matches it to the
 * lines on screen by their text, so edits not saved yet show as they will be
 * recorded: a new line in an untouched AI block is the model's, any other is
 * yours. Nothing here changes the document.
 */

export type AuthorType = "human" | "ai" | "agent" | "import" | "system" | "unknown";
export interface LineAuthor { type: AuthorType; label: string }
export interface LineOrigin { at: string | null; source: string | null }

export interface AuthorshipView {
  documentId: string;
  tracked: boolean;
  revisionId?: string;
  lastEditedBy?: LineAuthor | null;
  lastEditedAt?: string | null;
  authors: LineAuthor[];
  origins: LineOrigin[];
  blocks: Array<{ id: string; lines: Array<[hash: string, author: number, origin: number]> }>;
}

/** A run of consecutive lines in one block by one author, in Markdown offsets of the block's text. */
export interface AuthorshipRun {
  from: number;
  to: number;
  /** Lines with text in the run. */
  lines: number;
  author: LineAuthor;
  origin: LineOrigin | null;
  mine: boolean;
}

export interface AuthorshipSummary {
  /** Lines with text; blank lines don't count. */
  totalLines: number;
  mineLines: number;
  unknownLines: number;
  lastEditedBy: LineAuthor | null;
}

export type AuthorshipMode = "off" | "mine" | "blame";

const AUTHOR_TYPES = new Set<AuthorType>(["human", "ai", "agent", "import", "system", "unknown"]);
export const LINE_HASH_LENGTH = 16;
export const YOU: LineAuthor = { type: "human", label: "You" };
const UNKNOWN: LineAuthor = { type: "unknown", label: "Unknown" };
/** Lines the agent-edit gate protects: yours, and those whose author nobody knows. */
export const isProtectedAuthor = (author: LineAuthor) => author.type === "human" || author.type === "unknown";

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const readAuthor = (value: unknown): LineAuthor => isRecord(value) && AUTHOR_TYPES.has(value.type as AuthorType)
  ? { type: value.type as AuthorType, label: typeof value.label === "string" && value.label ? value.label.slice(0, 120) : value.type === "human" ? "You" : "Unknown" }
  : UNKNOWN;

/** The server's answer, checked; null when it isn't one. */
export function readAuthorshipView(value: unknown): AuthorshipView | null {
  if (!isRecord(value) || typeof value.documentId !== "string") return null;
  if (value.tracked !== true) return { documentId: value.documentId, tracked: false, authors: [], origins: [], blocks: [] };
  if (!Array.isArray(value.authors) || !Array.isArray(value.origins) || !Array.isArray(value.blocks)) return null;
  const authors = value.authors.map(readAuthor);
  const origins = value.origins.map((origin) => ({
    at: isRecord(origin) && typeof origin.at === "string" ? origin.at : null,
    source: isRecord(origin) && typeof origin.source === "string" ? origin.source : null,
  }));
  const blocks = value.blocks.flatMap((block) => {
    if (!isRecord(block) || typeof block.id !== "string" || !Array.isArray(block.lines)) return [];
    const lines = block.lines.flatMap((line): Array<[string, number, number]> => Array.isArray(line) && typeof line[0] === "string"
      && Number.isInteger(line[1]) && line[1] >= 0 && line[1] < authors.length && Number.isInteger(line[2]) && line[2] < origins.length
      ? [[line[0], line[1], line[2]]] : []);
    return lines.length === block.lines.length ? [{ id: block.id, lines }] : [];
  });
  return {
    documentId: value.documentId, tracked: true,
    ...(typeof value.revisionId === "string" ? { revisionId: value.revisionId } : {}),
    lastEditedBy: isRecord(value.lastEditedBy) ? readAuthor(value.lastEditedBy) : null,
    lastEditedAt: typeof value.lastEditedAt === "string" ? value.lastEditedAt : null,
    authors, origins, blocks,
  };
}

export async function fetchDocumentAuthorship(documentId: string, signal?: AbortSignal): Promise<AuthorshipView | null> {
  const response = await apiFetch(`/api/vault/authorship?${new URLSearchParams({ id: documentId })}`, {
    credentials: "same-origin", cache: "no-store", signal,
  });
  // A vault on this device only, or a plan without cloud storage, has no recorded authorship.
  if (!response.ok) return null;
  return readAuthorshipView(await response.json().catch(() => null));
}

/** Physical lines of a block's Markdown, as the server splits them. */
export function splitLines(text: string) {
  return text.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
}

const hashCache = new Map<string, string>();
export async function lineHash(text: string) {
  const cached = hashCache.get(text);
  if (cached) return cached;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, LINE_HASH_LENGTH);
  if (hashCache.size > 50_000) hashCache.clear();
  hashCache.set(text, hex);
  return hex;
}

export interface MatchedAuthorship {
  runs: Record<string, AuthorshipRun[]>;
  summary: AuthorshipSummary;
}

/**
 * Each block's runs of lines by one author. A line saved in this block keeps
 * its recorded author; one that moved here from another block keeps its own;
 * any other line is new since the last save and belongs to whoever is writing
 * it (`newLineAuthor`).
 */
export function matchAuthorship(blocks: DocumentBlock[], view: AuthorshipView, hashes: ReadonlyMap<string, string>,
  newLineAuthor: (block: DocumentBlock) => LineAuthor): MatchedAuthorship {
  type Entry = { author: number; origin: number; used: boolean };
  const byBlock = new Map<string, Map<string, Entry[]>>();
  const anywhere = new Map<string, Entry[]>();
  for (const block of view.blocks) {
    const map = new Map<string, Entry[]>();
    for (const [hash, author, origin] of block.lines) {
      const entry = { author, origin, used: false };
      if (!map.has(hash)) map.set(hash, []);
      map.get(hash)!.push(entry);
      if (!anywhere.has(hash)) anywhere.set(hash, []);
      anywhere.get(hash)!.push(entry);
    }
    byBlock.set(block.id, map);
  }
  const take = (entries: Entry[] | undefined) => {
    const entry = entries?.find((candidate) => !candidate.used);
    if (entry) entry.used = true;
    return entry;
  };

  // First every line that stayed in its block, then lines that moved between blocks.
  const pending: Array<{ block: DocumentBlock; texts: string[]; found: Array<Entry | null> }> = blocks.map((block) => {
    const texts = splitLines(block.content);
    const own = byBlock.get(block.id);
    return { block, texts, found: texts.map((text) => (own && take(own.get(hashes.get(text) ?? ""))) || null) };
  });
  for (const item of pending) {
    item.found = item.found.map((entry, index) => entry ?? (item.texts[index].trim() ? take(anywhere.get(hashes.get(item.texts[index]) ?? "")) ?? null : null));
  }

  const runs: Record<string, AuthorshipRun[]> = {};
  const summary: AuthorshipSummary = { totalLines: 0, mineLines: 0, unknownLines: 0, lastEditedBy: view.lastEditedBy ?? null };
  for (const { block, texts, found } of pending) {
    const fresh = newLineAuthor(block);
    const blockRuns: AuthorshipRun[] = [];
    let offset = 0;
    texts.forEach((text, index) => {
      const entry = found[index];
      const author = entry ? view.authors[entry.author] ?? UNKNOWN : fresh;
      const origin = entry && entry.origin >= 0 ? view.origins[entry.origin] ?? null : null;
      const filled = text.trim() ? 1 : 0;
      const mine = author.type === "human";
      summary.totalLines += filled;
      if (mine) summary.mineLines += filled;
      if (author.type === "unknown") summary.unknownLines += filled;
      const last = blockRuns.at(-1);
      // A blank line joins the run it sits in rather than starting its own.
      if (last && (sameAuthor(last.author, author) || !filled)) {
        last.to = offset + text.length;
        last.lines += filled;
      } else {
        blockRuns.push({ from: offset, to: offset + text.length, lines: filled, author, origin, mine });
      }
      offset += text.length + 1;
    });
    runs[block.id] = blockRuns.filter((run) => run.lines > 0 || blockRuns.length === 1);
  }
  return { runs, summary };
}

const sameAuthor = (first: LineAuthor, second: LineAuthor) => first.type === second.type && first.label === second.label;

/** One line, factual: "62% written by you · 214 lines · last edited by Muse". */
export function describeSummary(summary: AuthorshipSummary) {
  if (!summary.totalLines) return "";
  const share = Math.round((summary.mineLines / summary.totalLines) * 100);
  const parts = [`${share}% written by you`, `${summary.totalLines} ${summary.totalLines === 1 ? "line" : "lines"}`];
  if (summary.unknownLines) parts.push(`${summary.unknownLines} by unknown`);
  if (summary.lastEditedBy) parts.push(`last edited by ${summary.lastEditedBy.type === "human" ? "you" : summary.lastEditedBy.label}`);
  return parts.join(" · ");
}

/** How long ago a line was written, short enough for the gutter. */
export function describeAge(origin: LineOrigin | null, now = Date.now()) {
  if (!origin?.at) return origin?.source === "backfill" ? "earlier" : "";
  if (origin.source === "backfill") return "earlier";
  const time = Date.parse(origin.at);
  if (!Number.isFinite(time)) return "";
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(days > 330 ? { year: "numeric" } : {}) });
}

/** The tooltip for a run: who and when, in full. */
export function describeRun(run: AuthorshipRun) {
  const who = run.author.type === "human" ? "Written by you" : run.author.type === "unknown" ? "Author unknown (protected like your own lines)" : `Written by ${run.author.label}`;
  if (run.origin?.source === "backfill") return `${who}, before line tracking began`;
  if (!run.origin?.at) return run.origin ? who : `${who}, not saved yet`;
  return `${who} on ${new Date(run.origin.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
}

const MODE_KEY = "margin-chat:authorship-view";
const ONLY_MINE_KEY = "margin-chat:authorship-only-mine";
const readStored = (key: string) => { try { return window.localStorage.getItem(key); } catch { return null; } };
const writeStored = (key: string, value: string) => { try { window.localStorage.setItem(key, value); } catch { /* the choice lasts this visit */ } };

/** Off, Mine or Blame, remembered on this device for every document. */
export function useAuthorshipMode() {
  const [mode, setMode] = useState<AuthorshipMode>(() => {
    const stored = readStored(MODE_KEY);
    return stored === "mine" || stored === "blame" ? stored : "off";
  });
  const [onlyMine, setOnlyMine] = useState(() => readStored(ONLY_MINE_KEY) === "1");
  return {
    mode, onlyMine,
    setMode(next: AuthorshipMode) { setMode(next); writeStored(MODE_KEY, next); },
    setOnlyMine(next: boolean) { setOnlyMine(next); writeStored(ONLY_MINE_KEY, next ? "1" : "0"); },
  };
}

const REFRESH_AFTER_EDIT_MS = 4000;

/**
 * The document's line authorship, matched to its current blocks. Fetched when
 * the document opens and again once edits settle (they're saved by then);
 * null when this vault doesn't record authorship.
 */
export function useDocumentAuthorship(documentId: string, blocks: DocumentBlock[], sourceMessages: ReadonlyArray<Pick<Message, "id" | "role">> | undefined,
  modelLabel: (block: DocumentBlock) => string | null, enabled = true): MatchedAuthorship | null {
  const [view, setView] = useState<AuthorshipView | null>(null);
  const [hashes, setHashes] = useState<ReadonlyMap<string, string>>(new Map());
  const contentKey = useMemo(() => blocks.map((block) => `${block.id}\u0000${block.content}`).join("\u0001"), [blocks]);
  const fetched = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    // The first read happens at once; after an edit, wait for the save to land.
    const delay = fetched.current === documentId ? REFRESH_AFTER_EDIT_MS : 0;
    const timer = window.setTimeout(() => {
      fetchDocumentAuthorship(documentId, controller.signal)
        .then((next) => { fetched.current = documentId; setView(next); })
        .catch(() => undefined);
    }, delay);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [documentId, contentKey, enabled]);
  useEffect(() => { if (fetched.current !== documentId) setView(null); }, [documentId]);

  useEffect(() => {
    if (!enabled || !view) return;
    let cancelled = false;
    const texts = new Set(blocks.flatMap((block) => splitLines(block.content)));
    void Promise.all([...texts].map(async (text) => [text, await lineHash(text)] as const)).then((pairs) => {
      if (!cancelled) setHashes(new Map(pairs));
    }).catch(() => undefined);
    return () => { cancelled = true; };
    // blocks is read through contentKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentKey, view, enabled]);

  return useMemo(() => {
    if (!enabled || !view) return null;
    // Until the first lines are hashed nothing can be matched; after that a line typed since is briefly new, which it is.
    if (view.tracked && !hashes.size && blocks.some((block) => block.content)) return null;
    return matchAuthorship(blocks, view, hashes, (block) => {
      if (getDocumentBlockAuthorship(block, sourceMessages) !== "ai") return YOU;
      return { type: "ai", label: modelLabel(block) ?? "AI" };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, hashes, contentKey, enabled]);
}
