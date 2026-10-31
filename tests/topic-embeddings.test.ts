import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";
import { loadMigrations, migrateDatabase } from "../server/db/migrations.mjs";
import { writeState } from "../server/db/repository.mjs";
import { normalizeAppState } from "../server/db/validation.mjs";
import * as topics from "../server/db/topicRepository.mjs";
import { createTopicEmbeddingService, quantizeEmbedding, TOPIC_EMBEDDING_DIMENSIONS } from "../server/documents/topics.mjs";
import { createLandscapeService } from "../server/documents/landscape.mjs";

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
    readTopicPlacements: (args: any) => topics.readTopicPlacements(client, args),
    writeTopicPlacement: (args: any) => topics.writeTopicPlacement(client, args),
    listUnneighbouredTopicDocuments: (args: any) => topics.listUnneighbouredTopicDocuments(client, args),
    refreshTopicNeighbours: (args: any) => topics.refreshTopicNeighbours(client, args),
    readTopicNeighbours: (args: any) => topics.readTopicNeighbours(client, args),
    readLandscape: (args: any) => topics.readLandscape(client, args),
    writeLandscape: (args: any) => topics.writeLandscape(client, args),
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

  test("remembers documents the user moved to another cluster, and forgets them on request", async () => {
    const { client, database } = await setup();
    await writeState(client, "u1", normalizeAppState(state()));
    const service = createTopicEmbeddingService({ database, env: {}, embed: async () => [] });
    const context = { allowHosted: false, apiKeys: {} };
    await service.place({ userId: "u1", id: "viewchild", anchorId: "angular" });
    expect((await service.sync({ userId: "u1", context, since: null })).placements).toEqual([{ id: "viewchild", anchorId: "angular" }]);
    await expect(service.place({ userId: "u1", id: "viewchild", anchorId: "viewchild" })).rejects.toThrow();
    await service.place({ userId: "u1", id: "viewchild", anchorId: null });
    expect((await service.sync({ userId: "u1", context, since: null })).placements).toEqual([]);
  });

  test("keeps each document's nearest documents by meaning, both ways, and sends only changed lists", async () => {
    const { client, database } = await setup();
    const value = state();
    for (let index = 0; index < 4; index++) {
      const note = createStandaloneNoteConversation({ id: `react-${index}`, noteId: `react-${index}-body`, createdAt: at });
      note.title = `React ${index}`;
      note.notes![0].content = `React hooks note ${index}`;
      value.conversations[note.id] = note;
    }
    await writeState(client, "u1", normalizeAppState(value));
    // Angular and ViewChild point one way, the React notes another.
    const direction = (text: string) => Array.from({ length: TOPIC_EMBEDDING_DIMENSIONS }, (_, index) =>
      (text.startsWith("React") ? Math.cos(index) : Math.sin(index)) + (text.length % 7) * 0.01 * Math.sin(index * 3));
    const service = createTopicEmbeddingService({ database, env: { OPENAI_API_KEY: "test" }, embed: async ({ inputs }: any) => inputs.map(direction) });
    const context = { allowHosted: true, apiKeys: {}, usageMeter: null };
    const first = await service.sync({ userId: "u1", context, since: null });
    expect(first.neighbours.map((entry: any) => entry.id).sort()).toEqual(["angular", "react-0", "react-1", "react-2", "react-3", "viewchild"]);
    const angular = first.neighbours.find((entry: any) => entry.id === "angular")!;
    expect(angular.neighbours[0].id).toBe("viewchild");
    expect(angular.neighbours[0].similarity).toBeGreaterThan(angular.neighbours[1].similarity);
    expect(angular.neighbours.every((entry: any) => entry.id !== "angular")).toBe(true);
    // Nothing changed: no lists come back, and the cursor holds.
    const again = await service.sync({ userId: "u1", context, since: first.cursor });
    expect(again.neighbours).toEqual([]);
    expect(again.cursor).toBe(first.cursor);
    // A new React note lands in the lists of the notes it is near, not only its own.
    const more = state();
    Object.assign(more.conversations, value.conversations);
    const note = createStandaloneNoteConversation({ id: "react-9", noteId: "react-9-body", createdAt: at });
    note.title = "React 9"; note.notes![0].content = "React suspense";
    more.conversations["react-9"] = note;
    await writeState(client, "u1", normalizeAppState(more));
    const changed = await service.sync({ userId: "u1", context, since: first.cursor });
    expect(changed.embeddings.map((entry: any) => entry.id)).toEqual(["react-9"]);
    const changedIds = changed.neighbours.map((entry: any) => entry.id);
    expect(changedIds).toContain("react-9");
    expect(changedIds).toContain("react-0");
    expect(changed.neighbours.find((entry: any) => entry.id === "react-0")!.neighbours.some((entry: any) => entry.id === "react-9")).toBe(true);
    // Lists never outgrow the limit.
    for (const entry of changed.neighbours) expect(entry.neighbours.length).toBeLessThanOrEqual(topics.TOPIC_NEIGHBOURS_PER_DOCUMENT);
  });

  test("documents embedded before neighbours were kept get theirs on the next sync", async () => {
    const { client, database } = await setup();
    await writeState(client, "u1", normalizeAppState(state()));
    const service = createTopicEmbeddingService({ database, env: { OPENAI_API_KEY: "test" }, embed: async ({ inputs }: any) => inputs.map(fakeVector) });
    const context = { allowHosted: true, apiKeys: {}, usageMeter: null };
    await service.sync({ userId: "u1", context, since: null });
    await client.query("delete from marginchat_topic_neighbours");
    const result = await service.sync({ userId: "u1", context, since: null });
    expect(result.neighbours.map((entry: any) => entry.id).sort()).toEqual(["angular", "viewchild"]);
    expect(result.pending).toBe(0);
  });

  test("the landscape is laid out from stored neighbours, stored, and read back", async () => {
    const { client, database } = await setup();
    const value = state();
    for (let index = 0; index < 4; index++) {
      const note = createStandaloneNoteConversation({ id: `react-${index}`, noteId: `react-${index}-body`, createdAt: at });
      note.title = `React ${index}`;
      note.notes![0].content = `React hooks note ${index}`;
      value.conversations[note.id] = note;
    }
    await writeState(client, "u1", normalizeAppState(value));
    const direction = (text: string) => Array.from({ length: TOPIC_EMBEDDING_DIMENSIONS }, (_, index) =>
      (text.startsWith("React") ? Math.cos(index) : Math.sin(index)) + (text.length % 7) * 0.01 * Math.sin(index * 3));
    const service = createTopicEmbeddingService({ database, env: { OPENAI_API_KEY: "test" }, embed: async ({ inputs }: any) => inputs.map(direction) });
    await service.sync({ userId: "u1", context: { allowHosted: true, apiKeys: {}, usageMeter: null }, since: null });
    const landscape = createLandscapeService({ database });
    expect((await landscape.read({ userId: "u1" })).stale).toBe(true);
    const laid = await landscape.relayout({ userId: "u1" });
    expect(laid.positions.map((entry: any) => entry.id).sort()).toEqual(["angular", "react-0", "react-1", "react-2", "react-3", "viewchild"]);
    expect(laid.computedAt).not.toBeNull();
    expect(laid.stale).toBe(false);
    const stored = await topics.readLandscape(client, { userId: "u1" });
    expect(stored.positions).toEqual([...laid.positions].sort((a: any, b: any) => (a.id < b.id ? -1 : 1)));
  });

  test("quantizing keeps the direction of a vector", () => {
    const values = [0.5, -0.25, 0.1, 0];
    expect([...new Int8Array(Buffer.from(quantizeEmbedding(values), "base64"))]).toEqual([127, -63, 25, 0]);
  });
});
