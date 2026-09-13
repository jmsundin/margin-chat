import { describe, expect, test } from "bun:test";
import { createChildConversation, createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";
import {
  normalizeVaultMarkdownIdentities, stateToVaultFiles, vaultToState, workspaceFromVault, workspaceVaultFiles,
} from "../client/src/lib/vaultWorkspace";
import { discoverMarkdownWorkspace, parseMarkdownWorkspace } from "../client/src/lib/workspaceMarkdown";
import { bytesToBase64, exportVault, importVault, vaultFileBytes } from "../client/src/lib/vaultLocal";
import { emptyVault, type VaultFile } from "../client/src/lib/vaultTypes";
import type { AppState } from "../client/src/types";

function authoredWorkspace() {
  const state = createEmptyState();
  const root = state.conversations[state.rootId];
  root.title = "Research";
  root.messages.push({ id: "user-message", role: "user", createdAt: root.createdAt, content: "Compare Markdown storage.\n\n[[Design]]" });
  root.notes!.push({ id: "margin-note", kind: "comment", content: "Keep this annotation.", sourceMessageId: "user-message", startOffset: 0, endOffset: 7, quote: "Compare", createdAt: root.createdAt, updatedAt: root.updatedAt });
  root.documents!.push({ id: "source-document", filename: "source.bin", mimeType: "application/octet-stream", sizeBytes: 6, createdAt: root.createdAt, status: "ready", error: null });
  const child = createChildConversation({ id: "child", parentConversation: root, createdAt: root.createdAt });
  child.title = "Follow-up";
  root.childIds.push(child.id);
  state.conversations[child.id] = child;
  const note = createStandaloneNoteConversation({ id: "design", noteId: "design-body", createdAt: root.createdAt });
  note.title = "Design";
  note.notes![0].content = "# Plan\n\nPortable **Markdown**.\n\n## Note\n\nKeep nested headings.\n\n[[Research]]";
  state.conversations[note.id] = note;
  state.groups = { group: { id: "group", name: "Storage", color: "blue", collapsed: false, conversationIds: [root.id, note.id] } };
  state.pinnedThreadIds = [note.id];
  return state;
}

function authoredContents(state: AppState) {
  return Object.fromEntries(Object.entries(state.conversations).map(([id, item]) => [id, {
    title: item.title, parentId: item.parentId, messages: item.messages, notes: item.notes, documents: item.documents,
  }]));
}

describe("vault workspace source of truth", () => {
  test("the first content added to an empty saved note survives reopening and later edits", () => {
    const state = createEmptyState();
    const note = createStandaloneNoteConversation({ id: "first-note", noteId: "first-body", createdAt: "2026-09-13T00:00:00.000Z" });
    state.conversations[note.id] = note;
    let files = stateToVaultFiles(state, {});
    for (const content of ["# First content\n\nCafé, 日本語.", "", "Second edit after clearing."]) {
      note.notes![0].content = content;
      files = stateToVaultFiles(state, files);
      expect(vaultToState(files, state).conversations[note.id].notes![0].content).toBe(content);
    }
  });

  test("reconstructs chats, notes, relationships and settings without a file registry", () => {
    const state = authoredWorkspace();
    const files = stateToVaultFiles(state, {});
    expect(JSON.parse(files["workspace.json"].content).files).toEqual([]);
    const recovered = vaultToState(files, createEmptyState());
    expect(authoredContents(recovered)).toEqual(authoredContents(state));
    expect(recovered.groups.group.name).toBe("Storage");
    expect(recovered.pinnedThreadIds).toEqual(["design"]);
    const withoutSidecar = { ...files };
    delete withoutSidecar["workspace.json"];
    expect(authoredContents(vaultToState(withoutSidecar, createEmptyState()))).toEqual(authoredContents(state));
  });

  test("opening another note and changing panel visibility never rewrites cloud content", () => {
    const state = authoredWorkspace();
    const first = stateToVaultFiles(state, {});
    state.activeConversationId = "design";
    state.rootId = "design";
    state.railOpen = true;
    const second = stateToVaultFiles(state, first);
    expect(second).toEqual(first);
    const recovered = vaultToState(first, state);
    expect(recovered.activeConversationId).toBe("design");
    expect(recovered.rootId).toBe("design");
    expect(recovered.railOpen).toBe(true);
  });

  test("unchanged remote plain Markdown remains the exact revision offered for conflict resolution", () => {
    const raw = "# A remote note\r\n\r\nKeep these exact bytes.\r\n";
    const files: Record<string, VaultFile> = { "Remote.md": { content: raw } };
    const state = vaultToState(files, createEmptyState());
    const saved = stateToVaultFiles(state, files);
    expect(saved["Remote.md"].content).toBe(raw);
    expect(saved["Remote.md"].content).not.toContain("margin-chat-id");
    state.railOpen = !state.railOpen;
    expect(stateToVaultFiles(state, files)["Remote.md"].content).toBe(raw);
  });

  test("editing another document does not stamp an unchanged remote plain note", () => {
    const authored = authoredWorkspace();
    const files = stateToVaultFiles(authored, {});
    const raw = "---\nowner: Another device\n---\nRemote plain Markdown.\n";
    files["Untouched.md"] = { content: raw };
    const state = vaultToState(files, authored);
    state.conversations[authored.rootId].messages[0].content += "\nAn actual edit elsewhere.";
    const saved = stateToVaultFiles(state, files);
    expect(saved["Untouched.md"].content).toBe(raw);
    const record = workspaceFromVault(saved).manifest.files.find((file) => file.path === "Untouched.md")!;
    state.conversations[record.id].notes![0].content += "\nNow this note was edited.";
    expect(stateToVaultFiles(state, saved)["Untouched.md"].content).toContain("margin-chat-id:");
  });

  test("edits Markdown before derived state and preserves custom YAML and links", () => {
    const state = authoredWorkspace();
    const files = stateToVaultFiles(state, {});
    const workspace = workspaceFromVault(files);
    const path = workspace.manifest.files.find((record) => record.id === state.rootId)!.path;
    files[path].content = files[path].content.replace("---\n", "---\nowner: Jon\n") + "\n\n## Related\n[[External wiki note]]\n";
    const current = vaultToState(files, state);
    current.conversations[current.rootId].messages[0].content += "\nA local edit.";
    const saved = stateToVaultFiles(current, files);
    expect(saved[path].content).toContain("owner: Jon");
    expect(saved[path].content).toContain("## Related\n[[External wiki note]]\n");
    expect(vaultToState(saved, state).conversations[state.rootId].messages[0].content).toContain("A local edit.");
  });

  test("retains custom companion metadata when app settings change", () => {
    const state = authoredWorkspace();
    const files = stateToVaultFiles(state, {});
    const metadata = JSON.parse(files["workspace.json"].content);
    metadata.customVaultProperty = { color: "purple" };
    metadata.workspace.preferences.customPreference = "authored";
    metadata.workspace.view.customViewProperty = "retained";
    files["workspace.json"].content = JSON.stringify(metadata);
    state.pinnedThreadIds = [];
    const saved = JSON.parse(stateToVaultFiles(state, files)["workspace.json"].content);
    expect(saved.customVaultProperty).toEqual({ color: "purple" });
    expect(saved.workspace.preferences.customPreference).toBe("authored");
    expect(saved.workspace.view.customViewProperty).toBe("retained");
    expect(saved.workspace.view.pinnedItemIds).toEqual([]);
  });

  test("preserves attachments and conflict copies without importing them as notes", () => {
    const state = authoredWorkspace();
    const files = stateToVaultFiles(state, {});
    const raw = Object.entries(files).find(([path]) => path.endsWith(".md"))![1];
    files["_conflicts/device/copy.md"] = { ...raw };
    files["Attachments/source.md"] = { content: "# An attached reference" };
    files["attachments/picture.png"] = { content: "AAECAw==", encoding: "base64", contentType: "image/png" };
    const workspace = workspaceFromVault(files);
    expect(workspace.manifest.files).toHaveLength(4);
    const saved = stateToVaultFiles(vaultToState(files, state), files);
    for (const path of ["_conflicts/device/copy.md", "Attachments/source.md", "attachments/picture.png"]) {
      expect(saved[path].content).toBe(files[path].content);
      expect(saved[path].encoding).toBe(files[path].encoding);
    }
  });

  test("does not resurrect a deleted empty Markdown file", () => {
    const previous: Record<string, VaultFile> = { "Empty.md": { content: "" } };
    const emptyState = { ...createEmptyState(), conversations: {}, rootId: "", activeConversationId: "" };
    expect(stateToVaultFiles(emptyState, previous)["Empty.md"]).toBeUndefined();
  });

  test("stamps plain-file identities at import so a fresh device recognizes a rename", () => {
    const input: Record<string, VaultFile> = { "Old.md": { content: "---\nowner: Jon\n---\n# Research\n\nUnmodified content." } };
    const normalized = normalizeVaultMarkdownIdentities(input);
    const before = workspaceFromVault(normalized);
    expect(normalized["Old.md"].content).toContain("margin-chat-id:");
    expect(normalized["Old.md"].content).toContain("owner: Jon\n---\n# Research\n\nUnmodified content.");
    expect(normalizeVaultMarkdownIdentities(normalized)).toEqual(normalized);
    const renamed = { "Archive/New.md": { ...normalized["Old.md"], content: normalized["Old.md"].content + "\nEdited after renaming." } };
    const after = workspaceFromVault(renamed);
    expect(after.manifest.files[0].id).toBe(before.manifest.files[0].id);
    expect(parseMarkdownWorkspace(after.manifest, after.files)?.conversations[before.manifest.files[0].id].notes![0].content).toContain("Edited after renaming.");
  });

  test("folder-to-vault serialization also stamps IDs without changing its observed disk snapshot", () => {
    const disk = discoverMarkdownWorkspace({ "Raw.md": "A note." });
    const imported = workspaceVaultFiles(disk);
    expect(imported["Raw.md"].content).toContain("margin-chat-id:");
    expect(disk.files["Raw.md"]).toBe("A note.");
  });

  test("rejects invalid settings before they can replace portable content", () => {
    expect(() => workspaceFromVault({ "workspace.json": { content: "{}" }, "Note.md": { content: "Keep me" } })).toThrow("settings file is invalid");
  });

  test("preserves an annotation file if its parent is temporarily absent", () => {
    const state = authoredWorkspace();
    const files = stateToVaultFiles(state, {});
    const registry = workspaceFromVault(files).manifest.files;
    const parentPath = registry.find((file) => file.id === state.rootId)!.path;
    const annotationPath = registry.find((file) => file.id === "margin-note")!.path;
    delete files[parentPath];
    const recovered = vaultToState(files, createEmptyState());
    const saved = stateToVaultFiles(recovered, files);
    expect(saved[annotationPath].content).toBe(files[annotationPath].content);
  });
});

describe("portable vault export", () => {
  test("ZIP export/import restores authored content, binary attachments and preserved conflicts", () => {
    const state = authoredWorkspace();
    const snapshot = emptyVault();
    snapshot.files = stateToVaultFiles(state, {});
    const attachment = new Uint8Array([0, 255, 128, 64, 10, 13]);
    snapshot.files["Attachments/source.bin"] = { content: bytesToBase64(attachment), encoding: "base64", contentType: "application/octet-stream" };
    snapshot.files["_conflicts/offline/Note.md"] = { content: "Preserved offline writing." };
    snapshot.files["_conflicts/offline/conflict.json"] = { content: '{"path":"Note.md","remoteDeleted":true}', contentType: "application/json" };
    const imported = importVault(exportVault(snapshot));
    expect(imported).toEqual(snapshot.files);
    expect(vaultFileBytes(imported["Attachments/source.bin"])).toEqual(attachment);
    expect(authoredContents(vaultToState(imported, createEmptyState()))).toEqual(authoredContents(state));
  });
});
