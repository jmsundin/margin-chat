import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { unzipSync, strFromU8 } from "fflate";
import { buildAccountExport } from "../server/account/accountExport.mjs";
import { createAuthService } from "../server/auth/index.mjs";
import { hashPassword } from "../server/auth/passwords.mjs";
import { createRuntimeConfig } from "../server/config/runtime.mjs";
import * as flashcards from "../server/db/flashcardRepository.mjs";
import * as languageTerms from "../server/db/languageTermRepository.mjs";
import * as interfaceSettings from "../server/db/interfaceSettingsRepository.mjs";
import { createApiHandler } from "../server/routes/api.mjs";
import { ACCOUNT_EXPORT_FILE, exportVault, importVault } from "../client/src/lib/vaultLocal";
import { createCaptureTestDatabase } from "./helpers/captureDatabase.mjs";

const password = "export-password-123";
const at = (minute: number) => new Date(Date.UTC(2026, 10, 15, 12, minute)).toISOString();

describe("account export", () => {
  let fixture: Awaited<ReturnType<typeof createCaptureTestDatabase>>;
  let database: any;
  let handler: ReturnType<typeof createApiHandler>;

  beforeAll(async () => {
    fixture = await createCaptureTestDatabase();
    // The real queries for the data that lives only in Postgres.
    const bind = (operation: (client: any, args: any) => any) => (args: any) => operation(fixture.client, args);
    database = {
      ...fixture.database,
      saveFlashcardChanges: bind(flashcards.saveFlashcardChanges),
      readFlashcardChanges: bind(flashcards.readFlashcardChanges),
      saveLanguageTerms: bind(languageTerms.saveLanguageTerms),
      readLanguageTerms: bind(languageTerms.readLanguageTerms),
      saveInterfaceSettings: bind(interfaceSettings.saveInterfaceSettings),
      readInterfaceSettings: bind(interfaceSettings.readInterfaceSettings),
    };
    const runtimeConfig = createRuntimeConfig({});
    handler = createApiHandler({ database, authService: createAuthService({ database, runtimeConfig, env: {} }), runtimeConfig } as any);
  }, 30_000);
  afterAll(async () => { await fixture?.pg.close(); });

  async function request(path: string, options: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
    const req = Object.assign(Readable.from(options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))]), {
      method: options.body === undefined ? "GET" : "POST", url: path, socket: { remoteAddress: "203.0.113.5" },
      headers: { host: "localhost", "content-type": "application/json", ...(options.cookie ? { cookie: options.cookie } : {}), ...options.headers },
    });
    const result = { status: 0, headers: {} as Record<string, string>, body: null as any };
    await handler(req, {
      setHeader() {},
      writeHead(status: number, headers: Record<string, string>) { result.status = status; result.headers = headers; },
      end(body: string) { result.body = body ? JSON.parse(body) : null; },
    } as any);
    return result;
  }

  async function account() {
    const id = crypto.randomUUID();
    const user = await database.createUser({ id, displayName: "Exporter", email: `${id}@example.test`, passwordHash: await hashPassword(password), role: "member" });
    const login = await request("/api/auth/login", { body: { email: user.email, password } });
    return { user, cookie: login.headers["Set-Cookie"].split(";")[0] };
  }

  test("holds every flashcard review, word and setting, and only the signed-in account's", async () => {
    const { user, cookie } = await account();
    const other = await account();
    const card = { id: "c1", docId: "d1", docTitle: "Biology", kind: "basic", front: "Q", back: "A", ordinal: 0, createdAt: at(0), updatedAt: at(0) };
    await database.saveFlashcardChanges({ userId: user.id, cards: [card], reviews: [
      { id: "r1", cardId: "c1", rating: 3, reviewedAt: at(1) }, { id: "r2", cardId: "c1", rating: 4, reviewedAt: at(2) },
    ] });
    await database.saveFlashcardChanges({ userId: other.user.id, cards: [{ ...card, front: "Someone else's" }], reviews: [] });
    await database.saveLanguageTerms({ userId: user.id, terms: [
      { language: "es", key: "hola", meaning: "hello", status: 2, tags: [], docIds: [], createdAt: at(0), updatedAt: at(0) },
    ] });
    await database.saveInterfaceSettings({ userId: user.id, changes: { theme: "dark" } });

    const result = await request("/api/auth/account/export", { cookie });
    expect(result.status).toBe(200);
    expect(result.headers["Cache-Control"]).toContain("no-store");
    expect(result.body.account).toMatchObject({ id: user.id, email: user.email });
    expect(result.body.flashcards.cards.map((c: any) => c.front)).toEqual(["Q"]);
    expect(result.body.flashcards.reviews.map((r: any) => r.id).sort()).toEqual(["r1", "r2"]);
    expect(result.body.languageTerms).toEqual([expect.objectContaining({ language: "es", key: "hola", meaning: "hello" })]);
    expect(result.body.interfaceSettings).toEqual({ theme: "dark" });
    expect(result.body.missing).toBeUndefined();
  });

  test("needs a signed-in browser session from Margin Chat itself", async () => {
    expect((await request("/api/auth/account/export")).status).toBe(401);
    const { cookie } = await account();
    expect((await request("/api/auth/account/export", { cookie, headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
  });

  test("reads every page, and reports a part it couldn't read instead of failing", async () => {
    const terms = Array.from({ length: 4500 }, (_, index) => ({ language: "fr", key: `w${index}` }));
    const fake = {
      async readLanguageTerms({ since, limit }: { since: number; limit: number }) {
        const page = terms.slice(since, since + limit);
        return { terms: page, cursor: since + page.length, more: page.length === limit };
      },
      async readFlashcardChanges() { throw new Error("down"); },
    };
    const exported = await buildAccountExport({ database: fake, user: { id: "u1", displayName: "U", email: "u@example.test" } });
    expect(exported.languageTerms).toHaveLength(4500);
    expect(exported.flashcards).toBeNull();
    expect(exported.missing).toEqual(["flashcards"]);
  });

  test("Download vault puts it beside the files, and importing the download leaves it out", () => {
    const zip = exportVault({ files: { "Note.md": { content: "# Note" } } } as any, { schemaVersion: 1, languageTerms: [] });
    const archive = unzipSync(zip);
    expect(JSON.parse(strFromU8(archive[ACCOUNT_EXPORT_FILE]))).toEqual({ schemaVersion: 1, languageTerms: [] });
    expect(Object.keys(importVault(zip))).toEqual(["Note.md"]);
    expect(Object.keys(unzipSync(exportVault({ files: { "Note.md": { content: "x" } } } as any)))).not.toContain(ACCOUNT_EXPORT_FILE);
  });
});
