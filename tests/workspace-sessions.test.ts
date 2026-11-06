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
  addDocumentsToSession, applySessionAutoName, createSession, deleteSession, describeSession, duplicateSession,
  getActiveSession, getSpaceRootIds, isInSpace, orderSpaces, placeSessionTab, removeDocumentFromSession, renameSession, sortSessions, switchSession,
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

describe("spaces", () => {
  test("nothing joins a space by being looked at; you start in No space", () => {
    const state = fixture();
    expect(getActiveSession(state)).toBeNull();
    const created = createSession(state, now);
    expect(getActiveSession(created.state)!.documentIds).toEqual([]);
    expect(getActiveSession(created.state)!.name).toBe("New space");
    // Focusing another document changes nothing about the space.
    const focused = { ...created.state, activeConversationId: "system" };
    expect(getActiveSession(focused)!.documentIds).toEqual([]);
  });

  test("documents join on purpose, with their family, and a name is written once", () => {
    let state = createSession(fixture(), now).state;
    const id = state.sessions!.activeId!;
    const rootId = state.rootId;
    // Adding a side document adds its main document, which brings the family along.
    state = addDocumentsToSession(state, id, ["guards"]);
    expect(state.sessions!.items[id].documentIds).toEqual([rootId]);
    expect(isInSpace(state.sessions!.items[id], state.conversations, "guards")).toBe(true);
    expect(state.sessions!.items[id].name).toBe("Angular");
    expect(addDocumentsToSession(state, id, [rootId])).toBe(state);
    const nameKey = state.sessions!.items[id].nameKey!;
    // Later additions keep the name it already has.
    state = addDocumentsToSession(state, id, ["system"]);
    expect(state.sessions!.items[id].name).toBe("Angular");
    expect(getSpaceRootIds(state.sessions!.items[id], state.conversations)).toEqual([rootId, "system"]);
    // An AI name applies only for the documents it was written for, and never over a rename.
    expect(state.sessions!.items[id].nameKey).toBe(nameKey);
    expect(applySessionAutoName(state, id, nameKey, "“Frontend interview prep.”").sessions!.items[id].name).toBe("Frontend interview prep");
    expect(applySessionAutoName(state, id, "stale", "Old")).toBe(state);
    expect(applySessionAutoName(renameSession(state, id, "Mine"), id, nameKey, "AI")).toEqual(renameSession(state, id, "Mine"));
    expect(describeSession({ documentIds: [rootId, "system", "taxes"] }, state.conversations)).toBe("Angular, System design interview +1");
    // Removing a side document takes its whole family out; the documents stay.
    state = removeDocumentFromSession(state, id, "guards");
    expect(state.sessions!.items[id].documentIds).toEqual(["system"]);
    expect(state.conversations.guards).toBeDefined();
  });

  test("a new space can start from the open tabs", () => {
    const created = createSession(fixture(), now, { documentIds: ["guards", "taxes", "missing"] });
    expect(getActiveSession(created.state)!.documentIds).toEqual([created.state.rootId, "taxes"]);
    expect(getActiveSession(created.state)!.name).toBe("Angular & Taxes 2026");
  });

  test("switching keeps each place, including No space, and visitors never become a space's place", () => {
    let state = { ...fixture(), activeConversationId: "taxes", documentDock: { width: .4, tree: { type: "pane" as const, documentId: "system" } } };
    const created = createSession(state, later, { documentIds: ["guards"] });
    state = created.state;
    const space = created.sessionId;
    expect(state.sessions!.home).toEqual({ activeDocumentId: "taxes", documentDock: { width: .4, tree: { type: "pane", documentId: "system" } } });
    expect(state.documentDock).toBeUndefined();
    // Focus a visitor, then leave: the space remembers its own document, not the visitor.
    state = { ...state, activeConversationId: "guards" };
    state = switchSession(state, null, later).state;
    state = switchSession({ ...state, activeConversationId: "system" }, space, later).state;
    const visiting = { ...state, activeConversationId: "taxes" };
    const home = switchSession(visiting, null, later);
    expect(home.documentId).toBe("system");
    expect(home.state.sessions!.items[space].activeDocumentId).toBe("guards");
    expect(home.state.sessions!.activeId).toBeNull();
    const back = switchSession(home.state, space, later);
    expect(back.documentId).toBe("guards");
    expect(switchSession(back.state, space, later).state).toBe(back.state);
  });

  test("rename, duplicate and delete never touch documents; deleting the space you're in returns to No space", () => {
    let state = createSession({ ...fixture(), activeConversationId: "taxes" }, now, { name: "Taxes", documentIds: ["taxes"] }).state;
    const id = state.sessions!.activeId!;
    expect(state.sessions!.items[id]).toMatchObject({ name: "Taxes", nameSource: "user", documentIds: ["taxes"] });
    const second = createSession(state, later, { name: "Other" });
    state = placeSessionTab(second.state, second.sessionId, 0);
    expect(orderSpaces(state.sessions).map((space) => space.id)).toEqual([second.sessionId, id]);
    state = duplicateSession(state, id, later);
    expect(Object.values(state.sessions!.items).filter((session) => session.name === "Taxes copy")).toHaveLength(1);
    const deleted = deleteSession(state, second.sessionId, later);
    expect(deleted.wasActive).toBe(true);
    expect(deleted.state.sessions!.activeId).toBeNull();
    expect(deleted.state.sessions!.items[second.sessionId]).toBeUndefined();
    expect(deleted.documentId).toBe("taxes");
    expect(Object.keys(deleted.state.conversations).sort()).toEqual(Object.keys(state.conversations).sort());
    expect(renameSession(state, id, "  ").sessions!.items[id].nameSource).toBe("auto");
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

  test("spaces survive local, workspace and Markdown round trips and drop what no longer exists", () => {
    let state = createSession(fixture(), now, { documentIds: ["system"] }).state;
    state = switchSession(state, null, later).state;
    state = switchSession(state, Object.keys(state.sessions!.items)[0], later).state;
    const markdown = createMarkdownWorkspace(state);
    for (const restored of [hydratePersistedState(state), createAppStateFromWorkspaceDocument(createWorkspaceDocument(state)),
      parseMarkdownWorkspace(markdown.manifest, markdown.files)]) {
      expect(restored?.sessions).toEqual(state.sessions);
    }
    expect(state.sessions!.home).toBeDefined();
    expect(hasSameAuthoredState(state, renameSession(state, state.sessions!.activeId!, "Renamed"))).toBe(false);
    const broken = normalizeWorkspaceSessions({ items: { s: { id: "s", name: "", color: "red", documentIds: ["system", "gone", 4] },
      wrong: { id: "other" } }, tabIds: ["s", "missing"], activeId: "missing" }, state.conversations)!;
    expect(broken.items.s).toMatchObject({ name: "Untitled session", color: "#0d7a6f", documentIds: ["system"], nameSource: "auto" });
    expect(broken.items.wrong).toBeUndefined();
    expect(broken).toMatchObject({ tabIds: ["s"], activeId: null });
    expect(broken.home).toBeUndefined();
    expect(normalizeWorkspaceSessions("nope", state.conversations)).toBeUndefined();
  });

  test("AI names are asked for only when a space mixes document families", () => {
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
    expect(atRoot.siblings.map((document) => document.id)).toEqual([rootId]);
    expect(atRoot.children.map((document) => document.id).sort()).toEqual(["canmatch", "guards", "urltree"]);
    expect(atRoot.linked.map((document) => document.id)).toEqual(["taxes"]);
    const atChild = getDocumentNeighbors(state.conversations, "urltree", [{ id: "e", sourceId: "system", targetId: "urltree", type: null, kind: "mention", directed: true }])!;
    expect(atChild.parent?.id).toBe(rootId);
    expect(atChild.siblings[atChild.index].id).toBe("urltree");
    expect(atChild.linked.map((document) => document.id)).toEqual(["system"]);
  });
});
