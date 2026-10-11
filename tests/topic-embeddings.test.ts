import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";
import { loadMigrations, migrateDatabase } from "../server/db/migrations.mjs";
import { writeState } from "../server/db/repository.mjs";
import { normalizeAppState } from "../server/db/validation.mjs";
import * as topics from "../server/db/topicRepository.mjs";
import { createTopicEmbeddingService, quantizeEmbedding, TOPIC_EMBEDDING_DIMENSIONS } from "../server/documents/topics.mjs";

const at = "2026-10-01T10:00:00.000Z";
const databases: PGlite[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map((database) => database.close())); });

async function setup() {
  const pg = new PGlite({ extensions: { vector } });
  databases.push(pg);
  const client = { async query(sql: string, values?: unknown[]) {
    const result = values === undefined && sql.includes(";") ? (await pg.exec(sql)).at(-1)! : await pg.query(sql, values);
    return { ...result, rowCount: result.rows.length || (result as { affectedRows?: number }).affectedRows || 0 };
  } };
  await migrateDatabase(client, { migrations: await loadMigrations() });
  await pg.query("insert into marginchat_users (id,email,password_hash,display_name) values ('u1','u1@example.test','hash','U1')");
  const database = {
    listStaleTopicSources: (args: any) => topics.listStaleTopicSources(client, args),
    saveTopicEmbeddings: (args: any) => topics.saveTopicEmbeddings(client, args),
    readTopicEmbeddings: (args: any) => topics.readTopicEmbeddings(client, args),
  };
  return { client, database };
}

function state(angularText = "Angular is a TypeScript framework for single-page apps.") {
  const value = createEmptyState();
  const angular = value.conversations[value.rootId];
  Object.assign(angular, { id: "angular", title: "Angular", createdAt: at, updatedAt: at, messages: [], childIds: [] });
  angular.document = { schemaVersion: 1, prompts: [], generations: [], blocks: [
    { id: "b1", kind: "markdown", content: angularText, createdAt: at, updatedAt: at },
    { id: "b2", kind: "markdown", content: "Components, services and the router.", createdAt: at, updatedAt: at },
  ] } as any;
  const note = createStandaloneNoteConversation({ id: "viewchild", noteId: "viewchild-body", createdAt: at });
  note.title = "ViewChild";
  note.notes![0].content = "@ViewChild queries the component template.";
  note.notes!.push({ id: "comment", kind: "comment", sourceMessageId: null, startOffset: null, endOffset: null, quote: null,
    content: "A private margin comment", createdAt: at, updatedAt: at } as any);
  const empty = createStandaloneNoteConversation({ id: "empty", noteId: "empty-body", createdAt: at });
  empty.title = "Untitled document";
  empty.notes![0].content = "";
  value.rootId = "angular";
  value.activeConversationId = "angular";
  value.conversations = { angular, viewchild: note, empty };
  return value;
}

const fakeVector = (text: string) => Array.from({ length: TOPIC_EMBEDDING_DIMENSIONS }, (_, index) => Math.sin(index + text.length));

describe("topic embeddings", () => {
  test("embeds each document's title and AI-readable text once, and again only after it changes", async () => {
    const { client, database } = await setup();
    await writeState(client, "u1", normalizeAppState(state()));
    const inputs: string[][] = [];
    const service = createTopicEmbeddingService({ database, env: { OPENAI_API_KEY: "test" }, embed: async ({ inputs: batch, dimensions }: any) => {
      expect(dimensions).toBe(TOPIC_EMBEDDING_DIMENSIONS);
      inputs.push(batch);
      return batch.map(fakeVector);
    } });
    const context = { allowHosted: true, apiKeys: {}, usageMeter: null };
    const first = await service.sync({ userId: "u1", context, since: null });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toEqual([
      "Angular\n\nAngular is a TypeScript framework for single-page apps.\n\nComponents, services and the router.",
      "ViewChild\n\n@ViewChild queries the component template.",
    ]);
    expect(first.pending).toBe(0);
    expect(first.embeddings.map((entry: any) => entry.id).sort()).toEqual(["angular", "viewchild"]);
    expect(Buffer.from(first.embeddings[0].embedding, "base64")).toHaveLength(TOPIC_EMBEDDING_DIMENSIONS);

    const again = await service.sync({ userId: "u1", context, since: first.cursor });
    expect(inputs).toHaveLength(1);
    expect(again.embeddings).toEqual([]);

    await writeState(client, "u1", normalizeAppState(state("Angular, now with signals.")));
    const changed = await service.sync({ userId: "u1", context, since: first.cursor });
    expect(inputs[1]).toEqual(["Angular\n\nAngular, now with signals.\n\nComponents, services and the router."]);
    expect(changed.embeddings.map((entry: any) => entry.id)).toEqual(["angular"]);
  });

  test("without an OpenAI key, returns what is stored and says why nothing new was embedded", async () => {
    const { client, database } = await setup();
    await writeState(client, "u1", normalizeAppState(state()));
    const service = createTopicEmbeddingService({ database, env: {}, embed: async () => { throw new Error("must not embed"); } });
    const result = await service.sync({ userId: "u1", context: { allowHosted: false, apiKeys: {} }, since: null });
    expect(result.embeddings).toEqual([]);
    expect(result.pending).toBe(2);
    expect(result.unavailable).toContain("OpenAI");
  });

  test("drops embeddings of deleted documents", async () => {
    const { client, database } = await setup();
    await writeState(client, "u1", normalizeAppState(state()));
    const service = createTopicEmbeddingService({ database, env: { OPENAI_API_KEY: "test" }, embed: async ({ inputs }: any) => inputs.map(fakeVector) });
    await service.sync({ userId: "u1", context: { allowHosted: true, apiKeys: {} }, since: null });
    const smaller = state();
    delete smaller.conversations.viewchild;
    await writeState(client, "u1", normalizeAppState(smaller));
    const result = await service.sync({ userId: "u1", context: { allowHosted: true, apiKeys: {} }, since: null });
    expect(result.embeddings.map((entry: any) => entry.id)).toEqual(["angular"]);
  });

  test("quantizing keeps the direction of a vector", () => {
    const values = [0.5, -0.25, 0.1, 0];
    expect([...new Int8Array(Buffer.from(quantizeEmbedding(values), "base64"))]).toEqual([127, -63, 25, 0]);
  });
});
