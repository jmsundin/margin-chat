import { titleMarkdownPath } from "@margin-chat/workspace-contracts";
import type { Conversation } from "../types";
import type { VaultIndexEntry } from "./vaultTypes";

/**
 * Typing `[[` in a document lists the vault's documents to link to, like Obsidian.
 * Downloaded documents and those still in the cloud are both listed, by title.
 */

export interface WikiLinkSuggestion {
  id: string;
  title: string;
  /** What goes between the brackets: the title, or a filename and label when titles repeat. */
  link: string;
  /** The parent's title, shown to tell apart documents with the same name. */
  detail?: string;
  /** Still in the cloud; the link works now and the document downloads when opened. */
  cloud?: boolean;
}

export interface WikiLinkSuggestionInput {
  conversations: Record<string, Conversation>;
  cloudDocuments?: readonly VaultIndexEntry[];
  /** The document being edited, which isn't offered. */
  currentId?: string;
}

/** The `[[` being typed before the caret on this line, and what follows it. */
export function findWikiLinkQuery(lineBeforeCaret: string): { start: number; query: string } | null {
  const start = lineBeforeCaret.lastIndexOf("[[");
  if (start < 0) return null;
  const query = lineBeforeCaret.slice(start + 2);
  // A closed link, a fourth bracket or a heading/block part (`#`, `^`, `|`) means the name is done.
  if (/[\][|#^]/.test(query) || query.length > 120) return null;
  // `![[` embeds a file; it still names a document, so it gets the same list.
  return { start, query };
}

const fold = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
/** Brackets, pipes and heading marks would end the link early. */
const linkSafe = (value: string) => value.replace(/[\][|#^\n]/g, " ").replace(/\s+/g, " ").trim();

interface Candidate { id: string; title: string; updated: string; parentId?: string | null; parentPath?: string; cloud: boolean; path?: string }

function rank(title: string, terms: string[], whole: string): number | null {
  const name = fold(title);
  if (!terms.length) return 5;
  if (name === whole) return 0;
  if (name.startsWith(whole)) return 1;
  const words = name.split(/[\s\-_/.,:;()]+/u);
  if (words.some((word) => word.startsWith(whole))) return 2;
  if (name.includes(whole)) return 3;
  if (terms.every((term) => words.some((word) => word.startsWith(term)))) return 4;
  if (terms.every((term) => name.includes(term))) return 5;
  return null;
}

export function wikiLinkSuggestions(input: WikiLinkSuggestionInput, query: string, limit = 8): WikiLinkSuggestion[] {
  const { conversations, cloudDocuments = [], currentId } = input;
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const conversation of Object.values(conversations)) {
    if (conversation.id === currentId || !conversation.title.trim()) continue;
    seen.add(conversation.id);
    candidates.push({ id: conversation.id, title: conversation.title.trim(), updated: conversation.updatedAt ?? "", parentId: conversation.parentId, cloud: false });
  }
  for (const entry of cloudDocuments) {
    if (seen.has(entry.id) || entry.id === currentId || !entry.title.trim()) continue;
    seen.add(entry.id);
    candidates.push({ id: entry.id, title: entry.title.trim(), updated: entry.updated ?? entry.created ?? "", parentPath: entry.parentPath, cloud: true, path: entry.path });
  }
  const whole = fold(query.trim()).replace(/\s+/g, " ");
  const terms = whole.split(" ").filter(Boolean);
  const scored: Array<{ candidate: Candidate; score: number }> = [];
  for (const candidate of candidates) {
    const score = rank(candidate.title, terms, whole);
    if (score !== null) scored.push({ candidate, score });
  }
  scored.sort((a, b) => a.score - b.score || b.candidate.updated.localeCompare(a.candidate.updated) || a.candidate.title.localeCompare(b.candidate.title));
  const top = scored.slice(0, limit);
  // Titles that more than one document shares link by filename, so the link finds the right one.
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = fold(linkSafe(candidate.title));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const cloudTitleByPath = new Map(cloudDocuments.map((entry) => [entry.path, entry.title]));
  return top.map(({ candidate }) => {
    const title = linkSafe(candidate.title) || "Untitled";
    const shared = (counts.get(fold(title)) ?? 0) > 1 || title !== candidate.title;
    const link = shared ? `${fileStem(candidate)}|${title}` : title;
    const parentTitle = candidate.parentId ? conversations[candidate.parentId]?.title
      : candidate.parentPath ? cloudTitleByPath.get(candidate.parentPath) : undefined;
    return {
      id: candidate.id, title, link,
      ...(parentTitle?.trim() ? { detail: parentTitle.trim() } : {}),
      ...(candidate.cloud ? { cloud: true } : {}),
    };
  });
}

/** The name Margin Chat gives the document's file, `Title — suffix`, which the link resolver reads. */
function fileStem(candidate: Candidate) {
  const fromPath = candidate.path?.split("/").at(-1)?.replace(/\.md$/i, "");
  if (fromPath && / — [0-9a-z]+-[0-9a-z]+(?: \(\d+\))?$/.test(fromPath) && !/[\][|#^]/.test(fromPath)) return fromPath;
  return titleMarkdownPath("Notes", candidate.title, candidate.id).split("/").at(-1)!.replace(/\.md$/i, "");
}
