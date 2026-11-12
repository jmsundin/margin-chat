import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as markdown from "@margin-chat/workspace-contracts/markdown";
import { createCaptureTestDatabase } from "./helpers/captureDatabase.mjs";
import { readState, readVaultProjectionCheckpoint, writeState } from "../server/db/repository.mjs";
import { normalizeAppState } from "../server/db/validation.mjs";
import { createVaultService } from "../server/vault/index.mjs";
import { prepareProjectionState } from "../server/vault/projectionState.mjs";
import { digest } from "../server/vault/storage.mjs";
import { createVaultTools } from "../server/chat/agent/vaultTools.mjs";
import { createEmptyState } from "../client/src/initialState";

function memoryStorage() {
  const objects = new Map<string, Buffer>();
  return {
    kind: "memory", objects,
    async read(key: string) { const bytes = objects.get(key); return bytes ? { bytes, etag: digest(bytes) } : null; },
    async putImmutable(key: string, bytes: Buffer) { objects.set(key, Buffer.from(bytes)); },
    async compareAndSwap(key: string, bytes: Buffer, expected: string | null) {
      if ((objects.has(key) ? digest(objects.get(key)!) : null) !== expected) return false;
      objects.set(key, Buffer.from(bytes)); return true;
    },
  };
}

/** Two roots and a branch of the first, as the app saves them. */
function workspace() {
  const state: any = createEmptyState();
  const root = state.conversations[state.rootId];
  root.title = "First";
  root.messages = [{ id: "m-1", role: "user", content: "Hello", createdAt: root.createdAt }];
  const second = { ...structuredClone(root), id: "second", title: "Second", messages: [{ id: "m-2", role: "user", content: "Two", createdAt: root.createdAt }] };
  state.conversations.second = second;
  return state;
}

describe("projection repair", () => {
  test("a valid state is left exactly as it was", () => {
    const state = workspace();
    const before = structuredClone(state);
    expect(prepareProjectionState(state).repairs).toEqual([]);
    expect(state).toEqual(before);
  });

  test("a margin note whose source is gone is left out, not the whole account", () => {
    const state = workspace();
    const first = state.conversations[state.rootId];
    first.notes = [{ id: "n-1", kind: "comment", content: "Orphan", sourceMessageId: "deleted-message",
      startOffset: 0, endOffset: 1, quote: "H", createdAt: first.createdAt, updatedAt: first.createdAt }];
    const { repairs } = prepareProjectionState(state);
    expect(repairs).toEqual([{ id: first.id, reason: "margin note source missing" }]);
    expect(Object.keys(state.conversations)).toHaveLength(2);
    expect(() => normalizeAppState(state)).not.toThrow();
  });

  test("a copied chat that reuses message ids is left out of the index; the original stays", () => {
    const state = workspace();
    state.conversations.second.messages[0].id = "m-1";
    const { repairs } = prepareProjectionState(state);
    expect(repairs).toEqual([{ id: "second", reason: "duplicate message id" }]);
    expect(Object.keys(state.conversations)).toEqual([state.rootId]);
  });

  test("a branch whose parent file is missing becomes a top-level document", () => {
    const state = workspace();
    state.conversations.second.parentId = "deleted-parent";
    prepareProjectionState(state);
    expect(state.conversations.second.parentId).toBeNull();
    expect(() => normalizeAppState(state)).not.toThrow();
  });

  test("a parent cycle is broken", () => {
    const state = workspace();
    const third = { ...structuredClone(state.conversations.second), id: "third", title: "Third", messages: [] };
    state.conversations.third = third;
    state.conversations.second.parentId = "third";
    state.conversations.third.parentId = "second";
    const { repairs } = prepareProjectionState(state);
    expect(repairs.some((repair) => repair.reason === "parent cycle")).toBe(true);
    expect(() => normalizeAppState(state)).not.toThrow();
  });

  test("an error it doesn't understand is still thrown", () => {
    const state = workspace();
    state.railOpen = "yes";
    expect(() => prepareProjectionState(state)).toThrow("railOpen");
  });
});

describe("a document the index can't hold", () => {
  let fixture: Awaited<ReturnType<typeof createCaptureTestDatabase>>;
  beforeAll(async () => { fixture = await createCaptureTestDatabase(); }, 30000);
  afterAll(async () => { await fixture?.pg.close(); });

  async function user() {
    const id = crypto.randomUUID();
    await fixture.client.query(
      "insert into marginchat_users (id, email, password_hash, display_name) values ($1, $2, 'unused', 'Repair test')",
      [id, `${id}@example.test`],
    );
    return id;
  }

  const database = {
    getVaultProjectionCheckpoint: (id: string) => readVaultProjectionCheckpoint(fixture.client, id),
    // A search-index copy that stopped updating: reads must not serve it.
    readAgentConversation: async ({ conversationId }: any) => ({ id: conversationId, title: "Stale", kind: "note", parentId: null,
      updatedAt: "2026-10-20T04:00:00.000Z", text: "Stale copy." }),
    projectVaultState: (id: string, source: any, revision: number, options: any) =>
      writeState(fixture.client, id, source === null ? null : normalizeAppState(source), {
        vaultRevision: revision, forceVaultProjection: options.force,
        vaultAttachments: options.attachments, deletedVaultAttachmentIds: options.deletedAttachmentIds,
        attachmentRevisions: options.attachmentRevisions,
        expectedVaultProjectionRevision: options.expectedProjectionRevision,
        unchangedConversationIds: options.unchangedConversationIds,
      }),
  };

  // The real codec, except that "Broken.md" parses with a margin note on a deleted block.
  const codec = {
    ...markdown,
    parseMarkdownWorkspace(manifest: any, files: any) {
      const state = markdown.parseMarkdownWorkspace(manifest, files);
      for (const conversation of Object.values(state?.conversations ?? {}) as any[]) {
        if (conversation.title !== "Broken") continue;
        conversation.notes = [...(conversation.notes ?? []), { id: `${conversation.id}-orphan`, kind: "comment", content: "Orphan",
          sourceMessageId: "deleted-block", startOffset: 0, endOffset: 1, quote: "x", createdAt: conversation.createdAt, updatedAt: conversation.createdAt }];
      }
      return state;
    },
  };

  test("every later save is still indexed, and reads come from the saved Markdown", async () => {
    const userId = await user();
    const vault = createVaultService({ storage: memoryStorage(), database, codec: codec as any });
    const first = await vault.commit(userId, [
      { path: "Broken.md", content: "# Broken\n\nOld text.\n", baseRevision: null },
      { path: "Fine.md", content: "# Fine\n\nText.\n", baseRevision: null },
    ]);
    expect(first.projection.status).toBe("ready");
    const later = await vault.commit(userId, [{ path: "Later.md", content: "# Later\n\nWritten after.\n", baseRevision: null }]);
    expect(later.projection.status).toBe("ready");
    expect((await readVaultProjectionCheckpoint(fixture.client, userId))?.revision).toBe(later.manifest.revision);
    const titles = Object.values((await readState(fixture.client, userId)).conversations).map((conversation: any) => conversation.title).sort();
    expect(titles).toEqual(["Broken", "Fine", "Later"]);

    const index = await vault.index(userId);
    const laterId = index.entries.find((entry: any) => entry.title === "Later")!.id;
    const tools = createVaultTools({
      chatRequest: { ai: { agentScope: "workspace" }, conversation: { id: "", ancestorContext: [] } } as any,
      workspace: { userId, vault, database } as any, snapshots: new Map(), readCharacters: 10_000,
    })!;
    const read = await tools.run("read_document", { document_id: laterId });
    expect(read.found).toBe(true);
    expect(read.document.text).toContain("Written after.");
    expect(read.document.text).not.toContain("Stale copy.");
    expect(read.document.title).toBe("Later");
  });
});
