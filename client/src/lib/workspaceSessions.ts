import { isCompactDocument } from "@margin-chat/workspace-contracts";
import type { AppState, Conversation, WorkspaceSession, WorkspaceSessions } from "../types";
import type { SidebarDocumentSort } from "./sidebarDocumentOrder";
import { getConversationPath } from "./tree";

/** Distinct in lightness as well as hue, so neighbouring tabs stay apart for everyone. */
export const SESSION_COLORS = ["#0d7a6f", "#6d4bb8", "#c2410c", "#2563eb", "#a16207", "#be185d", "#4d7c0f", "#475569"];

const NAME_TITLE_LENGTH = 32;

function emptySessions(): WorkspaceSessions {
  return { items: {}, tabIds: [], activeId: null };
}

export function getActiveSession(state: Pick<AppState, "sessions">): WorkspaceSession | null {
  const sessions = state.sessions;
  return sessions?.activeId ? sessions.items[sessions.activeId] ?? null : null;
}

function nextColor(sessions: WorkspaceSessions) {
  const used = new Map<string, number>();
  for (const session of Object.values(sessions.items)) used.set(session.color, (used.get(session.color) ?? 0) + 1);
  return [...SESSION_COLORS].sort((left, right) => (used.get(left) ?? 0) - (used.get(right) ?? 0))[0];
}

/** Root documents of a session, in the order they joined it. */
export function getSessionRootDocuments(session: Pick<WorkspaceSession, "documentIds">, conversations: Record<string, Conversation>) {
  const roots: Conversation[] = [];
  const seen = new Set<string>();
  for (const id of session.documentIds) {
    const root = getConversationPath(conversations, id)[0];
    if (!root || seen.has(root.id)) continue;
    seen.add(root.id);
    roots.push(root);
  }
  return roots;
}

/** Membership the automatic name describes; it changes when a new document family joins. */
export function getSessionNameKey(session: Pick<WorkspaceSession, "documentIds">, conversations: Record<string, Conversation>) {
  return getSessionRootDocuments(session, conversations)
    .map((root) => `${root.id}:${root.title.trim()}`).sort().join("|");
}

function shortTitle(title: string) {
  const trimmed = title.trim() || "Untitled document";
  return trimmed.length > NAME_TITLE_LENGTH ? `${trimmed.slice(0, NAME_TITLE_LENGTH - 1).trimEnd()}…` : trimmed;
}

/** A name from the session's own documents, used until (or instead of) an AI-written one. */
export function describeSession(session: Pick<WorkspaceSession, "documentIds">, conversations: Record<string, Conversation>) {
  const titles = getSessionRootDocuments(session, conversations)
    .map((root) => root.title.trim()).filter((title) => title && title !== "Untitled document");
  if (!titles.length) return "New session";
  if (titles.length === 1) return shortTitle(titles[0]);
  if (titles.length === 2) return `${shortTitle(titles[0])} & ${shortTitle(titles[1])}`;
  return `${shortTitle(titles[0])}, ${shortTitle(titles[1])} +${titles.length - 2}`;
}

function withAutoName(session: WorkspaceSession, conversations: Record<string, Conversation>): WorkspaceSession {
  if (session.nameSource !== "auto") return session;
  const nameKey = getSessionNameKey(session, conversations);
  if (session.nameKey === nameKey) return session;
  return { ...session, name: describeSession(session, conversations), nameKey };
}

function sessionDocumentIds(ids: Iterable<string>, conversations: Record<string, Conversation>) {
  return [...new Set(ids)].filter((id) => conversations[id] && !isCompactDocument(conversations[id]));
}

/**
 * Give a workspace its first session: the documents already open become one
 * session in the tab bar, so nothing disappears when sessions arrive.
 */
export function ensureSessions(state: AppState, openDocumentIds: string[], now = new Date().toISOString()): AppState {
  const sessions = state.sessions;
  if (sessions && Object.keys(sessions.items).length) {
    if (sessions.activeId && sessions.items[sessions.activeId]) return state;
    const fallback = sessions.tabIds[0] ?? sortSessions(Object.values(sessions.items), "recent", [])[0]?.id;
    return { ...state, sessions: { ...sessions, activeId: fallback ?? null,
      tabIds: sessions.tabIds.length || !fallback ? sessions.tabIds : [fallback] } };
  }
  const base = sessions ?? emptySessions();
  const id = `session-${crypto.randomUUID()}`;
  const documentIds = sessionDocumentIds([...openDocumentIds, state.activeConversationId], state.conversations);
  const session = withAutoName({
    id, name: "New session", nameSource: "auto", color: SESSION_COLORS[0], documentIds,
    ...(state.conversations[state.activeConversationId] ? { activeDocumentId: state.activeConversationId } : {}),
    createdAt: now, lastOpenedAt: now,
  }, state.conversations);
  return { ...state, sessions: { items: { ...base.items, [id]: session }, tabIds: [id], activeId: id } };
}

/** A document focused while a session is active joins it. Returns the same state when nothing changes. */
export function recordSessionDocument(state: AppState, documentId: string): AppState {
  const session = getActiveSession(state);
  const document = state.conversations[documentId];
  if (!session || !document || isCompactDocument(document) || session.documentIds.includes(documentId)) return state;
  const next = withAutoName({ ...session, documentIds: [...session.documentIds, documentId] }, state.conversations);
  return { ...state, sessions: { ...state.sessions!, items: { ...state.sessions!.items, [session.id]: next } } };
}

/** Add documents to a session that is not necessarily active, as dropping documents on its tab does. */
export function addDocumentsToSession(state: AppState, sessionId: string, documentIds: string[]): AppState {
  const session = state.sessions?.items[sessionId];
  if (!session) return state;
  const added = sessionDocumentIds(documentIds, state.conversations).filter((id) => !session.documentIds.includes(id));
  if (!added.length) return state;
  const next = withAutoName({ ...session, documentIds: [...session.documentIds, ...added] }, state.conversations);
  return { ...state, sessions: { ...state.sessions!, items: { ...state.sessions!.items, [sessionId]: next } } };
}

/** Takes a document out of a session; the document itself stays in the vault. */
export function removeDocumentFromSession(state: AppState, sessionId: string, documentId: string): AppState {
  const session = state.sessions?.items[sessionId];
  if (!session?.documentIds.includes(documentId)) return state;
  const documentIds = session.documentIds.filter((id) => id !== documentId);
  const next = withAutoName({ ...session, documentIds,
    ...(session.activeDocumentId === documentId ? { activeDocumentId: documentIds.at(-1) } : {}) }, state.conversations);
  if (!next.activeDocumentId) delete next.activeDocumentId;
  return { ...state, sessions: { ...state.sessions!, items: { ...state.sessions!.items, [sessionId]: next } } };
}

/**
 * Leave the active session as it is now and make `targetId` active. The caller
 * then focuses the returned document, which restores that session's place.
 */
export function switchSession(state: AppState, targetId: string, now = new Date().toISOString()): { state: AppState; documentId: string | null } {
  const sessions = state.sessions;
  const target = sessions?.items[targetId];
  if (!sessions || !target) return { state, documentId: null };
  const items = { ...sessions.items };
  const current = sessions.activeId ? items[sessions.activeId] : undefined;
  if (current && current.id !== targetId) {
    const left: WorkspaceSession = { ...current, ...(state.conversations[state.activeConversationId] && !isCompactDocument(state.conversations[state.activeConversationId])
      ? { activeDocumentId: state.activeConversationId } : {}) };
    if (state.documentDock) left.documentDock = state.documentDock; else delete left.documentDock;
    items[current.id] = left;
  }
  if (current?.id === targetId) return { state, documentId: target.activeDocumentId ?? null };
  items[targetId] = { ...target, lastOpenedAt: now };
  const documentId = [target.activeDocumentId, ...[...target.documentIds].reverse()]
    .find((id): id is string => Boolean(id && state.conversations[id])) ?? null;
  const { documentDock: _dock, ...rest } = state;
  return {
    state: { ...rest, ...(target.documentDock ? { documentDock: target.documentDock } : {}),
      sessions: { ...sessions, items, activeId: targetId,
        tabIds: sessions.tabIds.includes(targetId) ? sessions.tabIds : [...sessions.tabIds, targetId] } },
    documentId,
  };
}

/** A new, empty session; it joins the tab bar and becomes active. */
export function createSession(state: AppState, now = new Date().toISOString(), options: { name?: string; atTabIndex?: number } = {}): { state: AppState; sessionId: string } {
  const sessions = state.sessions ?? emptySessions();
  const id = `session-${crypto.randomUUID()}`;
  const name = options.name?.trim().slice(0, 120);
  const session: WorkspaceSession = { id, name: name || "New session", nameSource: name ? "user" : "auto",
    color: nextColor(sessions), documentIds: [], createdAt: now, lastOpenedAt: now };
  const tabIds = [...sessions.tabIds];
  tabIds.splice(options.atTabIndex ?? tabIds.length, 0, id);
  const withSession = { ...state, sessions: { ...sessions, items: { ...sessions.items, [id]: session }, tabIds } };
  return { state: switchSession(withSession, id, now).state, sessionId: id };
}

export function renameSession(state: AppState, sessionId: string, name: string): AppState {
  const session = state.sessions?.items[sessionId];
  if (!session) return state;
  const trimmed = name.trim().slice(0, 120);
  // Clearing the name hands it back to automatic naming.
  const next: WorkspaceSession = trimmed
    ? { ...session, name: trimmed, nameSource: "user" }
    : withAutoName({ ...session, nameSource: "auto", nameKey: undefined }, state.conversations);
  if (trimmed) delete next.nameKey;
  return { ...state, sessions: { ...state.sessions!, items: { ...state.sessions!.items, [sessionId]: next } } };
}

/** Automatic names written by AI replace the description only while the documents are unchanged. */
export function applySessionAutoName(state: AppState, sessionId: string, nameKey: string, name: string): AppState {
  const session = state.sessions?.items[sessionId];
  const trimmed = name.trim().replace(/^["'“”]+|["'“”.]+$/g, "").slice(0, 60);
  if (!session || session.nameSource !== "auto" || session.nameKey !== nameKey || !trimmed || session.name === trimmed) return state;
  return { ...state, sessions: { ...state.sessions!, items: { ...state.sessions!.items, [sessionId]: { ...session, name: trimmed } } } };
}

export function duplicateSession(state: AppState, sessionId: string, now = new Date().toISOString()): AppState {
  const sessions = state.sessions;
  const session = sessions?.items[sessionId];
  if (!sessions || !session) return state;
  const id = `session-${crypto.randomUUID()}`;
  const copy: WorkspaceSession = { ...session, id, color: nextColor(sessions), createdAt: now, lastOpenedAt: now,
    ...(session.nameSource === "user" ? { name: `${session.name} copy` } : {}) };
  const index = sessions.tabIds.indexOf(sessionId);
  const tabIds = [...sessions.tabIds];
  if (index >= 0) tabIds.splice(index + 1, 0, id);
  return { ...state, sessions: { ...sessions, items: { ...sessions.items, [id]: copy }, tabIds } };
}

/** Put a session in the tab bar at `index`, or move it there when it already is. */
export function placeSessionTab(state: AppState, sessionId: string, index: number): AppState {
  const sessions = state.sessions;
  if (!sessions?.items[sessionId]) return state;
  const tabIds = sessions.tabIds.filter((id) => id !== sessionId);
  tabIds.splice(Math.max(0, Math.min(index, tabIds.length)), 0, sessionId);
  if (tabIds.join("|") === sessions.tabIds.join("|")) return state;
  return { ...state, sessions: { ...sessions, tabIds } };
}

/**
 * Take a session out of the tab bar; it stays in the Sessions panel. The last
 * tab stays, and leaving the active tab moves to its neighbour.
 */
export function removeSessionTab(state: AppState, sessionId: string): { state: AppState; switchTo: string | null } {
  const sessions = state.sessions;
  if (!sessions || !sessions.tabIds.includes(sessionId) || sessions.tabIds.length <= 1) return { state, switchTo: null };
  const index = sessions.tabIds.indexOf(sessionId);
  const tabIds = sessions.tabIds.filter((id) => id !== sessionId);
  const switchTo = sessions.activeId === sessionId ? tabIds[Math.min(index, tabIds.length - 1)] : null;
  return { state: { ...state, sessions: { ...sessions, tabIds } }, switchTo };
}

/** Deleting a session forgets its list and layout; its documents stay in the vault. */
export function deleteSession(state: AppState, sessionId: string): { state: AppState; switchTo: string | null } {
  const sessions = state.sessions;
  if (!sessions?.items[sessionId]) return { state, switchTo: null };
  const { [sessionId]: _deleted, ...items } = sessions.items;
  const index = sessions.tabIds.indexOf(sessionId);
  let tabIds = sessions.tabIds.filter((id) => id !== sessionId);
  let switchTo: string | null = null;
  if (sessions.activeId === sessionId) {
    switchTo = tabIds[Math.max(0, Math.min(index, tabIds.length - 1))]
      ?? sortSessions(Object.values(items), "recent", [])[0]?.id ?? null;
    if (switchTo && !tabIds.includes(switchTo)) tabIds = [switchTo];
  }
  return { state: { ...state, sessions: { items, tabIds, activeId: sessions.activeId === sessionId ? null : sessions.activeId } }, switchTo };
}

/**
 * Sessions follow the sidebar's document sort. A to Z and Recently viewed use
 * the session's own name and last visit; the meaning sorts place a session
 * where its highest-ranked document sits in the sidebar.
 */
export function sortSessions(sessions: WorkspaceSession[], sort: SidebarDocumentSort, orderedDocumentIds: string[]) {
  if (sort === "alphabetical") return [...sessions].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  if (sort === "recent" || !orderedDocumentIds.length) {
    return [...sessions].sort((left, right) => Date.parse(right.lastOpenedAt) - Date.parse(left.lastOpenedAt) || left.name.localeCompare(right.name));
  }
  const rank = new Map(orderedDocumentIds.map((id, index) => [id, index]));
  const best = (session: WorkspaceSession) => Math.min(Infinity, ...session.documentIds.map((id) => rank.get(id) ?? Infinity));
  return [...sessions].sort((left, right) => best(left) - best(right) || Date.parse(right.lastOpenedAt) - Date.parse(left.lastOpenedAt));
}
