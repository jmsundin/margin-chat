import { describe, expect, test } from "bun:test";
import { createAppStateFromWorkspaceDocument, createWorkspaceDocument } from "@margin-chat/workspace-contracts";
import { createEmptyState, createMainConversation } from "../client/src/initialState";
import {
  addMapChildNote, applyTopicExpansion, createMapNote, getRemovableMapNote,
  removeMapNote, restoreMapNote, setPersonalMapConnection, type TopicExpansion,
} from "../client/src/lib/graphWorkspaceEdits";
import { savePublicTopic } from "../client/src/lib/publicTopicWorkspace";
import { hydratePersistedState } from "../client/src/lib/appState";
import { stateToVaultFiles, vaultToState } from "../client/src/lib/vaultWorkspace";
import { deleteThread } from "../client/src/lib/workspaceCommands";
import { normalizeAppState } from "../server/db/validation.mjs";
import type { AppState } from "../client/src/types";

const createdAt = "2026-09-20T12:00:00.000Z";
const later = "2026-09-20T12:30:00.000Z";
const options = { requestId: "request-1", createdAt };
const outline: TopicExpansion = { nodes: [
  { id: "detail", parentId: "concept", title: "Specific detail", content: "An explanation to review." },
  { id: "concept", parentId: null, title: "Core concept", content: "Start with this concept." },
  { id: "comparison", parentId: null, title: "Useful comparison", content: "Compare the approaches." },
] };

function fixture() {
  const saved = savePublicTopic(createEmptyState(), {
    id: "Q21198", aliases: [], label: "Computer science", description: "Study of computation",
    wikidataUrl: "https://www.wikidata.org/wiki/Q21198", retrievedAt: createdAt,
  });
  const parent = saved.state.conversations[saved.conversationId];
  parent.title = "My computing questions";
  parent.notes![0].content = "A private question that must stay intact.";
  parent.grouping = "manual";
  saved.state.groups = { learning: { id: "learning", name: "Learning", color: "#6f88ff", collapsed: false, conversationIds: [parent.id] } };
  return { state: saved.state, parentId: parent.id };
}

function itemByTitle(state: AppState, title: string) {
  const item = Object.values(state.conversations).find((item) => item.title === title);
  if (!item) throw new Error(`Missing test item: ${title}`);
  return item;
}

describe("real map child notes", () => {
  test("creates an editable child with branch placement, inherited group, and child selection", () => {
    const { state, parentId } = fixture();
    const before = structuredClone(state);
    const next = addMapChildNote(state, { parentId, id: "child", noteId: "child-body", createdAt, title: " My question ", content: "A **personal** note." });
    expect(next.conversations.child).toMatchObject({
      parentId, kind: "note", title: "My question", grouping: "manual", branchAnchor: null,
      notes: [{ id: "child-body", kind: "standalone", content: "A **personal** note." }],
    });
    expect(next.conversations.child.publicTopic).toBeUndefined();
    expect(next.conversations[parentId].childIds).toEqual(["child"]);
    expect(next.conversations[parentId].notes).toEqual(before.conversations[parentId].notes);
    expect(next.activeConversationId).toBe("child");
    expect(next.rootId).toBe(parentId);
    expect(next.graphLayouts.child.x).toBeGreaterThan(next.graphLayouts[parentId].x);
    expect(next.groups.learning.conversationIds).toEqual([parentId, "child"]);
    expect(state).toEqual(before);
    expect(addMapChildNote(next, { parentId, id: "child", noteId: "child-body", createdAt, content: "Must not overwrite" })).toBe(next);
  });

  test("supports empty child notes, optional inactive creation, and nested parentage", () => {
    const { state, parentId } = fixture();
    const child = addMapChildNote(state, { parentId, id: "child", noteId: "child-body", createdAt, activate: false });
    expect(child.activeConversationId).toBe(state.activeConversationId);
    expect(child.rootId).toBe(state.rootId);
    expect(child.conversations.child.notes![0].content).toBe("");
    const nested = addMapChildNote(child, { parentId: "child", id: "nested", noteId: "nested-body", createdAt });
    expect(nested.rootId).toBe(parentId);
    expect(nested.activeConversationId).toBe("nested");
    expect(nested.conversations.child.childIds).toEqual(["nested"]);
    expect(nested.groups.learning.conversationIds).toEqual([parentId, "child", "nested"]);
  });

  test("child notes and grandchildren survive JSON, hydration, Markdown and server validation", () => {
    const { state, parentId } = fixture();
    const first = addMapChildNote(state, { parentId, id: "child", noteId: "child-body", createdAt, title: "Edited child title", content: "# Child content\n\n## Note\n\nKeep nested headings." });
    const next = addMapChildNote(first, { parentId: "child", id: "nested", noteId: "nested-body", createdAt });
    const restored = [
      createAppStateFromWorkspaceDocument(JSON.parse(JSON.stringify(createWorkspaceDocument(next))))!,
      hydratePersistedState(next)!,
      vaultToState(stateToVaultFiles(next, {}), next),
    ];
    for (const candidate of restored) {
      expect(candidate.conversations[parentId].childIds).toEqual(["child"]);
      expect(candidate.conversations.child).toMatchObject({ parentId, childIds: ["nested"], title: "Edited child title", notes: next.conversations.child.notes });
      expect(candidate.conversations.nested.parentId).toBe("child");
      expect(candidate.rootId).toBe(parentId);
      expect(normalizeAppState(candidate).conversations.find((item: any) => item.id === "child").parentId).toBe(parentId);
    }
  });
});

describe("atomic generated topic outlines", () => {
  test("orders nested notes correctly without changing navigation, sources, or concurrent authored edits", () => {
    const { state, parentId } = fixture();
    state.conversations[parentId].updatedAt = later;
    const working = createMapNote(state, { id: "unrelated", noteId: "unrelated-body", createdAt: later });
    const before = structuredClone(working);
    const next = applyTopicExpansion(working, parentId, outline, options);
    const concept = itemByTitle(next, "Core concept");
    const detail = itemByTitle(next, "Specific detail");
    const comparison = itemByTitle(next, "Useful comparison");
    expect(concept.parentId).toBe(parentId);
    expect(detail.parentId).toBe(concept.id);
    expect(comparison.parentId).toBe(parentId);
    expect(next.conversations[parentId].childIds).toEqual([concept.id, comparison.id]);
    expect(concept.childIds).toEqual([detail.id]);
    expect(next.conversations[parentId]).toMatchObject({
      title: before.conversations[parentId].title, notes: before.conversations[parentId].notes,
      publicTopic: before.conversations[parentId].publicTopic, updatedAt: later,
    });
    expect(next.conversations.unrelated).toBe(working.conversations.unrelated);
    expect(next.activeConversationId).toBe(working.activeConversationId);
    expect(next.rootId).toBe(working.rootId);
    for (const generated of [concept, detail, comparison]) {
      expect(generated.kind).toBe("note");
      expect(generated.publicTopic).toBeUndefined();
      expect(generated.notes![0].content).toContain("AI-generated exploration of My computing questions. Review before relying on it.");
      expect(generated.notes![0].content).toContain("Topic reference: <https://www.wikidata.org/wiki/Q21198>");
      expect(generated.notes![0].content).not.toContain("A private question");
      expect(next.groups.learning.conversationIds).toContain(generated.id);
      expect(next.graphLayouts[generated.id]).toBeDefined();
    }
    expect(working).toEqual(before);
  });

  test("a replay after renaming and editing generated notes remains idempotent across Markdown reload", () => {
    const { state, parentId } = fixture();
    const expanded = applyTopicExpansion(state, parentId, outline, options);
    const concept = itemByTitle(expanded, "Core concept");
    expanded.conversations[concept.id] = { ...concept, title: "My revised concept", notes: concept.notes!.map((note) => ({ ...note, content: "My correction", updatedAt: later })) };
    const restored = vaultToState(stateToVaultFiles(expanded, {}), expanded);
    const before = structuredClone(restored);
    const replay = applyTopicExpansion(restored, parentId, outline, options);
    expect(replay).toBe(restored);
    expect(replay).toEqual(before);
    expect(replay.conversations[concept.id].title).toBe("My revised concept");
    expect(replay.conversations[concept.id].notes![0].content).toBe("My correction");
  });

  test("same-titled user notes stay distinct instead of being overwritten or repurposed", () => {
    const { state, parentId } = fixture();
    const withPersonal = addMapChildNote(state, { parentId, id: "mine", noteId: "mine-body", createdAt, title: "Core concept", content: "My authored definition" });
    const next = applyTopicExpansion(withPersonal, parentId, outline, options);
    expect(next.conversations.mine).toBe(withPersonal.conversations.mine);
    expect(Object.values(next.conversations).filter((item) => item.title === "Core concept")).toHaveLength(2);
  });

  test("a deleted parent while generation is pending cannot be resurrected", () => {
    const { state, parentId } = fixture();
    const removed = deleteThread(state, parentId, createMainConversation({ id: "replacement" }));
    expect(applyTopicExpansion(removed, parentId, outline, options)).toBe(removed);
    expect(addMapChildNote(removed, { parentId, id: "late-child", noteId: "late-body", createdAt })).toBe(removed);
  });

  const badOutlines: Array<[string, unknown]> = [
    ["empty", { nodes: [] }],
    ["too small", { nodes: [outline.nodes[1]] }],
    ["too large", { nodes: Array.from({ length: 7 }, (_, i) => ({ ...outline.nodes[1], id: `n${i}` })) }],
    ["orphan", { nodes: [outline.nodes[0], outline.nodes[2]] }],
    ["cycle", { nodes: [{ ...outline.nodes[0], parentId: "comparison" }, { ...outline.nodes[2], parentId: "detail" }] }],
    ["self cycle", { nodes: [{ ...outline.nodes[1], parentId: "concept" }, outline.nodes[2]] }],
    ["duplicate ID", { nodes: [outline.nodes[1], outline.nodes[1]] }],
    ["invalid title", { nodes: [outline.nodes[1], { ...outline.nodes[2], title: " " }] }],
    ["invalid content", { nodes: [outline.nodes[1], { ...outline.nodes[2], content: null }] }],
    ["missing parent field", { nodes: [outline.nodes[1], { ...outline.nodes[2], parentId: undefined }] }],
  ];
  for (const [name, invalid] of badOutlines) {
    test(`rejects ${name} without applying the valid portion`, () => {
      const { state, parentId } = fixture();
      const before = structuredClone(state);
      expect(() => applyTopicExpansion(state, parentId, invalid as TopicExpansion, options)).toThrow();
      expect(state).toEqual(before);
    });
  }

  test("rejects an identity collision before inserting any of the outline", () => {
    const { state, parentId } = fixture();
    const initial = applyTopicExpansion(state, parentId, outline, options);
    const comparison = itemByTitle(initial, "Useful comparison");
    const collision = { ...state, conversations: { ...state.conversations,
      [comparison.id]: { ...comparison, notes: comparison.notes!.map((note) => ({ ...note, id: "unrelated-body", content: "Authored elsewhere" })) },
    } };
    const before = structuredClone(collision);
    expect(() => applyTopicExpansion(collision, parentId, outline, options)).toThrow("conflicts");
    expect(collision).toEqual(before);
    expect(itemByTitle(initial, "Core concept").id in collision.conversations).toBe(false);
  });
});

describe("removing and restoring leaf child notes", () => {
  test("repairs hierarchy, selection, links, groups and layout while Undo preserves later edits", () => {
    const { state, parentId } = fixture();
    const first = addMapChildNote(state, { parentId, id: "first", noteId: "first-body", createdAt, title: "First" });
    const second = addMapChildNote(first, { parentId, id: "second", noteId: "second-body", createdAt, title: "Second" });
    const connected = setPersonalMapConnection(second, "first", "second", true, createdAt);
    const removed = getRemovableMapNote(connected, "second")!;
    expect(removed).not.toBeNull();
    const next = removeMapNote(connected, "second", createMainConversation({ id: "unused" }));
    expect(next.conversations[parentId].childIds).toEqual(["first"]);
    expect(next.conversations.second).toBeUndefined();
    expect(next.graphLayouts.second).toBeUndefined();
    expect(next.activeConversationId).toBe(parentId);
    expect(next.rootId).toBe(parentId);
    expect(next.groups.learning.conversationIds).not.toContain("second");
    expect(next.conversations.first.linkedConversationIds).toEqual([]);
    const newer = addMapChildNote(next, { parentId, id: "newer", noteId: "newer-body", createdAt: later });
    newer.conversations[parentId] = { ...newer.conversations[parentId], title: "Renamed while removed" };
    const restored = restoreMapNote(newer, removed);
    expect(restored.conversations[parentId].childIds).toEqual(["first", "second", "newer"]);
    expect(restored.conversations[parentId].title).toBe("Renamed while removed");
    expect(restored.conversations.second.parentId).toBe(parentId);
    expect(restored.conversations.second.notes).toEqual(removed.conversation.notes);
    expect(restored.graphLayouts.second).toEqual(removed.layout);
    expect(restored.conversations.first.linkedConversationIds).toEqual(["second"]);
    expect(restored.groups.learning.conversationIds).toContain("second");
    expect(restored.activeConversationId).toBe("newer");
    expect(restoreMapNote(restored, removed)).toBe(restored);
    expect(normalizeAppState(restored)).toBeDefined();
    expect(vaultToState(stateToVaultFiles(restored, {}), restored).conversations[parentId].childIds).toEqual(["first", "second", "newer"]);
  });

  test("never removes a subtree and does not restore a leaf under a deleted parent", () => {
    const { state, parentId } = fixture();
    const child = addMapChildNote(state, { parentId, id: "child", noteId: "child-body", createdAt });
    const grandchild = addMapChildNote(child, { parentId: "child", id: "leaf", noteId: "leaf-body", createdAt });
    expect(getRemovableMapNote(grandchild, "child")).toBeNull();
    const stale = { ...grandchild, conversations: { ...grandchild.conversations, child: { ...grandchild.conversations.child, childIds: [] } } };
    expect(getRemovableMapNote(stale, "child")).toBeNull();
    const removed = getRemovableMapNote(grandchild, "leaf")!;
    const withoutLeaf = removeMapNote(grandchild, "leaf", createMainConversation({ id: "unused" }));
    expect(withoutLeaf.activeConversationId).toBe("child");
    expect(withoutLeaf.rootId).toBe(parentId);
    const withoutParent = deleteThread(withoutLeaf, parentId, createMainConversation({ id: "unused" }));
    expect(restoreMapNote(withoutParent, removed)).toBe(withoutParent);
  });
});
