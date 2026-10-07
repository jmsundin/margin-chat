import { isCompactDocument } from "@margin-chat/workspace-contracts";
import type { AppState, Conversation } from "../types";
import { getConversationPath } from "./tree";
import { getDocumentLinkTarget } from "./documentLinks";

/** Children navigation includes both direct branches and documents linked from this document. */
export function getDocumentChildrenByParent(conversations: Record<string, Conversation>) {
  const children = new Map<string, Conversation[]>();
  const seen = new Map<string, Set<string>>();
  function add(parentId: string, child: Conversation) {
    if (parentId === child.id || !Object.hasOwn(conversations, parentId)) return;
    const ids = seen.get(parentId) ?? new Set<string>();
    if (ids.has(child.id)) return;
    ids.add(child.id);
    seen.set(parentId, ids);
    const entries = children.get(parentId) ?? [];
    entries.push(child);
    children.set(parentId, entries);
  }
  // Preserve the saved ordering of existing branches.
  for (const root of Object.values(conversations)) {
    if (root.parentId !== null) continue;
    for (const document of getDocumentWorkspace(conversations, root.id).documents) {
      if (document.parentId) add(document.parentId, document);
    }
  }
  for (const document of Object.values(conversations)) {
    if (document.parentId) add(document.parentId, document);
    for (const link of document.document?.links ?? []) {
      const target = getDocumentLinkTarget(link, conversations);
      if (target) add(document.id, target.conversation);
    }
  }
  return children;
}

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
    .filter((id) => visited.has(id));
  const closedIds = [...new Set(root?.documentLayout?.closedIds ?? [])].filter((id) => visited.has(id));
  const minimized = new Set([...minimizedIds, ...closedIds]);
  const documents = order.map((id) => conversations[id]);
  return { root, documents, minimizedIds, closedIds, openDocuments: documents.filter((document) => !closedIds.includes(document.id)), visibleDocuments: documents.filter((document) => !minimized.has(document.id)) };
}

function saveLayout(state: AppState, root: Conversation, order: string[], minimizedIds: string[], closedIds = root.documentLayout?.closedIds ?? []): AppState {
  return { ...state, conversations: { ...state.conversations, [root.id]: {
    ...root, documentLayout: { ...root.documentLayout, order, minimizedIds, ...(closedIds.length || root.documentLayout?.closedIds ? { closedIds } : {}) },
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

function restoreDocuments(state: AppState, id: string, ids: string[], order?: string[]): AppState {
  const { root, documents, minimizedIds, closedIds } = getDocumentWorkspace(state.conversations, id);
  if (!root) return state;
  const restored = new Set(ids);
  const nextMinimized = minimizedIds.filter((candidate) => !restored.has(candidate));
  const nextClosed = closedIds.filter((candidate) => !restored.has(candidate));
  return !order && nextMinimized.length === minimizedIds.length && nextClosed.length === closedIds.length ? state
    : saveLayout(state, root, order ?? documents.map((document) => document.id), nextMinimized, nextClosed);
}

function activate(state: AppState, id: string): AppState {
  const root = getConversationPath(state.conversations, id)[0];
  if (!root || (state.activeConversationId === id && state.rootId === root.id)) return state;
  return { ...state, activeConversationId: id, rootId: root.id };
}

/** Opening independently restores the path back to the original main document. */
export function focusDocument(state: AppState, id: string, restoreAncestors = true): AppState {
  if (!state.conversations[id]) return state;
  return activate(restoreDocuments(state, id, restoreAncestors
    ? getConversationPath(state.conversations, id).map((document) => document.id)
    : [id]), id);
}

/** Compact margin notes render in their host's margin, so showing one also shows its host. */
export function getMarginHostPath(conversations: Record<string, Conversation>, id: string): string[] {
  const path: string[] = [];
  let current: Conversation | undefined = conversations[id];
  while (current && !path.includes(current.id)) {
    path.unshift(current.id);
    if (!isCompactDocument(current) || !current.parentId) break;
    current = conversations[current.parentId];
  }
  return path;
}

/** Tabs and breadcrumbs focus one document without reopening ancestors the user closed. */
export function showDocument(state: AppState, id: string): AppState {
  if (!state.conversations[id]) return state;
  return activate(restoreDocuments(state, id, getMarginHostPath(state.conversations, id)), id);
}

function placeBeside(order: string[], id: string, anchorId: string, after: boolean) {
  const next = order.filter((candidate) => candidate !== id);
  const index = next.indexOf(anchorId);
  if (index < 0) return order;
  next.splice(index + (after ? 1 : 0), 0, id);
  return next;
}

/** Expand here: the target takes the current document's place, which closes until Back reopens it. */
export function replaceDocument(state: AppState, currentId: string, targetId: string): AppState {
  const target = state.conversations[targetId];
  if (!target || currentId === targetId) return state;
  const { root, documents, minimizedIds, closedIds } = getDocumentWorkspace(state.conversations, targetId);
  const order = documents.map((document) => document.id);
  if (!root || !order.includes(currentId)) return showDocument(state, targetId);
  const restored = new Set(getMarginHostPath(state.conversations, targetId).filter((id) => id !== currentId));
  // Compact notes keep their place in the margin; documents take over the current pane slot.
  const nextOrder = isCompactDocument(target) && target.parentId ? order : placeBeside(order, targetId, currentId, false);
  const next = saveLayout(state, root, nextOrder,
    minimizedIds.filter((id) => !restored.has(id) && id !== currentId),
    [...closedIds.filter((id) => !restored.has(id) && id !== currentId), currentId]);
  return activate(next, targetId);
}

/** Open beside: the target opens right after the anchor, and focus stays on the anchor. */
export function openDocumentBeside(state: AppState, anchorId: string | null, targetId: string): AppState {
  if (!state.conversations[targetId] || anchorId === targetId) return state;
  const path = getMarginHostPath(state.conversations, targetId);
  const { documents, minimizedIds, closedIds } = getDocumentWorkspace(state.conversations, targetId);
  const order = documents.map((document) => document.id);
  const hostId = path[0];
  // Documents already on screen keep the position the user gave them.
  const hidden = minimizedIds.includes(hostId) || closedIds.includes(hostId);
  const nextOrder = anchorId && hidden && hostId !== anchorId && order.includes(anchorId)
    ? placeBeside(order, hostId, anchorId, true) : undefined;
  return restoreDocuments(state, targetId, path, nextOrder);
}

/** Hiding a pane never deletes its content, links, children, or saved position. */
function hideDocument(state: AppState, id: string, close: boolean): AppState {
  if (!state.conversations[id]) return state;
  const { root, documents, minimizedIds, closedIds } = getDocumentWorkspace(state.conversations, id);
  if (!root || closedIds.includes(id) || (!close && minimizedIds.includes(id))) return state;
  const nextMinimized = close ? minimizedIds.filter((candidate) => candidate !== id) : [...minimizedIds, id];
  const nextClosed = close ? [...closedIds, id] : closedIds;
  const next = saveLayout(state, root, documents.map((document) => document.id), nextMinimized, nextClosed);
  if (state.activeConversationId !== id) return next;
  const hidden = new Set([...nextMinimized, ...nextClosed]);
  const path = getConversationPath(state.conversations, id).slice(0, -1).reverse();
  const fallback = [...path, ...documents].find((document) => !hidden.has(document.id));
  // An empty workspace retains its family context; sidebar navigation can reopen any document.
  return fallback ? { ...next, activeConversationId: fallback.id, rootId: root.id } : next;
}

export function minimizeDocument(state: AppState, id: string): AppState {
  return hideDocument(state, id, false);
}

export function closeDocument(state: AppState, id: string): AppState {
  return hideDocument(state, id, true);
}
