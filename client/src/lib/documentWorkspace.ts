import type { AppState, Conversation } from "../types";
import { getConversationPath } from "./tree";

/** A document family has its own visual order, independent of its graph edges. */
export function getDocumentWorkspace(conversations: Record<string, Conversation>, focusedId: string) {
  const root = getConversationPath(conversations, focusedId)[0];
  const family: Conversation[] = [];
  const visited = new Set<string>();
  const pending = root ? [root] : [];
  while (pending.length) {
    const document = pending.pop()!;
    if (visited.has(document.id)) continue;
    visited.add(document.id);
    family.push(document);
    pending.push(...document.childIds.map((id) => conversations[id])
      .filter((child) => child && child.parentId === document.id).reverse());
  }
  const order = [...new Set([...(root?.documentLayout?.order ?? []), ...family.map((document) => document.id)])]
    .filter((id) => visited.has(id));
  const minimizedIds = [...new Set(root?.documentLayout?.minimizedIds ?? [])]
    .filter((id) => visited.has(id) && id !== root?.id);
  const minimized = new Set(minimizedIds);
  const documents = order.map((id) => conversations[id]);
  return { root, documents, minimizedIds, visibleDocuments: documents.filter((document) => !minimized.has(document.id)) };
}

function saveLayout(state: AppState, root: Conversation, order: string[], minimizedIds: string[]): AppState {
  return { ...state, conversations: { ...state.conversations, [root.id]: {
    ...root, documentLayout: { ...root.documentLayout, order, minimizedIds },
  } } };
}

/** A document's chosen width follows it across focus, minimize and pin changes. */
export function getDocumentWidth(conversations: Record<string, Conversation>, id: string): number | undefined {
  const root = getConversationPath(conversations, id)[0];
  return root?.documentLayout?.widthsById?.[id];
}

/** Commit a width only when a resize finishes; undefined restores automatic sizing. */
export function setDocumentWidth(state: AppState, id: string, width: number | undefined): AppState {
  if (!state.conversations[id] || (width !== undefined && !Number.isFinite(width))) return state;
  const { root, documents, minimizedIds } = getDocumentWorkspace(state.conversations, id);
  if (!root || root.parentId !== null) return state;
  const nextWidth = width === undefined ? undefined : Math.max(320, Math.min(980, width));
  if (root.documentLayout?.widthsById?.[id] === nextWidth) return state;
  const widthsById = { ...root.documentLayout?.widthsById };
  if (nextWidth === undefined) delete widthsById[id];
  else widthsById[id] = nextWidth;
  const { widthsById: _previousWidths, ...layout } = root.documentLayout ?? { order: documents.map((document) => document.id), minimizedIds };
  return { ...state, conversations: { ...state.conversations, [root.id]: {
    ...root, documentLayout: { ...layout, ...(Object.keys(widthsById).length ? { widthsById } : {}) },
  } } };
}

export function reorderDocument(state: AppState, draggedId: string, targetId: string): AppState {
  const { root, documents, minimizedIds } = getDocumentWorkspace(state.conversations, draggedId);
  const order = documents.map((document) => document.id);
  const from = order.indexOf(draggedId);
  const to = order.indexOf(targetId);
  if (!root || from < 0 || to < 0 || from === to) return state;
  order.splice(from, 1);
  order.splice(to, 0, draggedId);
  return saveLayout(state, root, order, minimizedIds);
}

/** Newly created children open immediately to the right of the focused source. */
export function placeNewSideDocument(state: AppState, childId: string): AppState {
  const child = state.conversations[childId];
  const { root, documents, minimizedIds } = getDocumentWorkspace(state.conversations, childId);
  if (!child?.parentId || !root) return state;
  const order = documents.map((document) => document.id).filter((id) => id !== childId);
  order.splice(order.indexOf(child.parentId) + 1, 0, childId);
  return saveLayout(state, root, order, minimizedIds.filter((id) => id !== childId));
}

/** Opening independently restores the path back to the original main document. */
export function focusDocument(state: AppState, id: string, restoreAncestors = true): AppState {
  if (!state.conversations[id]) return state;
  const { root, documents, minimizedIds } = getDocumentWorkspace(state.conversations, id);
  if (!root) return state;
  const restored = new Set(restoreAncestors
    ? getConversationPath(state.conversations, id).map((document) => document.id)
    : [id]);
  const nextMinimized = minimizedIds.filter((candidate) => !restored.has(candidate));
  const next = nextMinimized.length === minimizedIds.length ? state
    : saveLayout(state, root, documents.map((document) => document.id), nextMinimized);
  if (next.activeConversationId === id && next.rootId === root.id) return next;
  return { ...next, activeConversationId: id, rootId: root.id };
}

export function minimizeDocument(state: AppState, id: string): AppState {
  const { root, documents, minimizedIds } = getDocumentWorkspace(state.conversations, id);
  if (!root || root.id === id || minimizedIds.includes(id)) return state;
  const nextMinimized = [...minimizedIds, id];
  const next = saveLayout(state, root, documents.map((document) => document.id), nextMinimized);
  if (state.activeConversationId !== id) return next;
  const path = getConversationPath(state.conversations, id).slice(0, -1).reverse();
  const fallback = path.find((document) => !nextMinimized.includes(document.id)) ?? root;
  return { ...next, activeConversationId: fallback.id, rootId: root.id };
}
