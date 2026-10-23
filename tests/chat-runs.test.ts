import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { loadMigrations, migrateDatabase } from "../server/db/migrations.mjs";
import { cancelChatRun, readChatRun, saveChatRun } from "../server/db/chatRunRepository.mjs";
import { createChatRunService } from "../server/chat/runs.mjs";
import { handleChatRequest } from "../server/routes/chat.mjs";
import { ApiError, requestChatReply } from "../client/src/lib/api";
import { pickUpChatRun, type ChatRunSnapshot, type ShownReply } from "../client/src/lib/chatStream";

const RUN = "0b6f3c1e-2a4d-4f5b-9c8e-7d6a5b4c3d2e";
const metadata = { model: "test-model", requestedServiceId: "openai-api", resolvedServiceId: "openai-api" };
let database: { saveChatRun: (args: any) => Promise<any>; readChatRun: (args: any) => Promise<any>; cancelChatRun: (args: any) => Promise<any> };
let runCounter = 0;
const nextRunId = () => `${RUN.slice(0, -4)}${String(++runCounter).padStart(4, "0")}`;

beforeAll(async () => {
  const pg = new PGlite({ extensions: { vector } });
  const client = {
    async query(sql: string, params?: unknown[]) {
      const result = params === undefined && sql.includes(";") ? (await pg.exec(sql)).at(-1) ?? { rows: [] } : await pg.query(sql, params);
      return { ...result, rowCount: result.rows.length || (result as any).affectedRows || 0 };
    },
  };
  await migrateDatabase(client, { migrations: await loadMigrations() });
  await client.query("insert into marginchat_users (id, email, password_hash, display_name) values ('u1', 'u1@example.com', 'x', 'One'), ('u2', 'u2@example.com', 'x', 'Two')");
  database = {
    saveChatRun: (args) => saveChatRun(client, args),
    readChatRun: (args) => readChatRun(client, args),
    cancelChatRun: (args) => cancelChatRun(client, args),
  };
});

describe("saved replies", () => {
  test("a stopped reply stays stopped and belongs only to its account", async () => {
    const id = nextRunId();
    expect(await database.saveChatRun({ id, userId: "u1", reply: "Hel" })).toBe("running");
    expect(await database.readChatRun({ id, userId: "u2" })).toBeNull();
    await database.cancelChatRun({ id, userId: "u2" });
    expect((await database.readChatRun({ id, userId: "u1" })).status).toBe("running");
    await database.cancelChatRun({ id, userId: "u1" });
    expect(await database.saveChatRun({ id, userId: "u1", status: "complete", reply: "Hello" })).toBe("cancelled");
    expect(await database.readChatRun({ id, userId: "u1" })).toMatchObject({ status: "cancelled", reply: "Hel" });
  });

  test("Stop before the server saved anything still stops the reply", async () => {
    const id = nextRunId();
    await database.cancelChatRun({ id, userId: "u1" });
    expect(await database.saveChatRun({ id, userId: "u1", reply: "Hi" })).toBe("cancelled");
  });

  test("a finished reply keeps its text, metadata and saved pages", async () => {
    const id = nextRunId();
    const documents = [{ url: "https://example.com/", parentUrl: null, title: "Example", markdown: "# Example" }];
    expect(await database.saveChatRun({ id, userId: "u1", status: "complete", reply: "Done", metadata, documents })).toBe("complete");
    expect(await database.readChatRun({ id, userId: "u1" })).toMatchObject({ status: "complete", reply: "Done", metadata, documents });
    expect(await database.saveChatRun({ id, userId: "u1", reply: "Again" })).toBe("complete");
  });
});

function fakeConnection(runId: string) {
  const request = Object.assign(Readable.from([Buffer.from("{}")]), { headers: { "x-margin-chat-run": runId } });
  const writes: any[] = [];
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    headersSent: false,
    writeHead() { this.headersSent = true; },
    write(value: string) { writes.push(JSON.parse(value)); },
    end() { this.writableEnded = true; },
  });
  return { request, response, writes };
}

describe("a reply outlives its connection", () => {
  test("the server keeps writing after the phone disconnects and saves the whole reply", async () => {
    const id = nextRunId();
    const chatRuns = createChatRunService({ database, saveEveryMs: 5 });
    const { request, response, writes } = fakeConnection(id);
    let finishedSignal: AbortSignal | undefined;
    await handleChatRequest({ request, response, user: { id: "u1" }, chatRuns, executeChatReply: async ({ signal, handlers }: any) => {
      await handlers.onReady(metadata);
      await handlers.onDelta("Hello ");
      response.emit("close");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await handlers.onRetract();
      await handlers.onDelta("Hello ");
      await handlers.onDelta("world");
      await handlers.onDocuments([{ url: "https://example.com/", parentUrl: null, title: "Example", markdown: "x" }]);
      finishedSignal = signal;
      return { metadata: { ...metadata, model: "final" }, reply: "Hello world" };
    } });
    expect(finishedSignal?.aborted).toBe(false);
    expect(writes.map((event) => event.type)).toEqual(["metadata", "delta"]);
    expect(await database.readChatRun({ id, userId: "u1" })).toMatchObject({
      status: "complete", reply: "Hello world", metadata: { model: "final" }, documents: [{ title: "Example" }],
    });
  });

  test("Stop reaches a reply that is still being written", async () => {
    const id = nextRunId();
    const chatRuns = createChatRunService({ database, saveEveryMs: 5 });
    const { request, response } = fakeConnection(id);
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    const handled = handleChatRequest({ request, response, user: { id: "u1" }, chatRuns, executeChatReply: async ({ signal, handlers }: any) => {
      await handlers.onReady(metadata);
      await handlers.onDelta("Partial");
      resolveStarted();
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    } });
    await started;
    await chatRuns.cancel({ id, userId: "u1" });
    await handled;
    expect((await database.readChatRun({ id, userId: "u1" })).status).toBe("cancelled");
  });

  test("a failure while disconnected is saved for the browser to show", async () => {
    const id = nextRunId();
    const chatRuns = createChatRunService({ database, saveEveryMs: 5 });
    const { request, response } = fakeConnection(id);
    await handleChatRequest({ request, response, user: { id: "u1" }, chatRuns, executeChatReply: async ({ handlers }: any) => {
      await handlers.onReady(metadata);
      response.emit("close");
      throw Object.assign(new Error("Out of credit."), { statusCode: 402 });
    } });
    expect(await database.readChatRun({ id, userId: "u1" })).toMatchObject({ status: "failed", error: "Out of credit.", statusCode: 402 });
  });
});

const snapshot = (fields: Partial<ChatRunSnapshot>): ChatRunSnapshot => ({
  status: "running", reply: "", metadata, documents: [], error: null, statusCode: null, ...fields,
});

describe("picking up a reply", () => {
  const noWait = async () => {};

  test("continues from the text already shown, without repeating it", async () => {
    const runs = [null, snapshot({ reply: "Hel" }), snapshot({ reply: "Hello wor" }), snapshot({ status: "complete", reply: "Hello world" })];
    const deltas: string[] = [];
    const shown: ShownReply = { reply: "Hello", documents: 0, metadata };
    const result = await pickUpChatRun({ readRun: async () => runs.shift() ?? null, shown, failure: new Error("lost"), deadline: Infinity,
      onDelta: (delta) => deltas.push(delta), wait: noWait });
    expect(deltas).toEqual([" wor", "ld"]);
    expect(result.reply).toBe("Hello world");
  });

  test("an agent that withdrew its text replaces what was shown", async () => {
    const events: string[] = [];
    const shown: ShownReply = { reply: "Let me look", documents: 0, metadata };
    await pickUpChatRun({ readRun: async () => snapshot({ status: "complete", reply: "Found it.",
      documents: [{ url: "https://example.com/", parentUrl: null, title: "Example", markdown: "x" }] }),
    shown, failure: new Error("lost"), deadline: Infinity, wait: noWait,
    onDelta: (delta) => events.push(`delta:${delta}`), onAgentEvent: (event) => events.push(event.type) });
    expect(events).toEqual(["retract", "delta:Found it.", "documents"]);
  });

  test("keeps trying while offline, and gives up on a reply the server never saw", async () => {
    let calls = 0;
    const result = await pickUpChatRun({ readRun: async () => {
      if (++calls < 3) throw new TypeError("Load failed");
      return snapshot({ status: "complete", reply: "Hi" });
    }, shown: { reply: "", documents: 0, metadata: null }, failure: new Error("lost"), deadline: Infinity, wait: noWait });
    expect(result).toMatchObject({ reply: "Hi", metadata });

    const lost = new TypeError("Load failed");
    await expect(pickUpChatRun({ readRun: async () => null, shown: { reply: "", documents: 0, metadata: null },
      failure: lost, deadline: Infinity, wait: noWait })).rejects.toBe(lost);
  });

  test("shows a failure the server saved", async () => {
    await expect(pickUpChatRun({ readRun: async () => snapshot({ status: "failed", error: "Out of credit.", statusCode: 402 }),
      shown: { reply: "", documents: 0, metadata: null }, failure: new Error("lost"), deadline: Infinity, wait: noWait }))
      .rejects.toMatchObject({ statusCode: 402, message: "Out of credit." });
  });
});

describe("the browser side", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });
  const args = () => ({
    conversation: { ancestorContext: [], branchAnchor: null, documents: [], id: "c1", parentId: null, title: "Test" },
    messages: [{ content: "Hi", createdAt: new Date().toISOString(), id: "m1", role: "user" as const }],
    modelId: "gpt-5.6", serviceId: "openai-api" as const,
  });

  test("a stream cut while the phone was away finishes from the saved reply", async () => {
    const calls: { url: string; method: string; run: string | null }[] = [];
    const reads = [snapshot({ reply: "Hello wor" }), snapshot({ status: "complete", reply: "Hello world" })];
    globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
      calls.push({ url: String(input), method: init.method ?? "GET", run: new Headers(init.headers).get("X-Margin-Chat-Run") });
      if (String(input) === "/api/chat") {
        let sent = false;
        return new Response(new ReadableStream({
          pull(controller) {
            if (sent) { controller.error(new TypeError("Load failed")); return; }
            sent = true;
            controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ metadata, type: "metadata" })}\n${JSON.stringify({ delta: "Hello ", type: "delta" })}\n`));
          },
        }), { headers: { "Content-Type": "application/x-ndjson" } });
      }
      return Response.json({ run: reads.shift() });
    }) as typeof fetch;
    const deltas: string[] = [];
    const result = await requestChatReply({ ...args(), onDelta: (delta) => deltas.push(delta) });
    expect(result.reply).toBe("Hello world");
    expect(deltas).toEqual(["Hello ", "wor", "ld"]);
    const runId = calls[0].run;
    expect(runId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(calls.slice(1).map((call) => call.url)).toEqual([`/api/chat/runs/${runId}`, `/api/chat/runs/${runId}`]);
  });

  test("a failure the server reported is not picked up again", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string) => {
      urls.push(String(input));
      return new Response(`${JSON.stringify({ type: "error", error: "Out of credit.", statusCode: 402 })}\n`, { headers: { "Content-Type": "application/x-ndjson" } });
    }) as typeof fetch;
    await expect(requestChatReply(args())).rejects.toBeInstanceOf(ApiError);
    expect(urls).toEqual(["/api/chat"]);
  });

  test("Stop tells the server to stop writing the reply", async () => {
    const calls: { url: string; method: string }[] = [];
    const controller = new AbortController();
    globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
      calls.push({ url: String(input), method: init.method ?? "GET" });
      if (String(input) !== "/api/chat") return Response.json({ ok: true });
      return new Response(new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode(`${JSON.stringify({ metadata, type: "metadata" })}\n`));
          init.signal?.addEventListener("abort", () => stream.error(init.signal?.reason));
        },
      }), { headers: { "Content-Type": "application/x-ndjson" } });
    }) as typeof fetch;
    const pending = requestChatReply({ ...args(), signal: controller.signal, onMetadata: () => controller.abort() });
    await expect(pending).rejects.toBeDefined();
    expect(calls.map((call) => call.method)).toEqual(["POST", "DELETE"]);
    expect(calls[1].url).toMatch(/^\/api\/chat\/runs\/[0-9a-f-]{36}$/u);
  });
});
