import { describe, expect, test } from "bun:test";
import { markdownIdentitySuffix } from "@margin-chat/workspace-contracts";
import { createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";
import { getGraphAnalysisEdges } from "../client/src/lib/graphAnalysis";
import {
  createDocumentLinkResolver,
  documentGraphEdgeLabel,
  getDocumentGraphEdges,
  restoreDocumentConnections,
  setDocumentRelation,
} from "../client/src/lib/documentRelations";
import type { AppState, Conversation } from "../client/src/types";

function note(state: AppState, id: string, title: string, content = ""): Conversation {
  const conversation = createStandaloneNoteConversation({ createdAt: "2026-10-01T10:00:00.000Z", id, noteId: `${id}-note` });
  conversation.title = title;
  conversation.notes![0].content = content;
  state.conversations[id] = conversation;
  return conversation;
}

const summary = (state: AppState) => getDocumentGraphEdges(state.conversations)
  .map(({ sourceId, targetId, type, kind, directed }) => ({ sourceId, targetId, type, kind, directed }));

describe("document graph edges", () => {
  test("saved relations and links written in text both become edges", () => {
    const state = createEmptyState();
    note(state, "claim", "Claim", "See [[Bell test]] and [supports:: [[Evidence]]], not [[Missing]] or [[Claim]].");
    note(state, "bell", "Bell test");
    note(state, "evidence", "Evidence");
    note(state, "paper", "Paper").relations = [{ type: "contradicts", targetConversationId: "claim", weight: 0.4, origin: "ai" }];
    expect(summary(state)).toEqual([
      { sourceId: "claim", targetId: "evidence", type: "supports", kind: "mention", directed: true },
      { sourceId: "claim", targetId: "bell", type: null, kind: "mention", directed: true },
      { sourceId: "paper", targetId: "claim", type: "contradicts", kind: "relation", directed: false },
    ]);
    const relation = getDocumentGraphEdges(state.conversations).find((edge) => edge.kind === "relation")!;
    expect(relation).toMatchObject({ weight: 0.4, origin: "ai" });
    expect(documentGraphEdgeLabel(relation)).toBe("Contradicts");
    expect(documentGraphEdgeLabel({ type: null, kind: "mention" })).toBe("Mentions");
    // The analysis views count every edge, once per pair and kind.
    expect(getGraphAnalysisEdges(state.conversations).filter((edge) => edge.kind === "relation")).toHaveLength(3);
  });

  test("a link in text is not drawn twice when a relation, personal link or the tree already joins the pair", () => {
    const state = createEmptyState();
    const source = note(state, "source", "Source", "[[Typed]] [[Linked]] [[Parent]] [cites:: [[Typed]]] [[Plain]]");
    note(state, "typed", "Typed");
    note(state, "linked", "Linked");
    note(state, "parent", "Parent");
    note(state, "plain", "Plain");
    source.relations = [{ type: "cites", targetConversationId: "typed" }];
    source.linkedConversationIds = ["linked"];
    source.parentId = "parent";
    expect(summary(state)).toEqual([
      { sourceId: "source", targetId: "plain", type: null, kind: "mention", directed: true },
      { sourceId: "source", targetId: "typed", type: "cites", kind: "relation", directed: true },
    ]);
  });

  test("relations to documents that are not loaded are kept but not drawn", () => {
    const state = createEmptyState();
    note(state, "source", "Source").relations = [{ type: "cites", target: "Elsewhere" }, { type: "cites", targetConversationId: "gone" }];
    expect(getDocumentGraphEdges(state.conversations)).toEqual([]);
  });

  test("links resolve by filename, id or a unique title, ignoring folders", () => {
    const state = createEmptyState();
    note(state, "first", "Same title");
    note(state, "second", "Same title");
    note(state, "only", "Only One");
    const resolve = createDocumentLinkResolver(state.conversations);
    expect(resolve(`Folder/Same title — ${markdownIdentitySuffix("second")}`)).toBe("second");
    expect(resolve(`Same title — ${markdownIdentitySuffix("first")} (2).md`)).toBe("first");
    expect(resolve("only")).toBe("only");
    expect(resolve("only one")).toBe("only");
    expect(resolve("Same title")).toBeNull();
    expect(resolve("Nothing")).toBeNull();
  });
});

describe("setting a relation from the map", () => {
  const at = "2026-10-02T00:00:00.000Z";

  function connected() {
    const state = createEmptyState();
    note(state, "a", "A").linkedConversationIds = ["b"];
    note(state, "b", "B");
    return state;
  }

  test("typing a personal connection replaces it with a relation from the chosen side", () => {
    const state = setDocumentRelation(connected(), { sourceId: "b", targetId: "a", type: "supports", updatedAt: at });
    expect(state.conversations.a.linkedConversationIds).toEqual([]);
    expect(state.conversations.b.relations).toEqual([{ type: "supports", targetConversationId: "a", origin: "user", createdAt: at }]);
    expect(state.conversations.a.updatedAt).toBe(at);
    expect(state.conversations.b.updatedAt).toBe(at);
  });

  test("changing the type keeps the relation's attributes, and clearing it restores an untyped connection", () => {
    let state = connected();
    state.conversations.a.linkedConversationIds = [];
    state.conversations.a.relations = [{ type: "cites", targetConversationId: "b", weight: 0.7, note: "key", createdAt: "2026-10-01T00:00:00.000Z" }];
    state = setDocumentRelation(state, { sourceId: "a", targetId: "b", type: "elaborates", previousType: "cites", updatedAt: at });
    expect(state.conversations.a.relations).toEqual([
      { type: "elaborates", targetConversationId: "b", weight: 0.7, origin: "user", note: "key", createdAt: "2026-10-01T00:00:00.000Z" },
    ]);
    state = setDocumentRelation(state, { sourceId: "a", targetId: "b", type: null, previousType: "elaborates", updatedAt: at });
    expect(state.conversations.a.relations).toBeUndefined();
    expect(state.conversations.a.linkedConversationIds).toEqual(["b"]);
  });

  test("removing a relation leaves no connection, and undo restores both documents", () => {
    const before = connected();
    const typed = setDocumentRelation(before, { sourceId: "a", targetId: "b", type: "depends-on", updatedAt: at });
    const removed = setDocumentRelation(typed, { sourceId: "a", targetId: "b", type: null, previousType: "depends-on", remove: true, updatedAt: at });
    expect(removed.conversations.a.relations).toBeUndefined();
    expect(removed.conversations.a.linkedConversationIds).toEqual([]);
    expect(removed.conversations.b.linkedConversationIds).toBeUndefined();
    const restored = restoreDocumentConnections(removed, [before.conversations.a, before.conversations.b], at);
    expect(restored.conversations.a.linkedConversationIds).toEqual(["b"]);
    expect(restored.conversations.a.relations).toBeUndefined();
    expect(restored.conversations.b.linkedConversationIds).toBeUndefined();
  });

  test("a relation to the same document or a missing one changes nothing", () => {
    const state = connected();
    expect(setDocumentRelation(state, { sourceId: "a", targetId: "a", type: "cites", updatedAt: at })).toBe(state);
    expect(setDocumentRelation(state, { sourceId: "a", targetId: "zzz", type: "cites", updatedAt: at })).toBe(state);
  });
});
