import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import * as browser from "@margin-chat/workspace-contracts/browser";
import * as server from "@margin-chat/workspace-contracts/server";
import { DEFAULT_BACKEND_SERVICE_ID, getDefaultModelIdForService } from "../client/src/lib/services";
import { createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";
import { createAppStateFromWorkspaceDocument as readClientDocument } from "../client/src/lib/workspaceModel";
import { createAppStateFromWorkspaceDocument as readServerDocument } from "../server/db/workspaceDocument.mjs";

function documentFixture() {
  const state = createEmptyState();
  const note = createStandaloneNoteConversation({
    id: "contract-note",
    noteId: "contract-note-body",
    createdAt: "2026-08-20T00:00:00.000Z",
  });
  note.notes!.push({
    id: "contract-annotation",
    kind: "comment",
    content: "Annotation",
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    sourceMessageId: null,
    startOffset: null,
    endOffset: null,
    quote: null,
  });
  state.conversations[note.id] = note;
  return browser.createWorkspaceDocument(state);
}

describe("shared workspace document policies", () => {
  test("manual and automatic grouping survive document and Markdown round trips", () => {
    const document = documentFixture();
    const rootId = document.view.activeRootId;
    document.items[rootId].grouping = "manual";
    document.items["contract-note"].grouping = "automatic";
    const state = browser.createAppStateFromWorkspaceDocument(document)!;
    expect(state.conversations[rootId].grouping).toBe("manual");
    expect(state.conversations["contract-note"].grouping).toBe("automatic");
    const normalized = readServerDocument(browser.createWorkspaceDocument(state))!;
    expect(normalized.conversations[rootId].grouping).toBe("manual");
    expect(normalized.conversations["contract-note"].grouping).toBe("automatic");
    const markdown = browser.createMarkdownWorkspace(state);
    const restored = server.parseMarkdownWorkspace(markdown.manifest, markdown.files)!;
    expect(restored.conversations[rootId].grouping).toBe("manual");
    expect(restored.conversations["contract-note"].grouping).toBe("automatic");
  });

  const malformed: Array<[string, (document: any) => unknown]> = [
    ["null", () => null],
    ["array", () => []],
    ["unknown schema", (document) => ({ ...document, schemaVersion: 99 })],
    ["missing preferences", (document) => ({ ...document, preferences: null })],
    ["array preferences", (document) => ({ ...document, preferences: [] })],
    ["array view", (document) => ({ ...document, view: [] })],
    ["array items", (document) => ({ ...document, items: [] })],
    ["array annotations", (document) => ({ ...document, annotations: [] })],
    ["null item", (document) => { document.items["contract-note"] = null; return document; }],
    ["mismatched item identity", (document) => { document.items["contract-note"].id = "another-id"; return document; }],
    ["unknown item kind", (document) => { document.items["contract-note"].kind = "drawing"; return document; }],
    ["null annotation", (document) => { document.annotations["contract-annotation"] = null; return document; }],
    ["mismatched annotation identity", (document) => { document.annotations["contract-annotation"].id = "another-id"; return document; }],
  ];

  for (const [name, corrupt] of malformed) {
    test(`both policies reject ${name} without throwing`, () => {
      const input = corrupt(documentFixture());
      for (const mode of ["strict", "recovery"] as const) {
        expect(browser.createAppStateFromWorkspaceDocument(input, { mode })).toBeNull();
        expect(server.createAppStateFromWorkspaceDocument(input, { mode })).toBeNull();
      }
    });
  }

  test("makes orphan recovery explicit and preserves adapter defaults", () => {
    const document = documentFixture();
    document.annotations["contract-annotation"].parentId = "missing-parent";
    const recovered = browser.createAppStateFromWorkspaceDocument(document);
    expect(recovered).not.toBeNull();
    expect(recovered!.conversations["contract-note"].notes).toHaveLength(1);
    expect(server.createAppStateFromWorkspaceDocument(document)).toBeNull();
    expect(browser.createAppStateFromWorkspaceDocument(document, { mode: "strict" })).toBeNull();
    expect(server.createAppStateFromWorkspaceDocument(document, { mode: "recovery" })).toEqual(recovered);
    expect(readClientDocument(document)).toEqual(recovered);
    expect(readServerDocument(document)).toBeNull();
  });

  test("distinguishes an empty legacy snapshot from an empty authoritative vault", () => {
    const document = { ...documentFixture(), items: {}, annotations: {} };
    expect(browser.createAppStateFromWorkspaceDocument(document)).toBeNull();
    expect(server.createAppStateFromWorkspaceDocument(document)?.conversations).toEqual({});
    const vault = browser.discoverMarkdownWorkspace({});
    expect(browser.parseMarkdownWorkspace(vault.manifest, vault.files)?.conversations).toEqual({});
    expect(server.parseMarkdownWorkspace(vault.manifest, vault.files)?.conversations).toEqual({});
  });

  test("uses identical optional note defaults and ordering in both policies", () => {
    const document = documentFixture();
    const note = document.items["contract-note"];
    if (note.kind !== "note") throw new Error("Expected note fixture");
    for (const field of ["content", "noteCreatedAt", "noteUpdatedAt", "noteSortOrder", "branchAnchor", "parentId", "messages", "documents"]) {
      delete (note as any)[field];
    }
    delete (document.annotations["contract-annotation"] as any).sortOrder;
    const local = browser.createAppStateFromWorkspaceDocument(document);
    expect(local).toEqual(server.createAppStateFromWorkspaceDocument(document));
    expect(local!.conversations["contract-note"].notes!.map((entry) => entry.id)).toEqual([
      "contract-note-body", "contract-annotation",
    ]);
    expect(local!.conversations["contract-note"].notes![0]).toMatchObject({
      content: "", createdAt: note.createdAt, updatedAt: note.updatedAt,
    });
    expect(local!.conversations["contract-note"]).toMatchObject({
      branchAnchor: null, parentId: null, messages: [], documents: [],
    });
  });

  test("format discovery defaults match the app's default service selection", () => {
    expect(server.DEFAULT_WORKSPACE_PREFERENCES).toEqual({
      defaultServiceId: DEFAULT_BACKEND_SERVICE_ID,
      defaultModelId: getDefaultModelIdForService(DEFAULT_BACKEND_SERVICE_ID),
    });
  });
});

describe("shared Markdown runtime", () => {
  test("browser and server expose the same codec functions, not compiled copies", () => {
    expect(browser.createMarkdownWorkspace).toBe(server.createMarkdownWorkspace);
    expect(browser.parseMarkdownWorkspace).toBe(server.parseMarkdownWorkspace);
    expect(browser.discoverMarkdownWorkspace).toBe(server.discoverMarkdownWorkspace);
    expect(browser.encodeReadableMarkdown).toBe(server.encodeReadableMarkdown);
    expect(browser.decodeReadableMarkdown).toBe(server.decodeReadableMarkdown);
  });

  const badMetadata = [
    "<!-- margin-chat-metadata {broken-json} -->",
    '<!-- margin-chat-metadata {"schemaVersion":99,"entityType":"conversation"} -->',
    '<!-- margin-chat-metadata {"schemaVersion":1,"entityType":"unknown"} -->',
    "<!-- margin-chat-metadata unfinished",
  ];
  for (const [index, source] of badMetadata.entries()) {
    test(`both runtimes reject malformed metadata ${index + 1} and leave bytes intact`, () => {
      const files = { "Broken.md": `# Preserve me\r\n${source}\r\nUnchanged body\r\n` };
      const before = structuredClone(files);
      expect(() => browser.discoverMarkdownWorkspace(files)).toThrow();
      expect(() => server.discoverMarkdownWorkspace(files)).toThrow();
      expect(files).toEqual(before);
    });
  }

  test("both runtimes reject missing files and malformed message blocks", () => {
    const state = createEmptyState();
    state.conversations[state.rootId].messages.push({
      id: "message", content: "Keep this content", role: "user", createdAt: "2026-08-20T00:00:00.000Z",
    });
    const workspace = browser.createMarkdownWorkspace(state);
    const path = workspace.manifest.files[0].path;
    for (const source of [workspace.files[path], browser.decodeReadableMarkdown(workspace.files[path])]) {
      const damaged = source.replace(/^<!-- margin-chat-(?:message|msg)-end(?: .+)? -->\r?$/m, "");
      expect(damaged).not.toBe(source);
      for (const files of [{}, { [path]: damaged }]) {
        expect(browser.parseMarkdownWorkspace(workspace.manifest, files)).toBeNull();
        expect(server.parseMarkdownWorkspace(workspace.manifest, files)).toBeNull();
      }
    }
  });

  test("both runtimes read version 3 and 4 manifests and reject broken readable registries", () => {
    const workspace = browser.createMarkdownWorkspace(createEmptyState());
    for (const formatVersion of [3, 4]) {
      expect(browser.parseMarkdownWorkspaceManifest({ ...workspace.manifest, formatVersion })).not.toBeNull();
      expect(server.parseMarkdownWorkspaceManifest({ ...workspace.manifest, formatVersion })).not.toBeNull();
    }
    const path = workspace.manifest.files[0].path;
    const source = workspace.files[path];
    const damaged = source.replace(/^margin-chat: \|-\r?\n/m, (opening) => `${opening}  broken registry\n`);
    expect(damaged).not.toBe(source);
    const files = { [path]: damaged };
    expect(() => browser.discoverMarkdownWorkspace(files)).toThrow();
    expect(() => server.discoverMarkdownWorkspace(files)).toThrow();
    expect(files[path]).toBe(damaged);
  });

  test("both runtimes reject invalid manifest paths, aliases, versions and dates", () => {
    const manifest = browser.discoverMarkdownWorkspace({ "Valid.md": "Body" }).manifest;
    const inputs = [
      null,
      [],
      { ...manifest, formatVersion: 99 },
      { ...manifest, savedAt: "not-a-date" },
      { ...manifest, files: [{ ...manifest.files[0], path: "../escape.md" }] },
      { ...manifest, files: [{ ...manifest.files[0], aliases: ["../escape.md"] }] },
      { ...manifest, files: [{ ...manifest.files[0], type: "unknown" }] },
    ];
    for (const input of inputs) {
      expect(browser.parseMarkdownWorkspaceManifest(input)).toBeNull();
      expect(server.parseMarkdownWorkspaceManifest(input)).toBeNull();
    }
  });

  test("native Node imports the canonical codec and preserves authored source bytes", () => {
    const files = {
      "Nested/Windows note.md": "---\r\ntitle: Windows\r\ncustom: |\r\n  Keep $& and $1\r\n---\r\n# Note\r\n\r\nCafé 🦉\r\n[[Unknown|Alias]]\r\n",
      "Unix note.md": "# Untouched\n\n```md\n## Note\n```\n\nNo trailing newline",
      "_conflicts/device/note.md": "Exact conflict copy\r\n",
      "Attachments/source.md": "# Original Markdown attachment\r\n",
    };
    const local = browser.discoverMarkdownWorkspace(files);
    const localState = browser.parseMarkdownWorkspace(local.manifest, local.files)!;
    localState.railOpen = !localState.railOpen;
    const localUpdated = browser.createMarkdownWorkspace(localState, local.manifest.savedAt, local);
    expect(localUpdated.files).toEqual(files);

    const script = `
      import * as codec from '@margin-chat/workspace-contracts/server';
      import { createAppStateFromWorkspaceDocument } from './server/db/workspaceDocument.mjs';
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const files = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const workspace = codec.discoverMarkdownWorkspace(files);
      const state = codec.parseMarkdownWorkspace(workspace.manifest, workspace.files);
      state.railOpen = !state.railOpen;
      const updated = codec.createMarkdownWorkspace(state, workspace.manifest.savedAt, workspace);
      const roundTrip = createAppStateFromWorkspaceDocument(codec.createWorkspaceDocument(state));
      process.stdout.write(JSON.stringify({ workspace, updated, roundTrip }));
    `;
    const result = Bun.spawnSync(["node", "--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      stdin: Buffer.from(JSON.stringify(files)),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    const remote = JSON.parse(result.stdout.toString());
    expect(remote.workspace).toEqual(local);
    expect(remote.updated).toEqual(localUpdated);
    expect(remote.roundTrip).toEqual(localState);
  });
});
