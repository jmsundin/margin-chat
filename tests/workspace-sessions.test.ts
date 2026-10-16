import { describe, expect, test } from "bun:test";
import {
  createAppStateFromWorkspaceDocument, createMarkdownWorkspace, createMarginDocument, createWorkspaceDocument,
  normalizeWorkspaceSessions, parseMarkdownWorkspace, type AppState,
} from "@margin-chat/workspace-contracts";
import { createEmptyState, createMainConversation, createSideConversation } from "../client/src/initialState";
import { hydratePersistedState } from "../client/src/lib/appState";
import { hasSameAuthoredState } from "../client/src/lib/vaultWorkspace";
import { getDocumentNeighbors } from "../client/src/lib/documentNeighbors";
import { buildSessionNamePrompt } from "../client/src/lib/useSessionAutoNames";
import {
  addDocumentsToSession, applySessionAutoName, createSession, deleteSession, describeSession, duplicateSession, ensureSessions,
  getActiveSession, placeSessionTab, recordSessionDocument, removeDocumentFromSession, removeSessionTab, renameSession, sortSessions, switchSession,
} from "../client/src/lib/workspaceSessions";
import { addChildConversation } from "../client/src/lib/workspaceCommands";

const now = "2026-10-16T12:00:00.000Z";
const later = "2026-10-16T13:00:00.000Z";

function fixture(): AppState {
  let state = createEmptyState();
  const root = state.conversations[state.rootId];
  state.conversations[root.id] = { ...root, title: "Angular" };
  for (const [id, title] of [["system", "System design interview"], ["taxes", "Taxes 2026"]]) {
    state.conversations[id] = { ...createMainConversation({ id, createdAt: now }), title };
  }
  const side = createSideConversation({ id: "guards", sourceConversation: state.conversations[root.id], createdAt: now });
  state = addChildConversation(state, { ...side, title: "Router guards" });
  return { ...state, activeConversationId: root.id };
}

describe("sessions", () => {
  test("a workspace's open documents become its first session in the tab bar", () => {
    const state = fixture();
    const next = ensureSessions(state, [state.rootId, "guards"], now);
    const session = getActiveSession(next)!;
    expect(next.sessions!.tabIds).toEqual([session.id]);
    expect(session.documentIds).toEqual([state.rootId, "guards"]);
    expect(session.name).toBe("Angular");
    expect(ensureSessions(next, [], later)).toBe(next);
  });

  test("focused documents join the active session and the automatic name follows its families", () => {
    let state = ensureSessions(fixture(), [], now);
    const rootId = state.rootId;
    state = recordSessionDocument(state, "system");
    expect(getActiveSession(state)!.name).toBe("Angular & System design interview");
    expect(recordSessionDocument(state, "system")).toBe(state);
    // A child joins without changing which families the session holds.
    const nameKey = getActiveSession(state)!.nameKey!;
    state = recordSessionDocument(state, "guards");
    expect(getActiveSession(state)!.nameKey).toBe(nameKey);
    // Margin notes travel with their document instead of joining on their own.
    const note = createMarginDocument(state.conversations[rootId], { id: "note", content: "Check", createdAt: now, updatedAt: now }, "note");
    state = addChildConversation(state, note);
    expect(recordSessionDocument(state, "note")).toBe(state);
    // An AI name applies only while the same documents are in the session.
    const id = getActiveSession(state)!.id;
    expect(getActiveSession(applySessionAutoName(state, id, nameKey, "“Frontend interview prep.”"))!.name).toBe("Frontend interview prep");
    expect(applySessionAutoName(state, id, "stale", "Old")).toBe(state);
    expect(applySessionAutoName(renameSession(state, id, "Mine"), id, nameKey, "AI")).toEqual(renameSession(state, id, "Mine"));
    expect(describeSession({ documentIds: [rootId, "system", "taxes"] }, state.conversations)).toBe("Angular, System design interview +1");
  });

  test("switching keeps each session's place and layout; new sessions start empty", () => {
    let state = ensureSessions(fixture(), [], now);
    const first = state.sessions!.activeId!;
    state = { ...state, activeConversationId: "guards", documentDock: { width: .4, tree: { type: "pane", documentId: "taxes" } } };
    const created = createSession(state, later);
    state = created.state;
    expect(state.sessions!.activeId).toBe(created.sessionId);
    expect(state.sessions!.tabIds).toEqual([first, created.sessionId]);
    expect(state.documentDock).toBeUndefined();
    expect(state.sessions!.items[first].activeDocumentId).toBe("guards");
    state = recordSessionDocument({ ...state, activeConversationId: "taxes" }, "taxes");
    const back = switchSession(state, first, later);
    expect(back.documentId).toBe("guards");
    expect(back.state.documentDock).toEqual({ width: .4, tree: { type: "pane", documentId: "taxes" } });
    expect(back.state.sessions!.items[created.sessionId].activeDocumentId).toBe("taxes");
    expect(switchSession(back.state, first, later).state).toBe(back.state);
  });

  test("tabs, rename, duplicate and delete never touch documents", () => {
    let state = ensureSessions(fixture(), [], now);
    const first = state.sessions!.activeId!;
    const second = createSession(state, later, { name: "Taxes" });
    state = addDocumentsToSession(second.state, second.sessionId, ["taxes", "missing"]);
    expect(state.sessions!.items[second.sessionId]).toMatchObject({ name: "Taxes", nameSource: "user", documentIds: ["taxes"] });
    state = placeSessionTab(state, second.sessionId, 0);
    expect(state.sessions!.tabIds).toEqual([second.sessionId, first]);
    const removed = removeSessionTab(state, second.sessionId);
    expect(removed.switchTo).toBe(first);
    expect(removed.state.sessions!.items[second.sessionId]).toBeDefined();
    expect(removeSessionTab(removed.state, first).switchTo).toBeNull();
    state = duplicateSession(removed.state, second.sessionId, later);
    expect(Object.values(state.sessions!.items).filter((session) => session.name === "Taxes copy")).toHaveLength(1);
    state = removeDocumentFromSession(state, second.sessionId, "taxes");
    expect(state.sessions!.items[second.sessionId].documentIds).toEqual([]);
    expect(deleteSession(state, first).switchTo).toBeNull();
    const deleted = deleteSession(state, second.sessionId);
    expect(deleted.state.sessions!.items[second.sessionId]).toBeUndefined();
    expect(deleted.switchTo).toBe(first);
    expect(Object.keys(deleted.state.conversations).sort()).toEqual(Object.keys(state.conversations).sort());
    expect(renameSession(state, second.sessionId, "  ").sessions!.items[second.sessionId].nameSource).toBe("auto");
  });

  test("sessions sort like the sidebar's documents", () => {
    const sessions = [
      { id: "a", name: "beta", nameSource: "user" as const, color: "#000000", documentIds: ["x"], createdAt: now, lastOpenedAt: now },
      { id: "b", name: "Alpha", nameSource: "user" as const, color: "#000000", documentIds: ["y", "z"], createdAt: now, lastOpenedAt: later },
    ];
    expect(sortSessions(sessions, "alphabetical", []).map((session) => session.id)).toEqual(["b", "a"]);
    expect(sortSessions(sessions, "recent", []).map((session) => session.id)).toEqual(["b", "a"]);
    expect(sortSessions(sessions, "semantic", ["x", "z", "y"]).map((session) => session.id)).toEqual(["a", "b"]);
  });

  test("sessions survive local, workspace and Markdown round trips and drop what no longer exists", () => {
    const state = recordSessionDocument(ensureSessions(fixture(), [], now), "system");
    const markdown = createMarkdownWorkspace(state);
    for (const restored of [hydratePersistedState(state), createAppStateFromWorkspaceDocument(createWorkspaceDocument(state)),
      parseMarkdownWorkspace(markdown.manifest, markdown.files)]) {
      expect(restored?.sessions).toEqual(state.sessions);
    }
    expect(hasSameAuthoredState(state, renameSession(state, state.sessions!.activeId!, "Renamed"))).toBe(false);
    const broken = normalizeWorkspaceSessions({ items: { s: { id: "s", name: "", color: "red", documentIds: ["system", "gone", 4] },
      wrong: { id: "other" } }, tabIds: ["s", "missing"], activeId: "missing" }, state.conversations)!;
    expect(broken.items.s).toMatchObject({ name: "Untitled session", color: "#0d7a6f", documentIds: ["system"], nameSource: "auto" });
    expect(broken.items.wrong).toBeUndefined();
    expect(broken).toMatchObject({ tabIds: ["s"], activeId: null });
    expect(normalizeWorkspaceSessions("nope", state.conversations)).toBeUndefined();
  });

  test("AI names are asked for only when a session mixes document families", () => {
    const state = fixture();
    expect(buildSessionNamePrompt([state.rootId, "guards"], state.conversations)).toBe("");
    expect(buildSessionNamePrompt([state.rootId, "system"], state.conversations)).toContain("- System design interview");
  });
});

describe("document neighbours", () => {
  test("siblings, children and links around the focused document", () => {
    let state = fixture();
    const rootId = state.rootId;
    for (const [id, title] of [["canmatch", "CanActivate vs CanMatch"], ["urltree", "Return a UrlTree"]]) {
      const child = createSideConversation({ id, sourceConversation: state.conversations[rootId], createdAt: now });
      state = addChildConversation(state, { ...child, title, branchAnchor: { id: `anchor-${id}`, sourceConversationId: rootId,
        sourceMessageId: "m", startOffset: 0, endOffset: 1, quote: "A", prompt: "", createdAt: now } });
    }
    state.conversations[rootId] = { ...state.conversations[rootId], linkedConversationIds: ["taxes"] };
    const atRoot = getDocumentNeighbors(state.conversations, rootId, [])!;
    expect(atRoot.parent).toBeNull();
    expect(atRoot.siblings.map((document) => document.id)).toEqual([rootId, "guards"]);
    expect(atRoot.children.map((document) => document.id).sort()).toEqual(["canmatch", "urltree"]);
    expect(atRoot.linked.map((document) => document.id)).toEqual(["taxes"]);
    const atChild = getDocumentNeighbors(state.conversations, "urltree", [{ id: "e", sourceId: "system", targetId: "urltree", type: null, kind: "mention", directed: true }])!;
    expect(atChild.parent?.id).toBe(rootId);
    expect(atChild.siblings[atChild.index].id).toBe("urltree");
    expect(atChild.linked.map((document) => document.id)).toEqual(["system"]);
  });
});
