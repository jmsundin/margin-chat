import { describe, expect, test } from "bun:test";
import { createChildConversation, createEmptyState, createMainConversation, createStandaloneNoteConversation } from "../client/src/initialState";
import { addChildConversation, addRootConversation, appendMessageDelta, deleteThread, removeConversationDocument } from "../client/src/lib/workspaceCommands";

describe("workspace commands", () => {
  test("removing a shared attachment affects only the chosen chat", () => {
    let state = createEmptyState();
    const parent = state.conversations[state.rootId];
    const document = { id: "shared", filename: "article.txt", mimeType: "text/plain", sizeBytes: 12, status: "ready" as const, createdAt: parent.createdAt, error: null };
    parent.documents = [document];
    const child = createChildConversation({ id: "branch", parentConversation: parent });
    state = addChildConversation(state, child);
    const next = removeConversationDocument(state, child.id, document.id, "2026-09-19T12:00:00Z");
    expect(next.conversations[child.id].documents).toEqual([]);
    expect(next.conversations[parent.id]).toBe(state.conversations[parent.id]);
    expect(next.conversations[parent.id].documents).toEqual([document]);
    expect(state.conversations[child.id].documents).toEqual([document]);
    expect(removeConversationDocument(next, child.id, document.id, "later")).toBe(next);
    expect(removeConversationDocument(next, "missing", document.id, "later")).toBe(next);
  });

  test("creating a branch updates relationships, layout, group, and standalone note context atomically", () => {
    let state = createEmptyState();
    const parent = createStandaloneNoteConversation({ id: "note", noteId: "body" });
    parent.notes![0].content = "Selected note context";
    state = addRootConversation(state, parent);
    state.groups = { research: { id: "research", name: "Research", color: "blue", collapsed: false, conversationIds: [parent.id] } };
    const child = createChildConversation({ id: "branch", parentConversation: parent });
    const next = addChildConversation(state, child, { activate: true, sourceNoteId: "body" });
    expect(next.conversations.note.childIds).toEqual([child.id]);
    expect(next.conversations.note.messages[0].content).toContain("Selected note context");
    expect(next.graphLayouts.branch).toBeDefined();
    expect(next.groups.research.conversationIds).toEqual(["note", "branch"]);
    expect(next.activeConversationId).toBe("branch");
    expect(next.rootId).toBe("note");
    expect(parent.childIds).toEqual([]);
    expect(addChildConversation(next, child)).toBe(next);
  });

  test("deletion removes descendants, pins, layouts, and memberships while preserving another tree", () => {
    let state = createEmptyState();
    const root = state.conversations[state.rootId];
    const child = createChildConversation({ id: "child", parentConversation: root });
    state = addChildConversation(state, child, { activate: true });
    const other = createMainConversation({ id: "other" });
    state = addRootConversation(state, other);
    state.activeConversationId = child.id; state.rootId = root.id;
    state.pinnedThreadIds = [root.id, other.id];
    state.groups = { group: { id: "group", name: "Group", color: "blue", collapsed: false, conversationIds: [root.id, child.id, other.id] } };
    const next = deleteThread(state, root.id, createMainConversation({ id: "replacement" }));
    expect(Object.keys(next.conversations)).toEqual(["other"]);
    expect(Object.keys(next.graphLayouts)).toEqual(["other"]);
    expect(next.pinnedThreadIds).toEqual(["other"]);
    expect(next.groups.group.conversationIds).toEqual(["other"]);
    expect(next.rootId).toBe("other"); expect(next.activeConversationId).toBe("other");
    expect(state.conversations.child).toBe(child);
  });

  test("deleting the last thread creates one replacement and late stream output cannot recreate it", () => {
    const state = createEmptyState();
    const replacement = createMainConversation({ id: "replacement" });
    const next = deleteThread(state, state.rootId, replacement);
    expect(Object.keys(next.conversations)).toEqual(["replacement"]);
    expect(next.rootId).toBe(replacement.id);
    expect(appendMessageDelta(next, state.rootId, "late", "text", replacement.createdAt)).toBe(next);
    expect(deleteThread(next, state.rootId, replacement)).toBe(next);
  });
});
