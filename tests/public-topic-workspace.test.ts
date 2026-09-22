import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAppStateFromWorkspaceDocument, createWorkspaceDocument,
  normalizePublicTopicId, normalizePublicTopicSource,
} from "@margin-chat/workspace-contracts";
import { createEmptyState } from "../client/src/initialState";
import { hydratePersistedState } from "../client/src/lib/appState";
import { findSavedPublicTopic, savePublicTopic } from "../client/src/lib/publicTopicWorkspace";
import { createMarkdownWorkspace, parseMarkdownWorkspace } from "../client/src/lib/workspaceMarkdown";
import { createVaultFileRenderer, stateToVaultFiles, vaultToState } from "../client/src/lib/vaultWorkspace";
import { exportVault, importVault } from "../client/src/lib/vaultLocal";
import { emptyVault, type VaultFile } from "../client/src/lib/vaultTypes";
import type { PublicTopicSource } from "../client/src/types";
import { normalizeAppState } from "../server/db/validation.mjs";
import { createVaultService } from "../server/vault/index.mjs";
import { createFileVaultStorage } from "../server/vault/storage.mjs";

const topic: PublicTopicSource = {
  id: "Q21198", aliases: ["Q123"], label: "Computer science", description: "Study of computation",
  wikidataUrl: "https://www.wikidata.org/wiki/Q21198",
  wikipediaUrl: "https://en.wikipedia.org/wiki/Computer_science",
  retrievedAt: "2026-09-20T12:00:00.000Z", revision: 12345,
};

function savedFixture() {
  const initial = createEmptyState();
  const saved = savePublicTopic(initial, topic);
  const conversation = saved.state.conversations[saved.conversationId];
  conversation.title = "My computing questions";
  conversation.notes![0].content = "A **private** question.\n\n## Sources I still need";
  conversation.linkedConversationIds = [initial.rootId];
  return saved;
}

describe("public topic identity and saving", () => {
  test("normalizes item IDs and safe provenance without treating text aliases as identity", () => {
    expect(normalizePublicTopicId(" q21198 ")).toBe("Q21198");
    for (const id of ["Computer science", "Q01", "Q0", "Q-1", "P31", "Q1/page", null]) expect(normalizePublicTopicId(id)).toBeNull();
    expect(normalizePublicTopicSource({ ...topic, id: "q21198", aliases: ["q123", "Q123", "Q21198", "Computer science", 4],
      wikidataUrl: "javascript:alert(1)", wikipediaUrl: "https://en.wikipedia.org.evil.example/wiki/Test" })).toEqual({
      ...topic, aliases: ["Q123"], wikipediaUrl: undefined,
    });
    for (const field of [{ id: "wrong" }, { label: " " }, { retrievedAt: "not a date" }]) {
      expect(normalizePublicTopicSource({ ...topic, ...field })).toBeUndefined();
    }
    expect(normalizePublicTopicSource({ ...topic, revision: -1 })?.revision).toBeUndefined();
  });

  test("creates one standalone empty personal note without changing navigation or the input", () => {
    const initial = createEmptyState();
    const before = structuredClone(initial);
    const first = savePublicTopic(initial, topic);
    expect(first.created).toBe(true);
    expect(first.state.rootId).toBe(initial.rootId);
    expect(first.state.activeConversationId).toBe(initial.activeConversationId);
    expect(first.state.conversations[first.conversationId]).toMatchObject({
      kind: "note", title: topic.label, parentId: null, messages: [], childIds: [], publicTopic: topic,
      notes: [{ content: "", kind: "standalone" }],
    });
    expect(initial).toEqual(before);
    expect(savePublicTopic(initial, topic)).toEqual(first);
    const repeated = savePublicTopic(first.state, topic);
    expect(repeated).toEqual({ state: first.state, conversationId: first.conversationId, created: false });
    expect(repeated.state).toBe(first.state);
  });

  test("matches canonical IDs and redirect aliases, preserving authored edits and layouts", () => {
    const saved = savedFixture();
    const before = structuredClone(saved.state);
    expect(findSavedPublicTopic(saved.state.conversations, "q123")?.id).toBe(saved.conversationId);
    expect(findSavedPublicTopic(saved.state.conversations, "Computer science")).toBeNull();
    const redirected = { ...topic, id: "Q999", aliases: ["Q21198", "Q123"], label: "Updated public label" };
    const result = savePublicTopic(saved.state, redirected);
    expect(result.created).toBe(false);
    expect(result.conversationId).toBe(saved.conversationId);
    expect(result.state.conversations[saved.conversationId]).toMatchObject({
      title: "My computing questions", notes: before.conversations[saved.conversationId].notes,
      linkedConversationIds: before.conversations[saved.conversationId].linkedConversationIds,
      publicTopic: { id: "Q999", aliases: ["Q123", "Q21198"] },
    });
    expect(result.state.graphLayouts).toBe(saved.state.graphLayouts);
    expect(saved.state).toEqual(before);
    const reopened = vaultToState(stateToVaultFiles(result.state, {}), createEmptyState());
    expect(savePublicTopic(reopened, { ...redirected, aliases: [] }).conversationId).toBe(saved.conversationId);
    expect(findSavedPublicTopic(reopened.conversations, "Q21198")?.id).toBe(saved.conversationId);
  });

  test("does not merge a same-titled personal note or overwrite an unrelated deterministic ID", () => {
    const initial = createEmptyState();
    const root = initial.conversations[initial.rootId];
    root.title = topic.label;
    initial.conversations[`public-topic-${topic.id}`] = { ...root, id: `public-topic-${topic.id}` };
    const saved = savePublicTopic(initial, topic);
    expect(saved.created).toBe(true);
    expect(saved.conversationId).toBe(`public-topic-${topic.id}-2`);
    expect(saved.state.conversations[root.id]).toBe(root);
  });
});

describe("public source and personal link persistence", () => {
  test("JSON, client recovery and server normalization preserve both fields and remove invalid links", () => {
    const saved = savedFixture();
    const source = saved.state.conversations[saved.conversationId];
    source.linkedConversationIds!.push(source.id, "missing", saved.state.rootId);
    const document = JSON.parse(JSON.stringify(createWorkspaceDocument(saved.state)));
    const paths = [
      createAppStateFromWorkspaceDocument(document)!,
      hydratePersistedState(JSON.parse(JSON.stringify(saved.state)))!,
      { conversations: Object.fromEntries(normalizeAppState(saved.state).conversations.map((entry: any) => [entry.id, entry])) },
    ];
    for (const state of paths) {
      const restored = state.conversations[saved.conversationId];
      expect(restored.publicTopic).toEqual(topic);
      expect(restored.linkedConversationIds).toEqual([saved.state.rootId]);
      expect(restored.notes).toEqual(source.notes);
      expect(restored.parentId).toBeNull();
    }
  });

  test("malformed optional provenance cannot discard a personal note", () => {
    const saved = savedFixture();
    (saved.state.conversations[saved.conversationId] as any).publicTopic = { id: "Qbad" };
    const workspace = createMarkdownWorkspace(saved.state);
    const restored = [
      hydratePersistedState(saved.state),
      createAppStateFromWorkspaceDocument(createWorkspaceDocument(saved.state)),
      parseMarkdownWorkspace(workspace.manifest, workspace.files),
    ];
    for (const state of restored) {
      expect(state!.conversations[saved.conversationId].publicTopic).toBeUndefined();
      expect(state!.conversations[saved.conversationId].notes).toEqual(saved.state.conversations[saved.conversationId].notes);
    }
  });

  test("Markdown keeps public provenance outside personal content and renders distinct personal links", () => {
    const saved = savedFixture();
    const workspace = createMarkdownWorkspace(saved.state);
    const path = workspace.manifest.files.find((record) => record.id === saved.conversationId)!.path;
    expect(workspace.files[path]).toContain(`public-topic-id: "${topic.id}"`);
    expect(workspace.files[path]).toContain(`public-topic-source: "${topic.wikidataUrl}"`);
    expect(workspace.files[path]).toContain("- Linked: [[");
    const restored = parseMarkdownWorkspace(workspace.manifest, workspace.files)!;
    expect(restored.conversations[saved.conversationId]).toEqual(saved.state.conversations[saved.conversationId]);
    const files = { ...workspace.files, [path]: workspace.files[path].replace(/^- Linked:.*\n?/m, "") };
    expect(parseMarkdownWorkspace(workspace.manifest, files)!.conversations[saved.conversationId].linkedConversationIds).toEqual([]);
  });

  test("incremental Markdown save handles connecting, disconnecting and editing notes without stale links", () => {
    const saved = savedFixture();
    const render = createVaultFileRenderer();
    const first = render(saved.state, {});
    const source = saved.state.conversations[saved.conversationId];
    const next = { ...saved.state, conversations: { ...saved.state.conversations,
      [source.id]: { ...source, linkedConversationIds: [], notes: source.notes!.map((note) => ({ ...note, content: "Edited private note" })) },
    } };
    const second = render(next, first);
    const restored = vaultToState(second, createEmptyState());
    expect(restored.conversations[source.id].publicTopic).toEqual(topic);
    expect(restored.conversations[source.id].linkedConversationIds).toEqual([]);
    expect(restored.conversations[source.id].notes![0].content).toBe("Edited private note");
    const third = render({ ...next, conversations: { ...next.conversations,
      [source.id]: { ...next.conversations[source.id], linkedConversationIds: [next.rootId] },
    } }, second);
    expect(vaultToState(third, createEmptyState()).conversations[source.id].linkedConversationIds).toEqual([next.rootId]);
  });

  test("portable ZIP backup and reopening retain canonical identity, aliases and user links", () => {
    const saved = savedFixture();
    const snapshot = { ...emptyVault(), files: stateToVaultFiles(saved.state, {}) };
    const files = importVault(exportVault(snapshot));
    const restored = vaultToState(files, createEmptyState());
    expect(restored.conversations[saved.conversationId]).toEqual(saved.state.conversations[saved.conversationId]);
    expect(savePublicTopic(restored, topic).created).toBe(false);
  });

  test("cloud file commit, server hydration and a fresh-device reload retain identity and personal links", async () => {
    const directory = await mkdtemp(join(tmpdir(), "margin-public-topic-"));
    try {
      const server = createVaultService({ storage: createFileVaultStorage(directory) });
      const saved = savedFixture();
      const files = stateToVaultFiles(saved.state, {});
      const committed = await server.commit("public-topic-test", Object.entries(files).map(([path, file]) => ({
        path, content: file.content, contentType: file.contentType, baseRevision: null,
      })));
      const read = await server.readWorkspace("public-topic-test", committed.manifest);
      expect(read.conversations[saved.conversationId].publicTopic).toEqual(topic);
      expect(read.conversations[saved.conversationId].linkedConversationIds).toEqual([saved.state.rootId]);
      const downloaded: Record<string, VaultFile> = {};
      for (const [path, entry] of Object.entries(committed.manifest.files) as Array<[string, any]>) {
        downloaded[path] = { content: (await server.readFile({ userId: "public-topic-test", path, revision: entry.revision })).bytes.toString("utf8") };
      }
      const restored = vaultToState(downloaded, createEmptyState());
      expect(restored.conversations[saved.conversationId]).toEqual(saved.state.conversations[saved.conversationId]);
      expect(findSavedPublicTopic(restored.conversations, topic.aliases[0])?.id).toBe(saved.conversationId);
      expect(savePublicTopic(restored, topic).created).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
