import { describe, expect, test } from "bun:test";
import { createMarginDocument, migrateMarginNotes, normalizeEditableDocument, createWorkspaceDocument, createAppStateFromWorkspaceDocument } from "@margin-chat/workspace-contracts";
import { createEmptyState, createMainConversation } from "../client/src/initialState";
import { hydratePersistedState } from "../client/src/lib/appState";
import { getEditableDocument } from "../client/src/lib/editableDocument";
import { stateToVaultFiles, vaultToState, workspaceFromVault } from "../client/src/lib/vaultWorkspace";
import { normalizeAppState } from "../server/db/validation.mjs";

function fixture() {
  const state = createEmptyState();
  const parent = state.conversations[state.rootId];
  parent.document = getEditableDocument(parent);
  parent.document.blocks[0].content = "A selected passage.";
  parent.notes = [{ id: "legacy-note", kind: "comment", content: "# Exact text\r\n\r\n- [ ] A task\r\n\n日本語  ",
    sourceMessageId: `document:${parent.document.blocks[0].id}`, sourceBlockId: parent.document.blocks[0].id,
    quote: "selected", startOffset: 2, endOffset: 10, createdAt: parent.createdAt, updatedAt: parent.updatedAt }];
  return state;
}

describe("margin notes as documents", () => {
  test("migrates exact authored content, timestamps, hierarchy and selection references once", () => {
    const state = fixture();
    const original = structuredClone(state);
    const migrated = hydratePersistedState(state)!;
    const child = migrated.conversations["legacy-note"];
    expect(state).toEqual(original);
    expect(child.parentId).toBe(state.rootId);
    expect(child.document!.blocks[0].content).toBe(state.conversations[state.rootId].notes![0].content);
    expect(child.updatedAt).toBe(state.conversations[state.rootId].notes![0].updatedAt);
    expect(child.document!.marginNote).toMatchObject({ display: "compact", legacyNoteId: "legacy-note" });
    expect(child.branchAnchor).toMatchObject({ sourceConversationId: state.rootId, quote: "selected", startOffset: 2, endOffset: 10 });
    expect(migrated.conversations[state.rootId].notes).toEqual([]);
    expect(migrated.conversations[state.rootId].childIds).toContain(child.id);
    expect(migrateMarginNotes(migrated.conversations)).toBe(migrated.conversations);
    expect(hydratePersistedState(migrated)).toEqual(migrated);
    expect(() => normalizeAppState(migrated)).not.toThrow();
  });

  test("retains general and historical notes and never overwrites an existing document", () => {
    const state = fixture();
    state.conversations["legacy-note"] = createMainConversation({ id: "legacy-note" });
    const note = state.conversations[state.rootId].notes![0];
    note.sourceMessageId = "removed-message";
    note.sourceBlockId = "removed-block";
    const migrated = hydratePersistedState(state)!;
    const child = migrated.conversations["legacy-note:margin:1"];
    expect(migrated.conversations["legacy-note"].parentId).toBeNull();
    expect(child.document!.marginNote!.source).toMatchObject({ sourceMessageId: "removed-message", sourceBlockId: "removed-block", quote: "selected" });
    expect(child.branchAnchor).toBeNull();
    expect(() => normalizeAppState(migrated)).not.toThrow();
    const general = createMarginDocument(migrated.conversations[state.rootId], { ...note, id: "general", content: "", sourceMessageId: null, sourceBlockId: undefined, quote: null, startOffset: null, endOffset: null });
    expect(general.branchAnchor).toBeNull();
    expect(general.document!.blocks[0].content).toBe("");
    expect(general.parentId).toBe(state.rootId);
  });

  test("preserves legacy note files as document files through vault migration and repeated saves", () => {
    const state = fixture();
    const legacyFiles = stateToVaultFiles(state, {});
    const legacyPath = workspaceFromVault(legacyFiles).manifest.files.find((file) => file.id === "legacy-note")!.path;
    const migrated = vaultToState(legacyFiles, state);
    const files = stateToVaultFiles(migrated, legacyFiles);
    const records = workspaceFromVault(files).manifest.files;
    expect(records.filter((file) => file.id === "legacy-note")).toHaveLength(1);
    expect(records.find((file) => file.id === "legacy-note")!.type).toBe("conversation");
    if (records.find((file) => file.id === "legacy-note")!.path !== legacyPath) expect(files[legacyPath]).toBeUndefined();
    const restored = vaultToState(files, migrated);
    expect(restored.conversations["legacy-note"]).toEqual(migrated.conversations["legacy-note"]);
    const resaved = stateToVaultFiles(restored, files);
    for (const [path, file] of Object.entries(files)) {
      if (path === "workspace.json") expect(JSON.parse(resaved[path].content)).toEqual(JSON.parse(file.content));
      else expect(resaved[path]).toEqual(file);
    }
    restored.conversations["legacy-note"].document!.marginNote!.display = "full";
    restored.conversations["legacy-note"].document!.marginNote!.size = { width: 410, height: 560 };
    const reopened = vaultToState(stateToVaultFiles(restored, files), restored);
    expect(reopened.conversations["legacy-note"].document!.marginNote!.display).toBe("full");
    expect(reopened.conversations["legacy-note"].document!.marginNote!.size).toEqual({ width: 410, height: 560 });
    expect(createAppStateFromWorkspaceDocument(createWorkspaceDocument(restored))!.conversations["legacy-note"].document).toEqual(restored.conversations["legacy-note"].document);
  });

  test("validates presentation metadata without silently stripping it", () => {
    const document = hydratePersistedState(fixture())!.conversations["legacy-note"].document!;
    expect(normalizeEditableDocument(document)).toEqual(document);
    expect(normalizeEditableDocument({ ...document, marginNote: { display: "unknown" } })).toBeUndefined();
    expect(normalizeEditableDocument({ ...document, marginNote: { display: "compact", source: { quote: 12 } } })).toBeUndefined();
    expect(normalizeEditableDocument({ ...document, marginNote: { display: "compact", size: { width: 400, height: 500 } } })!.marginNote!.size).toEqual({ width: 400, height: 500 });
    for (const width of [0, -10, Infinity, "400", 400.5]) {
      expect(normalizeEditableDocument({ ...document, marginNote: { display: "compact", size: { width, height: 500 } } })).toBeUndefined();
    }
  });
});
