import { describe, expect, test } from "bun:test";
import { createEmptyState, createMainConversation } from "../client/src/initialState";
import { createMapNote, getRemovableMapNote, removeMapNote, restoreMapNote, setPersonalMapConnection } from "../client/src/lib/graphWorkspaceEdits";

const time = "2026-09-20T12:00:00.000Z";
const note = (id: string) => ({ id, noteId: `${id}-body`, createdAt: time });

describe("quick map edits", () => {
  test("connected notes remain independent editable roots with a personal relationship", () => {
    const original = createEmptyState();
    const next = createMapNote(original, { ...note("research"), linkedTo: original.rootId });
    expect(next.conversations.research.parentId).toBeNull();
    expect(next.activeConversationId).toBe("research");
    const owner = [original.rootId, "research"].sort()[0];
    expect(next.conversations[owner].linkedConversationIds).toHaveLength(1);
    expect(original.conversations.research).toBeUndefined();
    expect(setPersonalMapConnection(next, "research", original.rootId, true, time)).toBe(next);
    expect(setPersonalMapConnection(next, "research", "research", true, time)).toBe(next);
    expect(setPersonalMapConnection(next, "research", "missing", true, time)).toBe(next);
  });

  test("web source notes preserve meaningful URL query parameters and reject unsafe protocols", () => {
    const state = createMapNote(createEmptyState(), { ...note("source"), url: "https://example.org/paper?id=25&version=2" });
    expect(state.conversations.source.notes![0].content).toContain("https://example.org/paper?id=25&version=2");
    expect(state.conversations.source.publicTopic).toBeUndefined();
    expect(() => createMapNote(state, { ...note("unsafe"), url: "javascript:alert(1)" })).toThrow();
  });

  test("remove and undo restore notes, links, memberships, and position without reverting later edits", () => {
    let state = createMapNote(createEmptyState(), note("a"));
    state = createMapNote(state, { ...note("b"), linkedTo: "a" });
    state.groups = { research: { id: "research", name: "Research", color: "blue", collapsed: false, conversationIds: ["b"] } };
    state.pinnedThreadIds = ["b"];
    const removed = getRemovableMapNote(state, "b")!;
    const next = removeMapNote(state, "b", createMainConversation({ id: "fallback" }));
    expect(next.conversations.b).toBeUndefined();
    expect(next.conversations.a.linkedConversationIds).toEqual([]);
    const later = createMapNote(next, note("later"));
    later.conversations.a = { ...later.conversations.a, title: "Edited since removal" };
    const restored = restoreMapNote(later, removed);
    expect(restored.conversations.b.notes).toEqual(removed.conversation.notes);
    expect(restored.conversations.a.title).toBe("Edited since removal");
    expect(restored.conversations.a.linkedConversationIds).toEqual(["b"]);
    expect(restored.conversations.later).toBeDefined();
    expect(restored.graphLayouts.b).toEqual(removed.layout);
    expect(restored.groups.research.conversationIds).toEqual(["b"]);
    expect(restored.pinnedThreadIds).toEqual(["b"]);
    expect(restoreMapNote(restored, removed)).toBe(restored);
    expect(getRemovableMapNote(state, state.rootId)).not.toBeNull();
    expect(getRemovableMapNote(state, "conversation-root")).toBeNull();
  });
});
