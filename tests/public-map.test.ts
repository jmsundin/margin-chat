import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { loadMigrations, migrateDatabase } from "../server/db/migrations.mjs";
import * as repository from "../server/db/publicMapRepository.mjs";
import { createPublicMapService, validateGeneratedAnswer } from "../server/publicMap/index.mjs";
import { createApiHandler } from "../server/routes/api.mjs";
import { isPublicAnswer } from "../client/src/lib/publicMapApi";
import { appendPublicAnswerTopics, appendPublicGraphExpansion, emptyPublicGraph, addPublicGraphRoot, visiblePublicGraph } from "../client/src/lib/publicGraphScene";

const topic = { id: "Q7150", label: "Ecology", description: "Study of organisms and their environment" };
const member = { id: "member", displayName: "Member", role: "member", billing: { hasAccess: true } };
const reader = { id: "reader", displayName: "Reader", role: "member", billing: { hasAccess: false } };
const admin = { id: "admin", displayName: "Admin", role: "admin", billing: { hasAccess: false } };
const reply = (related = [{ label: "Ecosystem", relation: "studies" }, { label: "Unknown thing", relation: "mentions" }, { label: "Ecology", relation: "is" }]) =>
  JSON.stringify({ answer: "Ecology studies how living things interact.\n\nIt spans many scales.", related });
const resolved: Record<string, { id: string; label: string; description: string }> = {
  Ecosystem: { id: "Q37813", label: "ecosystem", description: "community of living organisms" },
};

async function createDatabase() {
  const pg = new PGlite({ extensions: { vector } });
  const client = {
    async query(sql: string, params?: unknown[]) {
      const result = params === undefined && sql.includes(";") ? (await pg.exec(sql)).at(-1) ?? { rows: [] } : await pg.query(sql, params);
      return { ...result, rowCount: result.rows.length || (result as any).affectedRows || 0 };
    },
  };
  await migrateDatabase(client, { migrations: await loadMigrations() });
  for (const user of [member, reader, admin]) {
    await client.query("insert into marginchat_users (id, email, password_hash, display_name, role) values ($1, $2, 'x', $3, $4)", [user.id, `${user.id}@example.com`, user.displayName, user.role]);
  }
  const database = Object.fromEntries(Object.entries(repository).map(([name, operation]) => [name, (args: any) => (operation as any)(client, args)]));
  return { client, database: database as any };
}

function createService(database: any, calls: any[] = [], output = reply()) {
  return createPublicMapService({
    database,
    executeChatReply: async (args: any) => { calls.push(args); return { reply: output }; },
    resolveTopic: async (label: string) => resolved[label] ?? (label === "Ecology" ? { id: topic.id, label: "ecology", description: "" } : null),
  });
}

describe("public map storage and shared answers", () => {
  test("saves each member's map to their account and bumps its revision", async () => {
    const { database } = await createDatabase();
    const service = createService(database);
    expect(await service.readState(member)).toEqual({ state: null, revision: 0, updatedAt: null });
    const state = { version: 1, graph: { topics: {}, roots: [], positions: {}, expansions: {} } };
    expect((await service.writeState(member, { state })).revision).toBe(1);
    expect((await service.writeState(member, { state: { ...state, selectedId: null } })).revision).toBe(2);
    expect((await service.readState(member)).state).toEqual({ ...state, selectedId: null });
    expect((await service.readState(reader)).state).toBeNull();
    await expect(service.writeState(member, { state: { version: 2, graph: {} } })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.writeState(member, { state: { ...state, padding: "x".repeat(600_001) } })).rejects.toMatchObject({ statusCode: 413 });
  }, 30_000);

  test("paying members and admins can ask; everyone reads the shared answer", async () => {
    const { database } = await createDatabase();
    const calls: any[] = [], progress: string[] = [];
    const service = createService(database, calls);
    const answer = await service.ask({ user: member, payload: { topic, question: "What does ecology study?", ai: { mode: "fast", contextScope: "workspace", selectedConversationIds: ["private"] } }, onProgress: (message: string) => progress.push(message) });
    expect(answer).toMatchObject({ topicId: "Q7150", question: "What does ecology study?", mine: true,
      related: [{ id: "Q37813", label: "ecosystem", description: "community of living organisms", relation: "studies" }] });
    expect(isPublicAnswer(answer)).toBe(true);
    expect(answer).not.toHaveProperty("authorId");
    expect(calls[0].operation).toBe("public-map-question");
    expect(calls[0].payload.ai).toMatchObject({ contextScope: "conversation", selectedConversationIds: [] });
    expect(progress.length).toBe(2);

    const seenByReader = await service.listAnswers(reader, { topicIds: ["Q7150"] });
    expect(seenByReader.answers).toHaveLength(1);
    expect(seenByReader.answers[0]).toMatchObject({ id: answer.id, mine: false });
    expect(JSON.stringify(seenByReader)).not.toContain("Member");
    expect((await service.listAnswers(reader)).answers).toHaveLength(1);
    expect((await service.listAnswers(reader, { topicIds: ["Q1"] })).answers).toHaveLength(0);

    await expect(service.ask({ user: reader, payload: { topic, question: "Why?" } })).rejects.toMatchObject({ statusCode: 402 });
    expect(calls).toHaveLength(1);
    await service.ask({ user: admin, payload: { topic, question: "Who founded ecology?" } });
    expect((await service.listAnswers(reader, { topicIds: ["Q7150"] })).answers.map((item: any) => item.question)).toEqual(["Who founded ecology?", "What does ecology study?"]);
  }, 30_000);

  test("only the author or an admin can delete a shared answer", async () => {
    const { database } = await createDatabase();
    const service = createService(database);
    const first = await service.ask({ user: member, payload: { topic, question: "First question?" } });
    const second = await service.ask({ user: member, payload: { topic, question: "Second question?" } });
    await expect(service.deleteAnswer(reader, first.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(await service.deleteAnswer(member, first.id)).toEqual({ ok: true });
    expect(await service.deleteAnswer(admin, second.id)).toEqual({ ok: true });
    expect((await service.listAnswers(reader)).answers).toHaveLength(0);
  }, 30_000);

  test("rejects bad questions and unsafe answers without saving anything", async () => {
    const { database } = await createDatabase();
    const calls: any[] = [];
    const service = createService(database, calls);
    for (const payload of [
      { topic: { ...topic, id: "P31" }, question: "What is it?" },
      { topic, question: "no" },
      { topic, question: "x".repeat(501) },
      { topic: { ...topic, label: "" }, question: "What is it?" },
    ]) await expect(service.ask({ user: member, payload })).rejects.toMatchObject({ statusCode: 400 });
    expect(calls).toHaveLength(0);
    const unsafe = createService(database, [], JSON.stringify({ answer: "Read https://example.com for more.", related: [] }));
    await expect(unsafe.ask({ user: member, payload: { topic, question: "Where can I read more?" } })).rejects.toMatchObject({ statusCode: 502 });
    expect((await service.listAnswers(member)).answers).toHaveLength(0);
    expect(() => validateGeneratedAnswer(JSON.stringify({ answer: "ok", related: Array(7).fill({ label: "a", relation: "b" }) }))).toThrow();
    expect(validateGeneratedAnswer("```json\n" + reply([{ label: "Ecosystem", relation: "" }]) + "\n```", { topic }).related).toEqual([{ label: "Ecosystem", relation: "related to" }]);
  }, 30_000);
});

describe("public map routes", () => {
  let server: Server, origin = "";
  const headers = { "Content-Type": "application/json", "X-Test-User": "member", "X-Margin-Vault-User": "member" };
  beforeAll(async () => {
    const { database } = await createDatabase();
    const users: Record<string, any> = { member, reader };
    server = createServer(createApiHandler({
      runtimeConfig: { host: "127.0.0.1", port: 0 },
      authService: { getAuthContext: async (request: any) => ({ user: users[request.headers["x-test-user"]] ?? null }) },
      publicMapService: createService(database),
    } as any));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as any).port}`;
  }, 30_000);
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

  test("streams a saved answer, then lists it for another member", async () => {
    const response = await fetch(`${origin}/api/public-map/ask`, { method: "POST", headers, body: JSON.stringify({ topic, question: "What does ecology study?" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({ type: "done", answer: { topicId: "Q7150", mine: true } });
    const listed = await fetch(`${origin}/api/public-map/answers?topic=Q7150`, { headers: { "X-Test-User": "reader" } });
    expect((await listed.json()).answers[0]).toMatchObject({ question: "What does ecology study?", mine: false });
  });

  test("refuses free members, stale accounts, cross-site writes and signed-out readers", async () => {
    const ask = (overrides: Record<string, string>) => fetch(`${origin}/api/public-map/ask`, { method: "POST", headers: { ...headers, ...overrides }, body: JSON.stringify({ topic, question: "Why?" }) });
    expect((await ask({ "X-Test-User": "reader", "X-Margin-Vault-User": "reader" })).status).toBe(402);
    expect((await ask({ "X-Margin-Vault-User": "reader" })).status).toBe(409);
    expect((await ask({ "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await fetch(`${origin}/api/public-map/answers`)).status).toBe(401);
  });

  test("saves and reads the member's map", async () => {
    const state = { version: 1, graph: { topics: {}, roots: [], positions: {}, expansions: {} } };
    const saved = await fetch(`${origin}/api/public-map/state`, { method: "PUT", headers, body: JSON.stringify({ state }) });
    expect(saved.status).toBe(200);
    const read = await fetch(`${origin}/api/public-map/state`, { headers });
    expect((await read.json()).state).toEqual(state);
  });
});

describe("answer topics on the map", () => {
  const ecology = { ...topic, aliases: [], wikidataUrl: "https://www.wikidata.org/wiki/Q7150", retrievedAt: "2026-10-09T00:00:00.000Z" };
  const answer = { topicId: "Q7150", createdAt: "2026-10-09T00:00:00.000Z", related: [{ id: "Q37813", label: "ecosystem", description: "", relation: "studies" }] };

  test("connects answer topics without marking Wikidata's statements loaded", () => {
    const graph = appendPublicAnswerTopics(addPublicGraphRoot(emptyPublicGraph(), ecology), [answer]);
    expect(visiblePublicGraph(graph).topics.map((item) => item.id)).toEqual(["Q7150", "Q37813"]);
    expect(graph.expansions.Q7150).toMatchObject({ hasMore: true, nextOffset: 0, visible: true });
    expect(graph.expansions.Q7150.relations[0]).toMatchObject({ sourceId: "Q7150", targetId: "Q37813", label: "studies", propertyId: "AI" });
    // A later Wikidata page keeps the answer's connection.
    const expanded = appendPublicGraphExpansion(graph, { topic: ecology, topics: [], relations: [], hasMore: false, nextOffset: 10 });
    expect(expanded.expansions.Q7150.relations).toHaveLength(1);
    expect(appendPublicAnswerTopics(expanded, [answer]).expansions.Q7150).toMatchObject({ hasMore: false, nextOffset: 10 });
    expect(visiblePublicGraph(appendPublicAnswerTopics(addPublicGraphRoot(emptyPublicGraph(), ecology), [answer], 1)).topics).toHaveLength(1);
  });
});
