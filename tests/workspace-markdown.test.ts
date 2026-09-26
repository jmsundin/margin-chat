import { describe, expect, test } from "bun:test";
import {
  createChildConversation,
  createEmptyState,
  createStandaloneNoteConversation,
} from "../client/src/initialState";
import {
  createMarkdownWorkspace,
  decodeReadableMarkdown,
  discoverMarkdownWorkspace,
  isReadableMarkdown,
  isSafeMarkdownPath,
  getAttachmentVaultPath,
  parseMarkdownWorkspace,
  parseMarkdownWorkspaceManifest,
} from "../client/src/lib/workspaceMarkdown";
import { areWorkspaceStatesEqual } from "../client/src/lib/workspaceStorage";

describe("Markdown local workspace", () => {
  test("stores every chat and note separately with forward and backward links", () => {
    const state = createEmptyState();
    const root = state.conversations[state.rootId];
    root.title = "Architecture";
    root.messages.push({
      content: "Keep **content** readable.\n\n## Including headings",
      createdAt: root.createdAt,
      id: "message-root",
      role: "user",
    });
    root.notes?.push({
      content: "Compare the storage options.",
      createdAt: root.createdAt,
      endOffset: null,
      id: "note-margin",
      kind: "comment",
      quote: null,
      sourceMessageId: null,
      startOffset: null,
      updatedAt: root.updatedAt,
    });

    const child = createChildConversation({
      createdAt: "2026-08-20T10:00:00.000Z",
      id: "conversation-child",
      parentConversation: root,
    });
    child.title = "Storage child";
    root.childIds.push(child.id);
    state.conversations[child.id] = child;

    const standalone = createStandaloneNoteConversation({
      createdAt: "2026-08-20T11:00:00.000Z",
      id: "conversation-note",
      noteId: "note-standalone",
    });
    standalone.title = "Design note";
    standalone.notes![0].content = "# Editable note\n\nLinked from Obsidian.";
    state.conversations[standalone.id] = standalone;

    const workspace = createMarkdownWorkspace(
      state,
      "2026-08-20T12:00:00.000Z",
    );
    const records = workspace.manifest.files;

    expect(records.filter((record) => record.type === "conversation")).toHaveLength(3);
    expect(records.filter((record) => record.type === "note")).toHaveLength(1);

    const rootPath = records.find((record) => record.id === root.id)!.path;
    const childPath = records.find((record) => record.id === child.id)!.path;
    const marginNotePath = records.find(
      (record) => record.id === "note-margin",
    )!.path;
    const rootMarkdown = workspace.files[rootPath];
    const childMarkdown = workspace.files[childPath];
    const noteMarkdown = workspace.files[marginNotePath];

    expect(rootMarkdown).toContain(
      `- Child: [[${childPath.replace(/\.md$/, "")}|Storage child]]`,
    );
    expect(childMarkdown).toContain(
      `- Parent: [[${rootPath.replace(/\.md$/, "")}|Architecture]]`,
    );
    expect(rootMarkdown).toContain(
      `- Note: [[${marginNotePath.replace(/\.md$/, "")}|Note — Compare the storage options.]]`,
    );
    expect(noteMarkdown).toContain(
      `- Parent: [[${rootPath.replace(/\.md$/, "")}|Architecture]]`,
    );

    const parsedManifest = parseMarkdownWorkspaceManifest(
      JSON.parse(JSON.stringify(workspace.manifest)),
    );
    const parsed = parsedManifest
      ? parseMarkdownWorkspace(parsedManifest, workspace.files)
      : null;

    expect(parsed).not.toBeNull();
    expect(areWorkspaceStatesEqual(state, parsed!)).toBe(true);
  });

  test("imports note and message edits made directly in Markdown", () => {
    const state = createEmptyState();
    const root = state.conversations[state.rootId];
    root.messages.push({
      content: "Original chat text",
      createdAt: root.createdAt,
      id: "message-editable",
      role: "assistant",
    });
    root.notes?.push({
      content: "Original note text",
      createdAt: root.createdAt,
      endOffset: null,
      id: "note-editable",
      kind: "comment",
      quote: null,
      sourceMessageId: null,
      startOffset: null,
      updatedAt: root.updatedAt,
    });

    const workspace = createMarkdownWorkspace(state);
    const rootPath = workspace.manifest.files.find(
      (record) => record.id === root.id,
    )!.path;
    const notePath = workspace.manifest.files.find(
      (record) => record.id === "note-editable",
    )!.path;
    workspace.files[rootPath] = workspace.files[rootPath].replace(
      "Original chat text",
      "Chat text edited in Obsidian and made longer",
    );
    workspace.files[rootPath] = workspace.files[rootPath].replace(
      'title: "New chat"',
      'title: "Renamed in Obsidian"',
    );
    workspace.files[notePath] = workspace.files[notePath].replace(
      "\n## Note\n\nOriginal note text",
      "\n## Note\n\nNote text edited in Obsidian",
    );

    const parsed = parseMarkdownWorkspace(workspace.manifest, workspace.files);

    expect(parsed?.conversations[root.id].messages[0].content).toBe(
      "Chat text edited in Obsidian and made longer",
    );
    expect(parsed?.conversations[root.id].title).toBe("Renamed in Obsidian");
    expect(parsed?.conversations[root.id].notes?.[0].content).toBe(
      "Note text edited in Obsidian",
    );
  });
});

describe("readable portable Markdown", () => {
  test("uses title-first filenames with stable suffixes for same-title offline documents", () => {
    const first = createEmptyState();
    first.conversations[first.rootId].title = "Architecture";
    const firstWorkspace = createMarkdownWorkspace(first);
    const firstPath = firstWorkspace.manifest.files[0].path;
    expect(firstPath).toMatch(/^Chats\/Architecture.+\.md$/);
    expect(firstPath).not.toBe("Chats/Architecture.md");
    expect(createMarkdownWorkspace(first).manifest.files[0].path).toBe(firstPath);

    const second = createEmptyState();
    const other = { ...second.conversations[second.rootId], id: "independent-offline-document", title: "Architecture" };
    second.rootId = other.id;
    second.activeConversationId = other.id;
    second.conversations = { [other.id]: other };
    const secondPath = createMarkdownWorkspace(second).manifest.files[0].path;
    expect(secondPath).toMatch(/^Chats\/Architecture.+\.md$/);
    expect(secondPath.toLocaleLowerCase()).not.toBe(firstPath.toLocaleLowerCase());
  });

  test("moves structured metadata to the header while keeping readable body text and compact identities", () => {
    const state = createEmptyState();
    const conversation = state.conversations[state.rootId];
    conversation.title = "Portable plan";
    conversation.messages = [{ id: "message-one", role: "user", createdAt: conversation.createdAt, content: "Readable question." }];
    conversation.document = { schemaVersion: 1, blocks: [{ id: "block-one", kind: "markdown", content: "Readable **answer**.\n\n[[Related|Reference]]", createdAt: conversation.createdAt, updatedAt: conversation.updatedAt }], prompts: [], generations: [] };
    const workspace = createMarkdownWorkspace(state);
    const source = Object.values(workspace.files)[0];
    const header = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(source)!;
    const body = source.slice(header[0].length);
    expect(workspace.manifest.formatVersion).toBe(4);
    expect(isReadableMarkdown(source)).toBe(true);
    expect(header[1]).toContain("margin-chat: |-");
    expect(header[1]).toContain('"schemaVersion": 2');
    expect(body).toContain('<!-- margin-chat-block "block-one" -->');
    expect(body).toContain('<!-- margin-chat-msg "message-one" -->');
    expect(body).toContain("Readable **answer**.\n\n[[Related|Reference]]");
    expect(body).toContain("Readable question.");
    expect(body).not.toContain("<!-- margin-chat-metadata");
    expect(body).not.toContain('"contentLength"');
    expect(parseMarkdownWorkspace(workspace.manifest, workspace.files)?.conversations[state.rootId].document).toEqual(conversation.document);
  });

  test("renames app-managed files and incoming links without changing document identity", () => {
    const state = createEmptyState();
    const root = state.conversations[state.rootId];
    root.title = "Architecture";
    const child = createChildConversation({ id: "linked-child", parentConversation: root });
    child.title = "Storage";
    root.childIds.push(child.id);
    state.conversations[child.id] = child;
    const original = createMarkdownWorkspace(state);
    const oldPath = original.manifest.files.find((record) => record.id === root.id)!.path;
    const childPath = original.manifest.files.find((record) => record.id === child.id)!.path;
    root.title = "System design";
    const updated = createMarkdownWorkspace(state, undefined, original);
    const record = updated.manifest.files.find((record) => record.id === root.id)!;
    expect(record.path).toMatch(/^Chats\/System design.+\.md$/);
    expect(record.path.slice("Chats/System design".length)).toBe(oldPath.slice("Chats/Architecture".length));
    expect(record.aliases).toContain(oldPath);
    expect(updated.files[oldPath]).toBeUndefined();
    expect(updated.files[childPath]).toContain(`[[${record.path.replace(/\.md$/, "")}|System design]]`);
    const reread = parseMarkdownWorkspace(updated.manifest, updated.files)!;
    expect(reread.conversations[child.id].parentId).toBe(root.id);
    expect(reread.conversations[root.id].childIds).toContain(child.id);
  });

  test("retains externally chosen filenames when their titles change", () => {
    const initial = createMarkdownWorkspace(createEmptyState());
    const externalPath = "Research/My chosen filename.md";
    const external = discoverMarkdownWorkspace({ [externalPath]: Object.values(initial.files)[0] }, initial.manifest, initial.files);
    const state = parseMarkdownWorkspace(external.manifest, external.files)!;
    const id = external.manifest.files[0].id;
    state.conversations[id].title = "A different title";
    const updated = createMarkdownWorkspace(state, undefined, external);
    expect(updated.manifest.files.find((record) => record.id === id)?.path).toBe(externalPath);
    expect(Object.keys(updated.files)).toEqual([externalPath]);
    expect(parseMarkdownWorkspace(updated.manifest, updated.files)?.conversations[id].title).toBe("A different title");
  });

  test("preserves custom YAML, CRLF prose and a footer when an app-managed title renames its file", () => {
    const state = createEmptyState();
    const root = state.conversations[state.rootId];
    root.title = "Original title";
    root.messages = [{ id: "body", role: "user", createdAt: root.createdAt, content: "Café 🦉 [[Unknown|Alias]]\nKeep this line." }];
    const original = createMarkdownWorkspace(state);
    const oldPath = original.manifest.files[0].path;
    const custom = "custom: |\r\n  First $& and $1\r\n\r\n  Last\r\n";
    const footer = "\r\n\r\n## Personal section\r\n<custom attr='value'>[[Unknown note]]</custom>\r\n";
    original.files[oldPath] = original.files[oldPath].replaceAll("\n", "\r\n").replace("---\r\n", () => `---\r\n${custom}`) + footer;
    const parsed = parseMarkdownWorkspace(original.manifest, original.files)!;
    parsed.conversations[root.id].title = "Renamed title";
    const updated = createMarkdownWorkspace(parsed, undefined, original);
    const nextPath = updated.manifest.files.find((record) => record.id === root.id)!.path;
    expect(nextPath).not.toBe(oldPath);
    expect(updated.files[nextPath]).toContain(custom);
    expect(updated.files[nextPath]).toContain("Café 🦉 [[Unknown|Alias]]\r\nKeep this line.");
    expect(updated.files[nextPath]).toEndWith(footer);
    expect(parseMarkdownWorkspace(updated.manifest, updated.files)?.conversations[root.id].messages[0].content).toBe(root.messages[0].content);
  });

  test("reads legacy manifests and body markers without rewriting them, then migrates an authored edit", () => {
    const state = createEmptyState();
    state.conversations[state.rootId].messages = [{ id: "legacy-message", role: "assistant", createdAt: state.conversations[state.rootId].createdAt, content: "Original legacy message." }];
    const current = createMarkdownWorkspace(state);
    const path = current.manifest.files[0].path;
    const legacy = { ...current, manifest: { ...current.manifest, formatVersion: 3 }, files: { [path]: decodeReadableMarkdown(current.files[path]) } };
    expect(isReadableMarkdown(legacy.files[path])).toBe(false);
    expect(legacy.files[path]).toContain("<!-- margin-chat-metadata");
    expect(parseMarkdownWorkspaceManifest(legacy.manifest)).not.toBeNull();
    const parsed = parseMarkdownWorkspace(legacy.manifest, legacy.files)!;
    expect(parsed.conversations[state.rootId].messages).toEqual(state.conversations[state.rootId].messages);
    expect(createMarkdownWorkspace(parsed, legacy.manifest.savedAt, legacy).files).toEqual(legacy.files);
    parsed.conversations[state.rootId].messages[0].content = "Edited legacy message.";
    const migrated = createMarkdownWorkspace(parsed, undefined, legacy);
    const nextPath = migrated.manifest.files.find((record) => record.id === state.rootId)!.path;
    expect(isReadableMarkdown(migrated.files[nextPath])).toBe(true);
    expect(parseMarkdownWorkspace(migrated.manifest, migrated.files)?.conversations[state.rootId].messages[0].content).toBe("Edited legacy message.");
  });
});

describe("authoritative Markdown files", () => {
  test("retains exact raw bytes and custom frontmatter across view changes", () => {
    const original = createMarkdownWorkspace(createEmptyState());
    const path = original.manifest.files[0].path;
    original.files[path] = original.files[path].replace("---\n", "---\ncustom-owner: Jon\n") + "\n\n## Personal section\nKeep this exactly.\n[[Research/Storage]]\n";
    const state = parseMarkdownWorkspace(original.manifest, original.files)!;
    state.railOpen = !state.railOpen;
    expect(createMarkdownWorkspace(state, undefined, original).files[path]).toBe(original.files[path]);
  });

  test("retains custom frontmatter and chat sections when editing messages", () => {
    const state = createEmptyState();
    state.conversations[state.rootId].messages.push({ id: "first", role: "user", createdAt: "2026-09-01T00:00:00.000Z", content: "First text" });
    const original = createMarkdownWorkspace(state);
    const path = original.manifest.files[0].path;
    original.files[path] = original.files[path].replace("---\n", "---\ncustom-owner: Jon\n") + "\n\n## Personal section\nKeep this exactly.\n";
    const changed = parseMarkdownWorkspace(original.manifest, original.files)!;
    changed.conversations[state.rootId].messages[0].content = "Edited text";
    const saved = createMarkdownWorkspace(changed, undefined, original);
    expect(saved.files[path]).toContain("custom-owner: Jon");
    expect(saved.files[path]).toContain("## Personal section\nKeep this exactly.\n");
    expect(parseMarkdownWorkspace(saved.manifest, saved.files)?.conversations[state.rootId].messages[0].content).toBe("Edited text");
  });

  test("keeps nested Note headings, including a Note heading in context messages", () => {
    const state = createEmptyState();
    const note = createStandaloneNoteConversation({ id: "heading-note", noteId: "heading-body" });
    note.messages.push({ id: "context", role: "user", createdAt: note.createdAt, content: "## Note\n\nContext must stay separate." });
    note.notes![0].content = "Start.\n\n## Note\n\nThis is still the same note.";
    state.conversations[note.id] = note;
    const original = createMarkdownWorkspace(state);
    const parsed = parseMarkdownWorkspace(original.manifest, original.files)!;
    expect(parsed.conversations[note.id].notes![0].content).toBe(note.notes![0].content);
    parsed.conversations[note.id].notes![0].content += "\nMore.";
    const saved = createMarkdownWorkspace(parsed, undefined, original);
    expect(parseMarkdownWorkspace(saved.manifest, saved.files)?.conversations[note.id].notes![0].content).toBe(note.notes![0].content + "\nMore.");
  });

  test("imports plain Markdown deterministically, preserves it, and assigns identity on an app edit", () => {
    const files = { "Research/Storage.md": "---\ncustom-owner: Jon\n---\n# Storage\n\nRaw text.\n\n## Extra\nMore text." };
    const original = discoverMarkdownWorkspace(files);
    const secondDevice = discoverMarkdownWorkspace(files);
    expect(original.manifest.files).toEqual(secondDevice.manifest.files);
    const state = parseMarkdownWorkspace(original.manifest, original.files)!;
    const id = original.manifest.files[0].id;
    expect(state.conversations[id].title).toBe("Storage");
    expect(createMarkdownWorkspace(state, undefined, original).files).toEqual(files);
    state.conversations[id].notes![0].content += "\nAn edit.";
    const updated = createMarkdownWorkspace(state, undefined, original);
    expect(updated.files["Research/Storage.md"]).toContain("custom-owner: Jon");
    expect(updated.files["Research/Storage.md"]).toContain(`margin-chat-id: "${id}"`);
    expect(parseMarkdownWorkspace(updated.manifest, updated.files)?.conversations[id].notes![0].content).toContain("## Extra\nMore text.\nAn edit.");
  });

  test("discovers external additions, deletions and renames without requiring a registry update", () => {
    const original = createMarkdownWorkspace(createEmptyState());
    const record = original.manifest.files[0];
    const renamed = discoverMarkdownWorkspace({ "Archive/Renamed.md": original.files[record.path], "New.md": "# A new note\n\nNew content" }, original.manifest, original.files);
    expect(renamed.manifest.files.find((file) => file.id === record.id)?.path).toBe("Archive/Renamed.md");
    expect(renamed.manifest.files).toHaveLength(2);
    const changed = discoverMarkdownWorkspace({ "New.md": renamed.files["New.md"] }, renamed.manifest, renamed.files);
    expect(changed.manifest.files).toHaveLength(1);
    expect(parseMarkdownWorkspace(changed.manifest, changed.files)?.conversations[record.id]).toBeUndefined();
    const registryFree = discoverMarkdownWorkspace(renamed.files, { ...original.manifest, files: [] });
    expect(registryFree.manifest.files.find((file) => file.id === record.id)?.path).toBe("Archive/Renamed.md");
  });

  test("keeps plain-note identity for a uniquely matched rename", () => {
    const first = discoverMarkdownWorkspace({ "First.md": "A plain note." });
    const renamed = discoverMarkdownWorkspace({ "Second.md": "A plain note." }, first.manifest, first.files);
    expect(renamed.manifest.files[0].id).toBe(first.manifest.files[0].id);
  });

  test("refuses duplicate identities and unsafe vault paths", () => {
    const original = createMarkdownWorkspace(createEmptyState());
    const raw = Object.values(original.files)[0];
    expect(() => discoverMarkdownWorkspace({ "One.md": raw, "Two.md": raw })).toThrow("Duplicate");
    expect(isSafeMarkdownPath("../escape.md")).toBe(false);
    expect(isSafeMarkdownPath("/absolute.md")).toBe(false);
    expect(isSafeMarkdownPath(".hidden/note.md")).toBe(false);
    expect(isSafeMarkdownPath("Notes\\escape.md")).toBe(false);
  });

  test("the shared server codec reconstructs the same authoritative files", async () => {
    const server = await import("@margin-chat/workspace-contracts/server");
    const files = { "Shared.md": "---\ntitle: Shared\n---\nText\n\n## Note\n\nKeep this." };
    const local = discoverMarkdownWorkspace(files);
    const remote = server.discoverMarkdownWorkspace(files);
    expect(remote).toEqual(local);
    expect(server.parseMarkdownWorkspace(remote.manifest, remote.files)).toEqual(parseMarkdownWorkspace(local.manifest, local.files));
  });

  test("keeps conflict copies as raw files without importing duplicate entities", () => {
    const original = createMarkdownWorkspace(createEmptyState());
    const raw = Object.values(original.files)[0];
    const discovered = discoverMarkdownWorkspace({ ...original.files, "_conflicts/device/note.md": raw });
    expect(discovered.manifest.files).toHaveLength(1);
    const state = parseMarkdownWorkspace(discovered.manifest, discovered.files)!;
    expect(createMarkdownWorkspace(state, undefined, discovered).files["_conflicts/device/note.md"]).toBe(raw);
  });

  test("keeps an empty vault empty", () => {
    const empty = discoverMarkdownWorkspace({});
    const state = parseMarkdownWorkspace(empty.manifest, empty.files)!;
    expect(state.conversations).toEqual({});
    expect(createMarkdownWorkspace(state).files).toEqual({});
  });

  test("keeps Markdown attachments out of the live note registry", () => {
    const workspace = discoverMarkdownWorkspace({ "Attachments/upload.md": "# Source attachment", "Note.md": "Actual note." });
    expect(workspace.manifest.files.map((file) => file.path)).toEqual(["Note.md"]);
    const state = parseMarkdownWorkspace(workspace.manifest, workspace.files)!;
    expect(createMarkdownWorkspace(state, undefined, workspace).files["Attachments/upload.md"]).toBe("# Source attachment");
  });

  test("reads files saved with Windows line endings", () => {
    const original = createMarkdownWorkspace(createEmptyState());
    original.files = Object.fromEntries(Object.entries(original.files).map(([path, raw]) => [path, raw.replaceAll("\n", "\r\n")]));
    const discovered = discoverMarkdownWorkspace(original.files, original.manifest);
    expect(parseMarkdownWorkspace(discovered.manifest, discovered.files)).not.toBeNull();
  });

  test("preserves literal replacement syntax and multiline custom YAML during an edit", () => {
    const original = createMarkdownWorkspace(createEmptyState());
    const path = original.manifest.files[0].path;
    original.files[path] = original.files[path].replace("---\n", () => "---\ncustom: |\n  First $&\n\n  Last\n");
    const state = parseMarkdownWorkspace(original.manifest, original.files)!;
    state.conversations[state.rootId].title = "Price $& $1";
    const saved = createMarkdownWorkspace(state, undefined, original);
    const savedPath = saved.manifest.files.find((record) => record.id === state.rootId)!.path;
    expect(saved.files[savedPath]).toContain("custom: |\n  First $&\n\n  Last\n");
    expect(parseMarkdownWorkspace(saved.manifest, saved.files)?.conversations[state.rootId].title).toBe("Price $& $1");
  });

  test("renders portable attachment links using the cloud's exact path rules", () => {
    const state = createEmptyState();
    const document = { id: "source_123", filename: "Design [draft] (2).pdf", createdAt: "2026-09-01T00:00:00.000Z", mimeType: "application/pdf", sizeBytes: 10, status: "ready" as const, error: null };
    state.conversations[state.rootId].documents!.push(document);
    const workspace = createMarkdownWorkspace(state);
    const raw = Object.values(workspace.files)[0];
    expect(raw).toContain("## Attachments");
    expect(raw).toContain("../Attachments/source_123/Design%20%5Bdraft%5D%20%282%29.pdf");
    expect(getAttachmentVaultPath({ id: "id", filename: "metadata.json" })).toBe("Attachments/id/original-metadata.json");
    expect(getAttachmentVaultPath({ id: "id", filename: ".." })).toBe("Attachments/id/attachment");
    expect(getAttachmentVaultPath({ id: "../bad", filename: "x" })).toBeNull();
    const oldExport = { ...workspace, files: Object.fromEntries(Object.entries(workspace.files).map(([path, source]) => [path, source.replace(/<!-- margin-chat-attachments -->\n[\s\S]*?<!-- margin-chat-attachments-end -->\n\n/, "")])) };
    expect(createMarkdownWorkspace(state, undefined, oldExport).files).toEqual(oldExport.files);
    const parsed = parseMarkdownWorkspace(workspace.manifest, workspace.files)!;
    parsed.conversations[state.rootId].documents = [];
    const saved = createMarkdownWorkspace(parsed, undefined, workspace);
    expect(Object.values(saved.files)[0]).not.toContain("margin-chat-attachments");
  });
});
