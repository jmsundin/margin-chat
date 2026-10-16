import type { Conversation } from "../types";
import { getDocumentWorkspace } from "./documentWorkspace";

export type DocumentKind = "main" | "side" | "branch" | "note";

/** Side documents (created with + and not anchored to a passage) sit beside the document they came from. */
export function isPeerDocument(document: Conversation | undefined): boolean {
  return Boolean(document?.parentId && !document.branchAnchor && !document.document?.marginNote);
}

export function getDocumentKind(document: Conversation): DocumentKind {
  if (document.document?.marginNote) return "note";
  if (!document.parentId) return "main";
  return document.branchAnchor ? "branch" : "side";
}

/** Branches and margin notes belong under their source; side documents share their source's level. */
export function getPresentedParentId(conversations: Record<string, Conversation>, id: string): string | null {
  const visited = new Set<string>();
  let current: Conversation | undefined = conversations[id];
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const parent: Conversation | undefined = current.parentId ? conversations[current.parentId] : undefined;
    if (!parent) return null;
    if (!isPeerDocument(current)) return parent.id;
    current = parent;
  }
  return null;
}

export interface DocumentBreadcrumbLevel {
  /** The document on the focused path at this level. */
  document: Conversation;
  /** The document this level is listed under; null for the main document and its side documents. */
  parent: Conversation | null;
  /** Every document at this level, in the family's tab order. */
  options: Conversation[];
}

/** Breadcrumb levels for the focused document's family, plus the focused document's own children. */
export function getDocumentBreadcrumbs(conversations: Record<string, Conversation>, focusedId: string) {
  const focused = conversations[focusedId];
  const byParent = new Map<string | null, Conversation[]>();
  if (!focused) return { levels: [] as DocumentBreadcrumbLevel[], children: [] as Conversation[], childrenByParent: byParent };
  for (const document of getDocumentWorkspace(conversations, focusedId).documents) {
    const parentId = getPresentedParentId(conversations, document.id);
    byParent.set(parentId, [...byParent.get(parentId) ?? [], document]);
  }
  const path: Conversation[] = [];
  for (let current: Conversation | undefined = focused; current && !path.includes(current);) {
    path.unshift(current);
    const parentId = getPresentedParentId(conversations, current.id);
    current = parentId ? conversations[parentId] : undefined;
  }
  const levels = path.map((document, index): DocumentBreadcrumbLevel => {
    const parent = path[index - 1] ?? null;
    const options = byParent.get(parent?.id ?? null) ?? [];
    return { document, parent, options: options.includes(document) ? options : [...options, document] };
  });
  return { levels, children: byParent.get(focused.id) ?? [], childrenByParent: byParent };
}

/** Back history for each tab, keyed by the document the tab currently shows. */
export type DocumentHistory = Record<string, string[]>;

const HISTORY_LIMIT = 30;

/** The tab's history moves with it when Expand here replaces its document. */
export function recordDocumentNavigation(history: DocumentHistory, fromId: string, toId: string): DocumentHistory {
  if (fromId === toId) return history;
  const { [fromId]: previous = [], [toId]: _replaced, ...rest } = history;
  return { ...rest, [toId]: [...previous.filter((id) => id !== toId), fromId].slice(-HISTORY_LIMIT) };
}

export function getDocumentBackTarget(history: DocumentHistory, currentId: string, conversations: Record<string, Conversation>) {
  return [...history[currentId] ?? []].reverse().find((id) => id !== currentId && conversations[id]) ?? null;
}

/** Going back either swaps the previous document into this tab (replace) or switches to its own tab. */
export function takeDocumentBack(history: DocumentHistory, currentId: string, conversations: Record<string, Conversation>, replace: boolean): DocumentHistory {
  const stack = (history[currentId] ?? []).filter((id) => id !== currentId && conversations[id]);
  const previousId = stack.pop();
  const { [currentId]: _current, ...rest } = history;
  if (!previousId || !replace) return rest;
  const { [previousId]: _previous, ...others } = rest;
  return stack.length ? { ...others, [previousId]: stack } : others;
}
