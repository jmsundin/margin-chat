import { describe, expect, test } from "bun:test";
import { createEmptyState, createMainConversation, createSideConversation } from "../client/src/initialState";
import { addChildConversation, addRootConversation, deleteThread } from "../client/src/lib/workspaceCommands";
import { focusDocument, getDocumentWidth, getDocumentWorkspace, minimizeDocument, reorderDocument, setDocumentWidth } from "../client/src/lib/documentWorkspace";
import { buildConversationGraphScene } from "../client/src/lib/conversationGraph";

function fixture() {
  let state = createEmptyState();
  const rootId = state.rootId;
  for (const [id, parentId] of [["a", rootId], ["b", rootId], ["nested", "a"]]) {
    state = addChildConversation(state, createSideConversation({ id, sourceConversation: state.conversations[parentId] }), { activate: true });
  }
  state = addRootConversation(state, createMainConversation({ id: "unrelated" }));
  return { state: focusDocument(state, rootId), rootId };
}

describe("side-by-side document workspace", () => {
  test("new side documents attach to the focused document and appear next to it, with Map edges", () => {
    const { state, rootId } = fixture();
    const view = getDocumentWorkspace(state.conversations, "nested");
    expect(view.documents.map((document) => document.id)).toEqual([rootId, "b", "a", "nested"]);
    expect(state.conversations.nested.parentId).toBe("a");
    expect(state.conversations.a.childIds).toEqual(["nested"]);
    const scene = buildConversationGraphScene({ conversations: state.conversations, selectedConversationId: "nested", mode: "overview" });
    expect(scene.edges.map((edge) => [edge.parentConversationId, edge.childConversationId])).toEqual(
      expect.arrayContaining([[rootId, "a"], [rootId, "b"], ["a", "nested"]]),
    );
  });

  test("moving a side tab before main changes panel order without changing Map edges or graph positions", () => {
    const { state, rootId } = fixture();
    const moved = reorderDocument(state, "a", rootId);
    expect(getDocumentWorkspace(moved.conversations, rootId).documents.map((document) => document.id)).toEqual(["a", rootId, "b", "nested"]);
    expect(moved.conversations.a).toBe(state.conversations.a);
    expect(moved.conversations[rootId].childIds).toEqual(state.conversations[rootId].childIds);
    expect(moved.graphLayouts).toBe(state.graphLayouts);
    expect(reorderDocument(moved, "a", "unrelated")).toBe(moved);
    expect(reorderDocument(moved, "a", "a")).toBe(moved);
  });

  test("minimizing preserves the document and descendants; opening independently restores its ancestors", () => {
    const { state, rootId } = fixture();
    let next = focusDocument(state, "nested");
    next = minimizeDocument(next, "a");
    expect(next.activeConversationId).toBe("nested");
    expect(getDocumentWorkspace(next.conversations, "nested").visibleDocuments.map((document) => document.id)).toEqual([rootId, "b", "nested"]);
    next = minimizeDocument(next, "nested");
    expect(next.activeConversationId).toBe(rootId);
    expect(next.conversations.nested).toBe(state.conversations.nested);
    const reopened = focusDocument(next, "nested");
    expect(reopened.activeConversationId).toBe("nested");
    expect(reopened.rootId).toBe(rootId);
    expect(getDocumentWorkspace(reopened.conversations, "nested").minimizedIds).toEqual([]);
    expect(minimizeDocument(reopened, rootId)).toBe(reopened);
  });

  test("switching unrelated main documents retains each family's display settings", () => {
    const { state, rootId } = fixture();
    const changed = minimizeDocument(reorderDocument(state, "b", rootId), "a");
    const away = focusDocument(changed, "unrelated");
    expect(getDocumentWorkspace(away.conversations, away.activeConversationId).documents.map((document) => document.id)).toEqual(["unrelated"]);
    const restored = focusDocument(away, rootId);
    expect(getDocumentWorkspace(restored.conversations, rootId).documents[0].id).toBe("b");
    expect(getDocumentWorkspace(restored.conversations, rootId).minimizedIds).toEqual(["a"]);
  });

  test("deleting a side document removes descendants and stale layout entries while preserving the parent", () => {
    const { state, rootId } = fixture();
    const next = deleteThread(focusDocument(state, "nested"), "a", createMainConversation({ id: "unused" }));
    expect(next.conversations.a).toBeUndefined();
    expect(next.conversations.nested).toBeUndefined();
    expect(next.conversations[rootId].childIds).toEqual(["b"]);
    expect(next.conversations[rootId].documentLayout?.order).toEqual([rootId, "b"]);
    expect(next.activeConversationId).toBe(rootId);
    expect(next.conversations.unrelated).toBe(state.conversations.unrelated);
  });

  test("deleting the active child restores a minimized parent before focusing it", () => {
    const { state } = fixture();
    const next = deleteThread(minimizeDocument(focusDocument(state, "nested"), "a"), "nested", createMainConversation({ id: "unused" }));
    expect(next.activeConversationId).toBe("a");
    expect(getDocumentWorkspace(next.conversations, "a").visibleDocuments.map((document) => document.id)).toContain("a");
  });

  test("widths follow each document through focus, reordering, minimizing and new side documents", () => {
    const { state, rootId } = fixture();
    let next = setDocumentWidth(setDocumentWidth(state, "a", 725), rootId, 420);
    expect(next.conversations[rootId].updatedAt).toBe(state.conversations[rootId].updatedAt);
    next = focusDocument(minimizeDocument(reorderDocument(next, "a", rootId), "a"), "unrelated");
    next = addChildConversation(next, createSideConversation({ id: "new-side", sourceConversation: next.conversations[rootId] }));
    next = focusDocument(next, "a");
    expect(getDocumentWidth(next.conversations, "a")).toBe(725);
    expect(getDocumentWidth(next.conversations, rootId)).toBe(420);
    expect(getDocumentWidth(next.conversations, "b")).toBeUndefined();
    expect(getDocumentWidth(next.conversations, "unrelated")).toBeUndefined();
    next = setDocumentWidth(next, "a", undefined);
    expect(getDocumentWidth(next.conversations, "a")).toBeUndefined();
    expect(getDocumentWidth(next.conversations, rootId)).toBe(420);
    expect(setDocumentWidth(next, "a", undefined)).toBe(next);
    expect(setDocumentWidth(next, rootId, NaN)).toBe(next);
    expect(setDocumentWidth(next, "missing", 700)).toBe(next);
    expect(getDocumentWidth(setDocumentWidth(next, "a", 50).conversations, "a")).toBe(320);
    expect(getDocumentWidth(setDocumentWidth(next, "a", 1800).conversations, "a")).toBe(980);
  });

  test("deleting a branch prunes only its saved widths; resetting the final width restores legacy sizing", () => {
    const { state, rootId } = fixture();
    let next = setDocumentWidth(setDocumentWidth(setDocumentWidth(state, "a", 640), "nested", 550), rootId, 800);
    next = deleteThread(next, "a", createMainConversation({ id: "unused" }));
    expect(next.conversations[rootId].documentLayout?.widthsById).toEqual({ [rootId]: 800 });
    next = setDocumentWidth(next, rootId, undefined);
    expect(next.conversations[rootId].documentLayout?.widthsById).toBeUndefined();
    const standalone = createEmptyState();
    expect(standalone.conversations[standalone.rootId].documentLayout).toBeUndefined();
    expect(getDocumentWidth(setDocumentWidth(standalone, standalone.rootId, 580).conversations, standalone.rootId)).toBe(580);
  });
});
