import type { Conversation } from "../types";
import { getDocumentBreadcrumbs } from "./documentBreadcrumbs";
import type { DocumentGraphEdge } from "./documentRelations";

export type DocumentNavigationStyle = "compass" | "graph" | "outline" | "reading";

export const DOCUMENT_NAVIGATION_STYLES: { id: DocumentNavigationStyle; label: string; description: string }[] = [
  { id: "compass", label: "Compass", description: "Parent, siblings, children and links in a strip above the document" },
  { id: "graph", label: "Local graph", description: "A small map of the documents around this one" },
  { id: "outline", label: "Topic outline", description: "The whole document family as an outline beside the document" },
  { id: "reading", label: "Keep reading", description: "Where to go next, at the end of the document" },
];

const STORAGE_KEY = "margin-chat:document-navigation";

export function loadDocumentNavigationStyle(): DocumentNavigationStyle {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (DOCUMENT_NAVIGATION_STYLES.some((style) => style.id === stored)) return stored as DocumentNavigationStyle;
  } catch { /* Storage can be unavailable. */ }
  return "compass";
}

export function saveDocumentNavigationStyle(style: DocumentNavigationStyle) {
  try { localStorage.setItem(STORAGE_KEY, style); } catch { /* Best effort. */ }
}

export interface DocumentNeighbors {
  focused: Conversation;
  /** The document this one is listed under; side documents share their source's level, so they have none. */
  parent: Conversation | null;
  /** Every document at this level, the focused one included, in family order. */
  siblings: Conversation[];
  index: number;
  children: Conversation[];
  /** Documents connected by links or relations, outside the family tree. */
  linked: Conversation[];
  /** The whole family by presented parent, for outlines. */
  childrenByParent: Map<string | null, Conversation[]>;
}

const MAX_LINKED = 12;

export function getDocumentNeighbors(conversations: Record<string, Conversation>, focusedId: string, edges: readonly DocumentGraphEdge[]): DocumentNeighbors | null {
  const focused = conversations[focusedId];
  if (!focused) return null;
  const { levels, children, childrenByParent } = getDocumentBreadcrumbs(conversations, focusedId);
  const level = levels.at(-1);
  const siblings = level?.options ?? [focused];
  const family = new Set([...childrenByParent.values()].flat().map((document) => document.id));
  const linkedIds = new Set<string>(focused.linkedConversationIds ?? []);
  for (const edge of edges) {
    if (edge.sourceId === focusedId) linkedIds.add(edge.targetId);
    else if (edge.targetId === focusedId) linkedIds.add(edge.sourceId);
  }
  const linked = [...linkedIds]
    .filter((id) => id !== focusedId && !family.has(id) && conversations[id])
    .map((id) => conversations[id]).slice(0, MAX_LINKED);
  return { focused, parent: level?.parent ?? null, siblings, index: Math.max(0, siblings.indexOf(focused)), children, linked, childrenByParent };
}
