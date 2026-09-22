import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import type { AppState, Conversation, DocumentBlock } from "@margin-chat/workspace-contracts";
import { createEmptyState } from "../client/src/initialState";
import { hydratePersistedState } from "../client/src/lib/appState";
import { getEditableDocument, insertDocumentBlock, removeDocumentBlock, retainDocumentBlockSource } from "../client/src/lib/editableDocument";
import { loadMigrations, migrateDatabase } from "../server/db/migrations.mjs";
import { readState, writeState } from "../server/db/repository.mjs";
import { normalizeAppState } from "../server/db/validation.mjs";

const createdAt = "2026-09-20T12:00:00.000Z";
const databases: PGlite[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map((database) => database.close())); });
function database() {
  const pg = new PGlite({ extensions: { vector } });
  databases.push(pg);
  return { pg, client: { async query(sql: string, values?: unknown[]) {
    const result = values === undefined && sql.includes(";") ? (await pg.exec(sql)).at(-1)! : await pg.query(sql, values);
    return { ...result, rowCount: result.rows.length || (result as { affectedRows?: number }).affectedRows || 0 };
  } } };
}
function fixture(): AppState {
  const state = createEmptyState();
  let root = state.conversations[state.rootId];
  root = { ...root, createdAt, updatedAt: createdAt,
    messages: [{ id: "legacy-prompt", role: "user", content: "Original prompt", createdAt },
      { id: "legacy-answer", role: "assistant", content: "Original generated answer", createdAt: "2026-09-20T12:00:01.000Z" }] };
  root.document = getEditableDocument(root);
  root.document.generations[0].previousBlocks = [{ ...manualBlock(), id: "previous-edited-version", content: "An earlier response with retained user edits." }];
  root = insertDocumentBlock(root, manualBlock(), undefined, createdAt);
  root.notes = [{ id: "block-note", kind: "comment", content: "An annotation", sourceMessageId: "document:authored",
    sourceBlockId: "authored", startOffset: 0, endOffset: 6, quote: "Manual", createdAt, updatedAt: createdAt }];
  const child: Conversation = { ...root, id: "side-chat", title: "Side document", parentId: root.id, childIds: [], notes: [],
    messages: [{ id: "other-chat-answer", role: "assistant", content: "Side answer", createdAt }],
    document: { schemaVersion: 1, blocks: [{ ...manualBlock(), id: "child-block", content: "Editable side document" }], prompts: [], generations: [] },
    branchAnchor: { id: "block-anchor", sourceConversationId: root.id, sourceMessageId: "document:authored", sourceBlockId: "authored",
      startOffset: 0, endOffset: 6, quote: "Manual", prompt: "Discuss the selection", createdAt } };
  root.childIds = [child.id];
  state.conversations = { [root.id]: root, [child.id]: child };
  return state;
}
function manualBlock(): DocumentBlock {
  return { id: "authored", kind: "markdown", content: "Manual authored **paragraph**", createdAt, updatedAt: createdAt };
}

describe("editable document database and local persistence", () => {
  test("migration adds document storage, retains unrelated foreign keys, and round-trips main/side documents and block anchors", async () => {
    const { client, pg } = database();
    const migrations = await loadMigrations();
    await migrateDatabase(client, { migrations: migrations.filter((migration) => migration.id !== "0007_editable_documents") });
    await pg.query("insert into marginchat_users (id,email,password_hash,display_name) values ('docs-user','docs@example.test','hash','Documents')");
    const migration = await migrateDatabase(client, { migrations });
    expect(migration.executed).toEqual(["0007_editable_documents"]);
    const constraints = await pg.query<{ target: string; source: string }>(`select confrelid::regclass::text as target, conrelid::regclass::text as source from pg_constraint
      where contype='f' and conrelid in ('marginchat_branch_anchors'::regclass, 'marginchat_conversation_notes'::regclass)`);
    expect(constraints.rows.some((row) => row.target === "marginchat_messages")).toBe(false);
    expect(constraints.rows.filter((row) => row.target === "marginchat_conversations")).toHaveLength(3);
    const state = fixture();
    await writeState(client, "docs-user", normalizeAppState(state));
    const restored = await readState(client, "docs-user");
    expect(restored.conversations[state.rootId].document).toEqual(state.conversations[state.rootId].document);
    expect(restored.conversations["side-chat"].document).toEqual(state.conversations["side-chat"].document);
    expect(restored.conversations["side-chat"].branchAnchor).toEqual(state.conversations["side-chat"].branchAnchor);
    expect(restored.conversations[state.rootId].notes[0]).toEqual(state.conversations[state.rootId].notes[0]);
    expect(restored.conversations[state.rootId].messages).toEqual(state.conversations[state.rootId].messages);
    const removed = removeDocumentBlock(restored.conversations[state.rootId], "authored", createdAt);
    const next = normalizeAppState({ ...restored, conversations: { ...restored.conversations, [state.rootId]: removed } });
    await writeState(client, "docs-user", next);
    const reopened = await readState(client, "docs-user");
    expect(reopened.conversations[state.rootId].document.blocks.some((block: DocumentBlock) => block.id === "authored")).toBe(false);
    expect(reopened.conversations[state.rootId].messages.find((message: { id: string }) => message.id === "document:authored")?.content).toBe(manualBlock().content);
    expect(reopened.conversations["side-chat"].branchAnchor.sourceBlockId).toBe("authored");
    expect(reopened.conversations[state.rootId].notes[0].sourceBlockId).toBe("authored");
  }, 30_000);

  test("validation only accepts an anchor source from the declared conversation or its exact current block", () => {
    const state = fixture();
    expect(() => normalizeAppState(state)).not.toThrow();
    const unrelated = structuredClone(state);
    unrelated.conversations["side-chat"].branchAnchor!.sourceMessageId = "other-chat-answer";
    expect(() => normalizeAppState(unrelated)).toThrow("missing source message");
    const wrongBlock = structuredClone(state);
    wrongBlock.conversations["side-chat"].branchAnchor!.sourceBlockId = "different";
    expect(() => normalizeAppState(wrongBlock)).toThrow("missing source message");
    const missing = structuredClone(state);
    missing.conversations[state.rootId].document!.blocks = [];
    expect(() => normalizeAppState(missing)).toThrow();
    missing.conversations[state.rootId] = retainDocumentBlockSource(missing.conversations[state.rootId], manualBlock());
    expect(() => normalizeAppState(missing)).not.toThrow();
    const emptyId = structuredClone(state);
    emptyId.conversations["side-chat"].branchAnchor!.sourceBlockId = "";
    expect(() => normalizeAppState(emptyId)).toThrow("sourceBlockId");
  });

  test("local hydration preserves current documents and rejects invalid documents instead of restoring stale history", () => {
    const state = fixture();
    const restored = hydratePersistedState(state)!;
    expect(restored.conversations[state.rootId].document).toEqual(state.conversations[state.rootId].document);
    expect(restored.conversations["side-chat"].branchAnchor!.sourceBlockId).toBe("authored");
    const invalid = structuredClone(state);
    (invalid.conversations[state.rootId].document as any).schemaVersion = 99;
    expect(hydratePersistedState(invalid)).toBeNull();
  });
});
