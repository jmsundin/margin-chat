import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { createEmptyState, createMainConversation, createStandaloneNoteConversation } from "../client/src/initialState";
import { loadMigrations, migrateDatabase } from "../server/db/migrations.mjs";
import { writeState } from "../server/db/repository.mjs";
import { normalizeAppState } from "../server/db/validation.mjs";
import * as passages from "../server/db/passageRepository.mjs";
import * as topics from "../server/db/topicRepository.mjs";
import { createTopicEmbeddingService, TOPIC_EMBEDDING_DIMENSIONS } from "../server/documents/topics.mjs";
import { buildSourcePassages, passageEmbeddingInput } from "../server/vault/passages.mjs";
import { createVaultPassageService, PASSAGE_EMBEDDINGS_OFF } from "../server/vault/passageIndex.mjs";

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
  const database: Record<string, (args: any) => Promise<any>> = {};
  for (const [name, method] of Object.entries(passages)) database[name] = (args: any) => (method as any)(client, args);
  for (const name of ["listStaleTopicSources", "saveTopicEmbeddings", "readTopicEmbeddings"] as const) {
    database[name] = (args: any) => (topics[name] as any)(client, args);
  }
  return { pg, client, database };
}

// Words that mean the same thing share a dimension, so "meaning" can be tested
// without a model: a query about baking finds a note about a loaf.
const SUBJECTS: Record<string, number> = {};
for (const [dimension, words] of [
  ["bake baking bread loaf sourdough yeast flour"],
  ["car cars automobile vehicle sedan driving engine"],
  ["angular component components viewchild template"],
].map((group, index) => [index, group[0].split(" ")] as const)) for (const word of words) SUBJECTS[word] = dimension;

function fakeVector(text: string) {
  const values = new Array(TOPIC_EMBEDDING_DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (word in SUBJECTS) values[SUBJECTS[word]] += 1;
    else values[10 + ([...word].reduce((sum, char) => sum * 31 + char.charCodeAt(0), 7) % 400)] += 0.05;
  }
  const length = Math.hypot(...values) || 1;
  return values.map((value) => value / length);
}

function recordingEmbed() {
  const calls: string[][] = [];
  const embed = async ({ inputs, dimensions }: any) => {
    expect(dimensions).toBe(TOPIC_EMBEDDING_DIMENSIONS);
    calls.push(inputs);
    return inputs.map(fakeVector);
  };
  return { calls, embed };
}

const context = { allowHosted: true, apiKeys: {}, usageMeter: null };

function longGuide(changedTail = "Rotate the tyres every season.") {
  const paragraphs = Array.from({ length: 12 }, (_, index) => `Paragraph ${index + 1} about checking the engine oil and the car battery before a long drive, written out at some length so the guide runs past one passage. Keep a note of the mileage and the date each time, and top up the washer fluid while the bonnet is open.`);
  return [
    "# Car care",
    paragraphs.slice(0, 6).join("\n\n"),
    "## Winter",
    paragraphs.slice(6).join("\n\n"),
    "## Tyres",
    changedTail,
  ];
}

function state({ guideTail, withBread = true }: { guideTail?: string; withBread?: boolean } = {}) {
  const value = createEmptyState();
  const guide = value.conversations[value.rootId];
  Object.assign(guide, { id: "guide", title: "Car guide", createdAt: at, updatedAt: at, messages: [], childIds: [] });
  guide.document = { schemaVersion: 1, prompts: [], generations: [], blocks: longGuide(guideTail).map((content, index) => (
    { id: `g${index}`, kind: "markdown", content, createdAt: at, updatedAt: at })) } as any;
  const conversations: Record<string, any> = { guide };
  if (withBread) {
    const note = createStandaloneNoteConversation({ id: "starter", noteId: "starter-body", createdAt: at });
    note.title = "Starter";
    note.notes![0].content = "Feed the starter with flour and water; the loaf rises overnight.";
    note.notes!.push({ id: "comment", kind: "comment", sourceMessageId: null, startOffset: null, endOffset: null, quote: null,
      content: "Private margin comment about secret sedans", createdAt: at, updatedAt: at } as any);
    conversations.starter = note;
  }
  const chat = createMainConversation({ id: "chat", createdAt: at });
  chat.title = "Trip planning";
  chat.messages = [
    { id: "m1", role: "user", content: "Which route avoids tolls to Portland?", createdAt: at },
    { id: "m2", role: "assistant", content: "Take the coastal highway; it has no tolls.", createdAt: "2026-10-01T10:00:01.000Z" },
  ] as any;
  conversations.chat = chat;
  value.rootId = "guide";
  value.activeConversationId = "guide";
  value.conversations = conversations;
  return value;
}

async function indexAll(service: ReturnType<typeof createVaultPassageService>, extra: Record<string, unknown> = {}) {
  let result: any;
  for (let round = 0; round < 10; round++) {
    result = await service.sync({ userId: "u1", context: { ...context, ...extra } });
    if (!result.more) break;
  }
  return result;
}

describe("splitting documents into passages", () => {
  test("the opening matches the topic embedding's text; later passages start at headings and name them", () => {
    const blocks = longGuide().map((content, index) => ({ id: `g${index}`, content }));
    const body = blocks.map((block) => block.content).join("\n\n");
    const lead = body.slice(0, 2000);
    const result = buildSourcePassages({ title: "Car guide", body, lead, blocks, topicHash: "a".repeat(32) });
    expect(passageEmbeddingInput(result[0])).toBe(`Car guide\n\n${lead}`.trim());
    expect(result[0].topicHash).toBe("a".repeat(32));
    expect(result.slice(1).every((passage) => passage.topicHash === null)).toBe(true);
    expect(result.length).toBeGreaterThan(2);
    const tyres = result.find((passage) => passage.content.includes("Rotate the tyres"))!;
    expect(tyres.heading).toBe("Car care › Tyres");
    expect(tyres.blockId).toBeTruthy();
    // Nothing is lost between passages.
    for (const paragraph of body.split("\n\n")) {
      expect(result.some((passage) => passage.content.includes(paragraph.slice(0, 60)))).toBe(true);
    }
  });

  test("headings inside fenced code are not headings", () => {
    const body = `${"Intro text. ".repeat(200)}\n\n\`\`\`bash\n# not a heading\necho hi\n\`\`\`\n\n${"More text. ".repeat(200)}`;
    const result = buildSourcePassages({ title: "Script", body, lead: body.slice(0, 2000) });
    expect(result.every((passage) => passage.heading === null)).toBe(true);
  });
});

describe("vault passage index", () => {
  test("indexes documents, notes and chats, but never margin comments", async () => {
    const { client, database } = await setup();
    await writeState(client, "u1", normalizeAppState(state()));
    const { calls, embed } = recordingEmbed();
    const service = createVaultPassageService({ database, env: { OPENAI_API_KEY: "test" }, embed });
    const result = await indexAll(service);
    expect(result.passages).toBeGreaterThan(3);
    expect(result.embedded).toBe(result.passages);
    const inputs = calls.flat();
    expect(inputs).toContain("Starter\n\nFeed the starter with flour and water; the loaf rises overnight.");
    expect(inputs).toContain("Trip planning\n\nWhich route avoids tolls to Portland?\n\nTake the coastal highway; it has no tolls.");
    expect(inputs.join("\n")).not.toContain("secret sedans");

    const again = await service.sync({ userId: "u1", context });
    expect(again.more).toBe(false);
    expect(calls).toHaveLength(1);
  }, 30_000);

  test("finds passages by exact word and by meaning, best first", async () => {
    const { client, database } = await setup();
    await writeState(client, "u1", normalizeAppState(state()));
    const { embed } = recordingEmbed();
    const service = createVaultPassageService({ database, env: { OPENAI_API_KEY: "test" }, embed });
    await indexAll(service);

    const exact = await service.search({ userId: "u1", query: "Portland", context });
    expect(exact.results[0]).toMatchObject({ id: "chat", kind: "chat", matched: "both" });

    // No passage contains "baking" or "bread"; the starter note means it.
    const meaning = await service.search({ userId: "u1", query: "baking bread", context });
    expect(meaning.meaning).toBe(true);
    expect(meaning.results[0]).toMatchObject({ id: "starter", kind: "note", matched: "meaning" });

    const tyres = await service.search({ userId: "u1", query: "rotate tyres", context });
    expect(tyres.results[0]).toMatchObject({ id: "guide", kind: "document", heading: "Car care › Tyres" });
    // The passage starts at the section heading's block.
    expect(tyres.results[0].blockId).toBe("g4");

    const limited = await service.search({ userId: "u1", query: "baking bread", context, sourceIds: ["guide"] });
    expect(limited.results.every((result: any) => result.id === "guide")).toBe(true);
  }, 30_000);

  test("an edit re-embeds only the passages whose text changed", async () => {
    const { client, database } = await setup();
    await writeState(client, "u1", normalizeAppState(state()));
    const { calls, embed } = recordingEmbed();
    const service = createVaultPassageService({ database, env: { OPENAI_API_KEY: "test" }, embed });
    const first = await indexAll(service);
    await writeState(client, "u1", normalizeAppState(state({ guideTail: "Check tyre pressure monthly." })));
    const second = await indexAll(service);
    expect(second.passages).toBe(first.passages);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toHaveLength(1);
    expect(calls[1][0]).toContain("Check tyre pressure monthly.");
  }, 30_000);

  test("shares embeddings with the map's topic grouping in both directions", async () => {
    const { client, database } = await setup();
    await writeState(client, "u1", normalizeAppState(state()));
    // Topics first: the passage index reuses those openings.
    const topicEmbed = recordingEmbed();
    const topicService = createTopicEmbeddingService({ database, env: { OPENAI_API_KEY: "test" }, embed: topicEmbed.embed });
    await topicService.sync({ userId: "u1", context, since: null });
    const openings = topicEmbed.calls.flat();
    const passageEmbed = recordingEmbed();
    const service = createVaultPassageService({ database, env: { OPENAI_API_KEY: "test" }, embed: passageEmbed.embed });
    const result = await indexAll(service);
    expect(result.embedded).toBe(result.passages);
    for (const opening of openings) expect(passageEmbed.calls.flat()).not.toContain(opening);

    // Passages first: topics find their openings already embedded.
    const fresh = await setup();
    await writeState(fresh.client, "u1", normalizeAppState(state()));
    const freshService = createVaultPassageService({ database: fresh.database, env: { OPENAI_API_KEY: "test" }, embed: recordingEmbed().embed });
    await indexAll(freshService);
    const laterTopics = createTopicEmbeddingService({ database: fresh.database, env: { OPENAI_API_KEY: "test" }, embed: async () => { throw new Error("must not embed"); } });
    const grouped = await laterTopics.sync({ userId: "u1", context, since: null });
    expect(grouped.pending).toBe(0);
    expect(grouped.embeddings.map((entry: any) => entry.id).sort()).toEqual(["chat", "guide", "starter"]);
  }, 30_000);

  test("with search by meaning off, nothing is sent and stored embeddings are removed", async () => {
    const { client, database } = await setup();
    await writeState(client, "u1", normalizeAppState(state()));
    const { calls, embed } = recordingEmbed();
    const service = createVaultPassageService({ database, env: { OPENAI_API_KEY: "test" }, embed });
    await indexAll(service);
    const off = await service.setCloudEmbeddings({ userId: "u1", enabled: false });
    expect(off).toMatchObject({ cloudEmbeddings: false, embedded: 0 });
    await writeState(client, "u1", normalizeAppState(state({ guideTail: "New text." })));
    const synced = await indexAll(service);
    expect(synced.more).toBe(false);
    expect(calls).toHaveLength(1);
    const result = await service.search({ userId: "u1", query: "Portland trip", context });
    expect(calls).toHaveLength(1);
    expect(result.warning).toBe(PASSAGE_EMBEDDINGS_OFF);
    expect(result.results[0]).toMatchObject({ id: "chat", matched: "keyword" });
  }, 30_000);

  test("without an OpenAI key, passages are still searchable by keyword", async () => {
    const { client, database } = await setup();
    await writeState(client, "u1", normalizeAppState(state()));
    const service = createVaultPassageService({ database, env: {}, embed: async () => { throw new Error("must not embed"); } });
    const result = await indexAll(service, { allowHosted: false });
    expect(result.unavailable).toContain("OpenAI");
    expect(result.more).toBe(false);
    const found = await service.search({ userId: "u1", query: "coastal highway", context: { allowHosted: false, apiKeys: {} } });
    expect(found.results[0]).toMatchObject({ id: "chat", matched: "keyword" });
  }, 30_000);

  test("forgets deleted documents and indexes uploaded files", async () => {
    const { pg, client, database } = await setup();
    await writeState(client, "u1", normalizeAppState(state()));
    await pg.query(`insert into marginchat_documents (id, public_id, user_id, filename, mime_type, size_bytes, original_bytes, status)
      values ('doc-internal', 'document-1', 'u1', 'Recipes.txt', 'text/plain', 40, $1, 'ready')`, [Buffer.from("Knead the dough and bake the loaf at 230C.")]);
    const { embed } = recordingEmbed();
    const service = createVaultPassageService({ database, env: { OPENAI_API_KEY: "test" }, embed });
    await indexAll(service);
    const file = await service.search({ userId: "u1", query: "knead dough", context });
    expect(file.results[0]).toMatchObject({ id: "document-1", sourceKind: "attachment", kind: "file", title: "Recipes.txt" });
    expect((await service.readFile({ userId: "u1", fileId: "document-1" }))?.passages[0].content).toContain("Knead the dough");

    await writeState(client, "u1", normalizeAppState(state({ withBread: false })));
    await indexAll(service);
    const gone = await service.search({ userId: "u1", query: "starter flour", context });
    expect(gone.results.some((result: any) => result.id === "starter")).toBe(false);
  }, 30_000);
});
