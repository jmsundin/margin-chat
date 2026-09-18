import { describe, expect, test } from "bun:test";
import { createChildConversation, createEmptyState, createMainConversation, createStandaloneNoteConversation } from "../client/src/initialState";
import { createMarkdownWorkspace, createMarkdownWorkspaceRenderer, discoverMarkdownWorkspace, parseMarkdownWorkspace } from "../client/src/lib/workspaceMarkdown";
import { createVaultFileRenderer, hasSameAuthoredState, stateToVaultFiles } from "../client/src/lib/vaultWorkspace";
import { addRootConversation, appendMessageDelta, deleteThread } from "../client/src/lib/workspaceCommands";
import type { AppState, Conversation } from "../client/src/types";
import type { VaultFile } from "../client/src/lib/vaultTypes";

const stamp = "2026-09-18T00:00:00.000Z";

describe("incremental Markdown persistence", () => {
  function changeConversation(state: AppState, id: string, update: (conversation: Conversation) => Conversation) {
    return { ...state, conversations: { ...state.conversations, [id]: update(state.conversations[id]) } };
  }

  test("plain-note first edits and later app edits match full rendering with raw CRLF and custom YAML", () => {
    const files = {
      "Plain.md": "---\r\ncustom: |\r\n  Keep $& and $1\r\n  multiline\r\n---\r\n# A plain note\r\n\r\nCafé 🦉 [[link]]\r\n",
      "Untouched.md": "---\r\ntags: [custom]\r\n---\r\nUnchanged bytes without final newline",
      "_conflicts/device/note.md": "Original conflict\r\n",
    };
    let workspace = discoverMarkdownWorkspace(files);
    let state = parseMarkdownWorkspace(workspace.manifest, workspace.files)!;
    const id = workspace.manifest.files.find((record) => record.path === "Plain.md")!.id;
    const render = createMarkdownWorkspaceRenderer();
    const advance = (next: AppState) => {
      const before = workspace;
      workspace = render(next, stamp, before);
      expect(workspace).toEqual(createMarkdownWorkspace(next, stamp, before));
      state = next;
      expect(workspace.files["Untouched.md"]).toBe(files["Untouched.md"]);
      expect(workspace.files["_conflicts/device/note.md"]).toBe(files["_conflicts/device/note.md"]);
    };
    advance(state);
    advance({ ...state, railOpen: !state.railOpen });
    for (const content of ["First **edit**\n\n## Note\n\nNested heading", "", "Second edit\r\n\r\n```md\r\n## Note\r\n```\r\n"]) {
      advance(changeConversation(state, id, (conversation) => ({
        ...conversation, notes: conversation.notes!.map((note) => ({ ...note, content })),
      })));
    }
    advance(changeConversation(state, id, (conversation) => ({ ...conversation, title: "Price $& $1" })));
    advance(changeConversation(state, id, (conversation) => ({ ...conversation, messages: [
      { id: "context", role: "assistant", createdAt: stamp, content: "Context\r\n## Note\r\n\r\nMust stay a message" },
    ] })));
    advance(changeConversation(state, id, (conversation) => ({ ...conversation, updatedAt: "2026-09-18T01:00:00.000Z" })));
  });

  test("primary-note replacement, note order and parent changes invalidate relationship caches", () => {
    let state = createEmptyState();
    const standalone = createStandaloneNoteConversation({ id: "standalone", noteId: "primary", createdAt: stamp });
    standalone.notes!.push({ ...standalone.notes![0], id: "annotation", kind: "comment", content: "Annotation" });
    const child = createChildConversation({ id: "child", parentConversation: state.conversations[state.rootId], createdAt: stamp });
    state = changeConversation(state, state.rootId, (conversation) => ({ ...conversation, childIds: [child.id] }));
    state = { ...state, conversations: { ...state.conversations, standalone, child } };
    const render = createMarkdownWorkspaceRenderer();
    let workspace = render(state, stamp);
    const advance = (next: AppState) => {
      const before = workspace;
      workspace = render(next, stamp, before);
      expect(workspace).toEqual(createMarkdownWorkspace(next, stamp, before));
      state = next;
    };
    advance(changeConversation(state, "standalone", (conversation) => ({ ...conversation, notes: [...conversation.notes!].reverse() })));
    advance(changeConversation(state, "standalone", (conversation) => ({ ...conversation, notes: conversation.notes!.map((note) => ({
      ...note, kind: note.id === "annotation" ? "standalone" : "comment",
    })) })));
    advance(changeConversation(state, "child", (conversation) => ({ ...conversation, parentId: "standalone" })));
    advance(changeConversation(state, "standalone", (conversation) => ({ ...conversation, childIds: ["child"], title: "Changed parent" })));
    advance(changeConversation(state, "standalone", (conversation) => ({ ...conversation, notes: conversation.notes!.filter((note) => note.kind !== "standalone") })));
    advance(changeConversation(state, "standalone", (conversation) => ({ ...conversation, kind: "chat" })));
  });

  test("renaming a parent or child preserves existing relationship aliases like the full renderer", () => {
    let state = createEmptyState();
    const root = state.conversations[state.rootId];
    const child = createChildConversation({ id: "child", parentConversation: root, createdAt: stamp });
    state = { ...state, conversations: { ...state.conversations, child, [root.id]: { ...root, childIds: [child.id] } } };
    const render = createMarkdownWorkspaceRenderer();
    let workspace = render(state, stamp);
    for (const id of [root.id, child.id]) {
      state = changeConversation(state, id, (conversation) => ({ ...conversation, title: `Renamed ${id}` }));
      const before = workspace;
      workspace = render(state, stamp, before);
      expect(workspace).toEqual(createMarkdownWorkspace(state, stamp, before));
      const otherId = id === root.id ? child.id : root.id;
      const otherPath = workspace.manifest.files.find((record) => record.id === otherId)!.path;
      expect(workspace.files[otherPath]).toBe(before.files[otherPath]);
    }
  });

  test("plain-note default model changes and subsequent unrelated edits match the full baseline", () => {
    let workspace = discoverMarkdownWorkspace({ "Plain.md": "# Plain\n\nKeep these raw bytes.\n" });
    let state = parseMarkdownWorkspace(workspace.manifest, workspace.files)!;
    state = addRootConversation(state, createMainConversation({ id: "chat", createdAt: stamp }));
    const render = createMarkdownWorkspaceRenderer();
    workspace = render(state, stamp, workspace);
    for (const next of [
      { ...state, defaultModelId: "another-model" },
      appendMessageDelta({ ...state, defaultModelId: "another-model" }, "chat", "reply", "next token", stamp),
    ]) {
      const before = workspace;
      workspace = render(next, stamp, before);
      expect(workspace).toEqual(createMarkdownWorkspace(next, stamp, before));
      state = next;
    }
  });

  test("external renames and invalid metadata discard the cached rendered baseline", () => {
    let state = createEmptyState();
    const render = createMarkdownWorkspaceRenderer();
    let workspace = render(state, stamp);
    const oldPath = workspace.manifest.files[0].path;
    const raw = workspace.files[oldPath].replace("---\n", () => "---\ncustom: 'untouched $&'\n") + "\n\n## Custom footer\nKeep this.\n";
    const incoming = discoverMarkdownWorkspace({ "Renamed/Nested.md": raw }, workspace.manifest, workspace.files);
    state = parseMarkdownWorkspace(incoming.manifest, incoming.files)!;
    workspace = render(state, stamp, incoming);
    expect(workspace).toEqual(createMarkdownWorkspace(state, stamp, incoming));
    expect(workspace.files["Renamed/Nested.md"]).toBe(raw);
    const before = workspace;
    state = appendMessageDelta(state, state.rootId, "reply", "Authored after rename", stamp);
    workspace = render(state, stamp, before);
    expect(workspace).toEqual(createMarkdownWorkspace(state, stamp, before));
    expect(workspace.files["Renamed/Nested.md"]).toContain("custom: 'untouched $&'");
    expect(workspace.files["Renamed/Nested.md"]).toContain("## Custom footer\nKeep this.");

    const malformed = { ...workspace, files: {
      ...workspace.files,
      "Renamed/Nested.md": workspace.files["Renamed/Nested.md"].replace(/<!-- margin-chat-metadata .+ -->/, "<!-- margin-chat-metadata {broken} -->"),
    } };
    const originalBytes = structuredClone(malformed.files);
    expect(() => render(state, stamp, malformed)).toThrow("could not be parsed");
    expect(malformed.files).toEqual(originalBytes);
    // A rejected incoming snapshot must not poison the last successful cache.
    expect(render(state, stamp, workspace)).toEqual(createMarkdownWorkspace(state, stamp, workspace));
  });

  test("vault renderer preserves binary companions and settings across multiple incremental saves", () => {
    let state = createEmptyState();
    const render = createVaultFileRenderer();
    let files: Record<string, VaultFile> = {
      ...stateToVaultFiles(state, {}),
      "Attachments/upload/original.md": { content: "AAEC/w==", encoding: "base64" as const, contentType: "application/octet-stream" },
      "Attachments/upload/metadata.json": { content: '{"custom":"original bytes"}', contentType: "application/json" },
      "_conflicts/device/original.md": { content: "Raw conflict\r\n", contentType: "text/markdown; charset=utf-8" },
    };
    const companions = Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith("Attachments/") || path.startsWith("_conflicts/")));
    files = render(state, files);
    for (let index = 0; index < 4; index++) {
      const before = files;
      state = appendMessageDelta(state, state.rootId, "reply", `chunk-${index}`, stamp);
      state = { ...state, pinnedThreadIds: [state.rootId], groups: {
        group: { id: "group", name: `Group ${index}`, color: "#111111", collapsed: false, conversationIds: [state.rootId] },
      } };
      files = render(state, before);
      expect(files).toEqual(stateToVaultFiles(state, before));
      for (const [path, companion] of Object.entries(companions)) expect(files[path]).toEqual(companion);
    }
  });

  test("edits preserve the full renderer's bytes across notes, streaming, annotation changes, deletion and external files", () => {
    let state = createEmptyState();
    const note = createStandaloneNoteConversation({ id: "note", noteId: "body", createdAt: stamp });
    note.notes![0].content = "Original **note**";
    state = addRootConversation(state, note);
    const render = createMarkdownWorkspaceRenderer();
    let workspace = render(state, stamp);
    for (let i = 0; i < 12; i++) {
      const before = workspace;
      state = i % 2 === 0 ? appendMessageDelta(state, "conversation-root", "reply", `part ${i} `, stamp)
        : { ...state, conversations: { ...state.conversations, note: {
          ...state.conversations.note, title: `Note ${i}`, notes: state.conversations.note.notes!.map((item) => ({ ...item, content: `${item.content}\nEdit ${i}` })),
        } } };
      workspace = render(state, stamp, before);
      expect(workspace).toEqual(createMarkdownWorkspace(state, stamp, before));
    }
    const childNote = { ...state.conversations.note.notes![0], id: "annotation", kind: "comment" as const, content: "New annotation" };
    state = { ...state, conversations: { ...state.conversations, note: { ...state.conversations.note, notes: [...state.conversations.note.notes!, childNote] } } };
    let before = workspace;
    workspace = render(state, stamp, before);
    expect(workspace).toEqual(createMarkdownWorkspace(state, stamp, before));
    state = deleteThread(state, "conversation-root", createMainConversation({ id: "unused" }));
    before = workspace;
    workspace = render(state, stamp, before);
    expect(workspace).toEqual(createMarkdownWorkspace(state, stamp, before));

    // An external edit must invalidate the entire prior cache, including raw frontmatter.
    const files = { ...workspace.files, "External.md": "---\r\ncustom: preserve\r\n---\r\nOutside edit.\r\n" };
    const external = discoverMarkdownWorkspace(files, workspace.manifest);
    state = parseMarkdownWorkspace(external.manifest, external.files)!;
    workspace = render(state, stamp, external);
    expect(workspace).toEqual(createMarkdownWorkspace(state, stamp, external));
    expect(workspace.files["External.md"]).toContain("custom: preserve\r\n");
  });

  test("an unchanged conversation's message bodies are not re-rendered during another conversation's stream", () => {
    let state = createEmptyState();
    const other = createMainConversation({ id: "other" });
    let bodyReads = 0;
    other.messages = [{ id: "large", role: "user", createdAt: stamp, get content() { bodyReads++; return "large body"; } }];
    state = addRootConversation(state, other);
    const render = createMarkdownWorkspaceRenderer();
    let workspace = render(state, stamp);
    bodyReads = 0;
    state = appendMessageDelta(state, "conversation-root", "reply", "new token", stamp);
    workspace = render(state, stamp, workspace);
    expect(bodyReads).toBe(0);
    expect(Object.values(workspace.files).some((source) => source.includes("new token"))).toBe(true);
  });

  test("vault renderer reuses unchanged file objects and view-only state is excluded from authored changes", () => {
    let state = addRootConversation(createEmptyState(), createMainConversation({ id: "other" }));
    const render = createVaultFileRenderer();
    const first = render(state, {});
    const nextState = appendMessageDelta(state, "conversation-root", "reply", "updated", stamp);
    const next = render(nextState, first);
    expect(next).toEqual(stateToVaultFiles(nextState, first));
    const unchangedPath = Object.keys(first).find((path) => path.endsWith(".md") && first[path].content.includes('"id":"other"'))!;
    expect(unchangedPath).toBeDefined();
    expect(next[unchangedPath]).toBe(first[unchangedPath]);
    expect(hasSameAuthoredState(state, { ...state, rootId: "conversation-root", activeConversationId: "conversation-root", railOpen: !state.railOpen })).toBe(true);
    expect(hasSameAuthoredState(state, nextState)).toBe(false);
  });
});
