import { describe, expect, test } from "bun:test";
import {
  createChildConversation,
  createEmptyState,
  createStandaloneNoteConversation,
} from "../client/src/initialState";
import {
  createMarkdownWorkspace,
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
