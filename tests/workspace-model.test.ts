import { describe, expect, test } from "bun:test";
import {
  createChildConversation,
  createEmptyState,
  createStandaloneNoteConversation,
} from "../client/src/initialState";
import {
  createAppStateFromWorkspaceDocument,
  createWorkspaceDocument,
} from "../client/src/lib/workspaceModel";
import { areWorkspaceStatesEqual } from "../client/src/lib/workspaceStorage";
import {
  createAppStateFromWorkspaceDocument as createServerAppState,
  createWorkspaceDocument as createServerDocument,
} from "../server/db/workspaceDocument.mjs";

function makeWorkspaceState() {
  const state = createEmptyState();
  const root = state.conversations[state.rootId];
  const child = createChildConversation({ id: "child", parentConversation: root });
  root.childIds.push(child.id);
  root.notes?.push({
    content: "Root annotation",
    createdAt: root.createdAt,
    endOffset: null,
    id: "annotation-root",
    kind: "comment",
    quote: null,
    sourceMessageId: null,
    startOffset: null,
    updatedAt: root.updatedAt,
  });
  state.conversations[child.id] = child;

  const note = createStandaloneNoteConversation({
    id: "standalone-note",
    noteId: "standalone-note-body",
  });
  note.notes![0].content = "Standalone note content";
  note.notes!.push({
    content: "Annotation on note",
    createdAt: note.createdAt,
    endOffset: null,
    id: "annotation-note",
    kind: "comment",
    quote: null,
    sourceMessageId: null,
    startOffset: null,
    updatedAt: note.updatedAt,
  });
  state.conversations[note.id] = note;
  return state;
}

describe("versioned workspace document", () => {
  test("separates durable items, annotations, preferences, and view state", () => {
    const state = makeWorkspaceState();
    const document = createWorkspaceDocument(state);

    expect(document.schemaVersion).toBe(2);
    expect(document.items[state.rootId].kind).toBe("chat");
    expect(document.items["standalone-note"]).toMatchObject({
      content: "Standalone note content",
      kind: "note",
      noteId: "standalone-note-body",
    });
    expect(document.annotations["annotation-root"].parentId).toBe(state.rootId);
    expect(document.annotations["annotation-note"].parentId).toBe(
      "standalone-note",
    );
    expect(document.view.activeItemId).toBe(state.activeConversationId);
    expect(document.preferences.defaultServiceId).toBe(state.defaultServiceId);
    expect(document.items[state.rootId]).not.toHaveProperty("childIds");
    expect(document.items[state.rootId]).not.toHaveProperty("notes");

    const restored = createAppStateFromWorkspaceDocument(document);
    expect(restored).not.toBeNull();
    expect(areWorkspaceStatesEqual(state, restored!)).toBe(true);
  });

  test("uses the same document contract on client and server", () => {
    const state = makeWorkspaceState();
    const serverDocument = createServerDocument(state);
    const restoredByServer = createServerAppState(serverDocument);

    expect(restoredByServer).not.toBeNull();
    expect(areWorkspaceStatesEqual(state, restoredByServer)).toBe(true);
  });
});
