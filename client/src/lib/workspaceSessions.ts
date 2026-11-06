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
  if (!titles.length) return "New space";
  if (titles.length === 1) return shortTitle(titles[0]);
  if (titles.length === 2) return `${shortTitle(titles[0])} & ${shortTitle(titles[1])}`;
  return `${shortTitle(titles[0])}, ${shortTitle(titles[1])} +${titles.length - 2}`;
}

/** An automatic name is written once, when the first documents arrive, and then holds still. */
function withAutoName(session: WorkspaceSession, conversations: Record<string, Conversation>): WorkspaceSession {
  if (session.nameSource !== "auto" || session.nameKey) return session;
  const nameKey = getSessionNameKey(session, conversations);
  if (session.nameKey === nameKey) return session;
  return { ...session, name: describeSession(session, conversations), nameKey };
}

function sessionDocumentIds(ids: Iterable<string>, conversations: Record<string, Conversation>) {
  return [...new Set(ids)].filter((id) => conversations[id] && !isCompactDocument(conversations[id]));
}

/** The main document a document belongs to; side documents and notes travel with it. */
export function getFamilyRootId(conversations: Record<string, Conversation>, documentId: string) {
  return getConversationPath(conversations, documentId)[0]?.id ?? documentId;
}

/** Main documents in a space, in the order they were added. */
export function getSpaceRootIds(session: Pick<WorkspaceSession, "documentIds"> | null | undefined, conversations: Record<string, Conversation>) {
  return session ? getSessionRootDocuments(session, conversations).map((root) => root.id) : [];
}

export function isInSpace(session: Pick<WorkspaceSession, "documentIds"> | null | undefined, conversations: Record<string, Conversation>, documentId: string) {
  if (!session || !conversations[documentId]) return false;
  const rootId = getFamilyRootId(conversations, documentId);
  return session.documentIds.some((id) => getFamilyRootId(conversations, id) === rootId);
}

/** Spaces in their fixed order: the order you made or arranged them, which ⌃1–⌃9 follow. */
export function orderSpaces(sessions: WorkspaceSessions | undefined) {
  if (!sessions) return [];
  const listed = sessions.tabIds.map((id) => sessions.items[id]).filter(Boolean);
  const rest = Object.values(sessions.items).filter((session) => !sessions.tabIds.includes(session.id))
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.name.localeCompare(right.name));
  return [...listed, ...rest];
}

/** Add documents to a session that is not necessarily active, as dropping documents on its tab does. */
export function addDocumentsToSession(state: AppState, sessionId: string, documentIds: string[]): AppState {
  const session = state.sessions?.items[sessionId];
  if (!session) return state;
  const added = [...new Set(sessionDocumentIds(documentIds, state.conversations).map((id) => getFamilyRootId(state.conversations, id)))]
    .filter((id) => !isInSpace(session, state.conversations, id));
  if (!added.length) return state;
  const next = withAutoName({ ...session, documentIds: [...session.documentIds, ...added] }, state.conversations);
  return { ...state, sessions: { ...state.sessions!, items: { ...state.sessions!.items, [sessionId]: next } } };
}

/** Takes a document and its family out of a space; the documents themselves stay in the vault. */
export function removeDocumentFromSession(state: AppState, sessionId: string, documentId: string): AppState {
  const session = state.sessions?.items[sessionId];
  if (!session || !isInSpace(session, state.conversations, documentId)) return state;
  const rootId = getFamilyRootId(state.conversations, documentId);
  const documentIds = session.documentIds.filter((id) => id !== documentId && getFamilyRootId(state.conversations, id) !== rootId);
  const next = withAutoName({ ...session, documentIds,
    ...(session.activeDocumentId === documentId ? { activeDocumentId: documentIds.at(-1) } : {}) }, state.conversations);
  if (!next.activeDocumentId) delete next.activeDocumentId;
  return { ...state, sessions: { ...state.sessions!, items: { ...state.sessions!.items, [sessionId]: next } } };
}

/**
 * Leave where you are as it is now and go to `targetId`, or to "No space" for
 * null. The caller then focuses the returned document, which restores that
 * place; null means the space is empty and shows its start panel.
 */
export function switchSession(state: AppState, targetId: string | null, now = new Date().toISOString()): { state: AppState; documentId: string | null } {
  const sessions = state.sessions ?? emptySessions();
  const target = targetId ? sessions.items[targetId] : null;
  if (targetId && !target) return { state, documentId: null };
  if (sessions.activeId === targetId) return { state, documentId: (target ? target.activeDocumentId : sessions.home?.activeDocumentId) ?? null };
  const focused = state.conversations[state.activeConversationId] && !isCompactDocument(state.conversations[state.activeConversationId])
    ? state.activeConversationId : undefined;
  const items = { ...sessions.items };
  let home = sessions.home;
  const current = sessions.activeId ? items[sessions.activeId] : undefined;
  if (current) {
    // Only a document in the space is its place; a visitor closes when you leave.
    const left: WorkspaceSession = { ...current };
    if (focused && isInSpace(current, state.conversations, focused)) left.activeDocumentId = focused;
    if (state.documentDock) left.documentDock = state.documentDock; else delete left.documentDock;
    items[current.id] = left;
  } else {
    home = { ...(focused ? { activeDocumentId: focused } : {}), ...(state.documentDock ? { documentDock: state.documentDock } : {}) };
  }
  if (target) items[target.id] = { ...target, lastOpenedAt: now };
  const place = target ?? home;
  const documentId = target
    ? [target.activeDocumentId, ...[...target.documentIds].reverse()].find((id): id is string => Boolean(id && state.conversations[id] && isInSpace(target, state.conversations, id))) ?? null
    : home?.activeDocumentId && state.conversations[home.activeDocumentId] ? home.activeDocumentId : null;
  const { documentDock: _dock, ...rest } = state;
  const nextSessions: WorkspaceSessions = { ...sessions, items, activeId: targetId,
    tabIds: !targetId || sessions.tabIds.includes(targetId) ? sessions.tabIds : [...sessions.tabIds, targetId] };
  if (home) nextSessions.home = home; else delete nextSessions.home;
  return {
    state: { ...rest, ...(place?.documentDock ? { documentDock: place.documentDock } : {}), sessions: nextSessions },
    documentId,
  };
}

/** A new space, empty or holding `documentIds`; it joins the end of the list and you go into it. */
export function createSession(state: AppState, now = new Date().toISOString(), options: { name?: string; atTabIndex?: number; documentIds?: string[] } = {}): { state: AppState; sessionId: string } {
  const sessions = state.sessions ?? emptySessions();
  const id = `session-${crypto.randomUUID()}`;
  const name = options.name?.trim().slice(0, 120);
  const documentIds = [...new Set(sessionDocumentIds(options.documentIds ?? [], state.conversations).map((documentId) => getFamilyRootId(state.conversations, documentId)))];
  const session: WorkspaceSession = withAutoName({ id, name: name || "New space", nameSource: name ? "user" : "auto",
    color: nextColor(sessions), documentIds, createdAt: now, lastOpenedAt: now }, state.conversations);
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

/** Deleting a space forgets its list and layout; its documents stay in the vault. Deleting the one you're in returns you to No space. */
export function deleteSession(state: AppState, sessionId: string, now = new Date().toISOString()): { state: AppState; wasActive: boolean; documentId: string | null } {
  if (!state.sessions?.items[sessionId]) return { state, wasActive: false, documentId: null };
  const wasActive = state.sessions.activeId === sessionId;
  const left = wasActive ? switchSession(state, null, now) : { state, documentId: null };
  const sessions = left.state.sessions!;
  const { [sessionId]: _deleted, ...items } = sessions.items;
  return { state: { ...left.state, sessions: { ...sessions, items, tabIds: sessions.tabIds.filter((id) => id !== sessionId) } },
    wasActive, documentId: left.documentId };
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
