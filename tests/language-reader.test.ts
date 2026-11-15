import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { loadMigrations, migrateDatabase } from "../server/db/migrations.mjs";
import * as languageTermRepository from "../server/db/languageTermRepository.mjs";
import { createLanguageTermService } from "../server/languageTerms/index.mjs";
import { SPEECH_DAILY_CHARACTERS, createLanguageSpeechService, speechSsml, speechText, speechVoice } from "../server/languageTerms/speech.mjs";
import { findPhrases, normalizeReaderLook, paginate, readerParagraphs, termKey, tokenize } from "../client/src/lib/languageReader";
import { LanguageTermStore, syncLanguageTerms } from "../client/src/lib/languageTerms";
import { wantsNeuralVoice } from "../client/src/lib/languageSpeech";

const memory = () => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } }; };

describe("a document as words to tap", () => {
  test("splits text into words with what lies between them, keeping how each was written", () => {
    const tokens = tokenize("„Wie geht es dir?“, fragt er.", "de");
    expect(tokens.map((token) => token.text).join("")).toBe("„Wie geht es dir?“, fragt er.");
    expect(tokens.filter((token) => token.key !== undefined).map((token) => token.key)).toEqual(["wie", "geht", "es", "dir", "fragt", "er"]);
    expect(tokens.filter((token) => token.key !== undefined).map((token) => token.word)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("a word joined by an apostrophe or hyphen is one word", () => {
    expect(tokenize("Y a-t-il de l'eau, grand-mère ?", "fr").filter((token) => token.key !== undefined).map((token) => token.text)).toEqual(["Y", "a-t-il", "de", "l'eau", "grand-mère"]);
    expect(termKey("  Grand-Mère! ")).toBe("grand-mère");
    expect(termKey("Gute  Nacht.")).toBe("gute nacht");
  });

  test("reads paragraphs, headings and list items, and leaves out code, tables and pictures", () => {
    const paragraphs = readerParagraphs([
      { id: "a", content: "# Guten Abend\n\nIch heiße **Lena**. Es ist [sieben](https://example.com) Uhr.\n\n```js\nconst x = 1;\n```\n\n| a | b |\n| --- | --- |\n\n![[bild.png]]" },
      { id: "b", content: "- Gute Nacht!\n- Bis morgen." },
    ], "de");
    expect(paragraphs.map((paragraph) => [paragraph.blockId, paragraph.heading, paragraph.sentences.map((sentence) => sentence.text)])).toEqual([
      ["a", 1, ["Guten Abend"]], ["a", 0, ["Ich heiße Lena.", "Es ist sieben Uhr."]], ["b", 0, ["Gute Nacht!"]], ["b", 0, ["Bis morgen."]],
    ]);
    expect(paragraphs.flatMap((paragraph) => paragraph.sentences.map((sentence) => sentence.index))).toEqual([0, 1, 2, 3, 4]);
  });

  test("a saved phrase covers its words, and the longest phrase wins where they overlap", () => {
    const keys = ["wie", "geht", "es", "dir", "ich", "habe", "hunger"];
    const saved = new Set(["geht es", "wie geht es dir", "ich habe"]);
    expect(findPhrases(keys, (key) => saved.has(key))).toEqual([{ from: 0, length: 4, key: "wie geht es dir" }, { from: 4, length: 2, key: "ich habe" }]);
  });

  test("long documents come in pages that end between paragraphs", () => {
    const paragraph = (id: number) => ({ id: `b${id}`, content: Array.from({ length: 60 }, (_, word) => `wort${word}`).join(" ") + "." });
    const pages = paginate(readerParagraphs(Array.from({ length: 12 }, (_, id) => paragraph(id))), 300);
    expect(pages.length).toBe(3);
    expect(pages.map((page) => page.length)).toEqual([5, 5, 2]);
    expect(paginate([]).length).toBe(1);
  });

  test("the look falls back to the defaults for anything unreadable", () => {
    expect(normalizeReaderLook({ theme: "navy", size: 8, font: 2 })).toEqual({ theme: "navy", size: 8, font: 2 });
    expect(normalizeReaderLook({ theme: "pink", size: 40, font: -1 })).toEqual({ theme: "system", size: 4, font: 0 });
  });
});

describe("the words a person is learning", () => {
  test("a rating or a meaning is kept at once, and a meaning for an unrated word means it's being learned", () => {
    const storage = memory();
    const store = new LanguageTermStore("u1", storage);
    store.set("de", "Geht", { status: 2, docId: "d1" }, "2026-11-14T10:00:00.000Z");
    store.set("de", "geht", { meaning: "goes" }, "2026-11-14T10:00:01.000Z");
    expect(store.get("de", "geht")).toMatchObject({ key: "geht", status: 2, meaning: "goes", docIds: ["d1"], createdAt: "2026-11-14T10:00:00.000Z" });
    store.set("de", "Gute Nacht", { meaning: "good night" }, "2026-11-14T10:00:02.000Z");
    expect(store.get("de", "gute nacht")?.status).toBe(1);
    store.set("de", "abend", { status: 0 }, "2026-11-14T10:00:03.000Z");
    store.set("de", "abend", { meaning: "evening" }, "2026-11-14T10:00:04.000Z");
    expect(store.get("de", "abend")?.status).toBe(1);
    // It survives a reload, with what the account hasn't got yet still waiting.
    const again = new LanguageTermStore("u1", storage);
    expect(again.get("de", "geht")?.meaning).toBe("goes");
    expect(again.pendingTerms(10).map((term) => term.key).sort()).toEqual(["abend", "geht", "gute nacht"]);
    expect(new LanguageTermStore("u2", storage).getSnapshot().size).toBe(0);
  });

  test("the newer copy of a term wins between devices, and a change made while syncing isn't lost", () => {
    const store = new LanguageTermStore("u1", memory());
    const mine = store.set("de", "geht", { status: 1 }, "2026-11-14T10:00:00.000Z")!;
    store.applyRemote([{ ...mine, status: 3, updatedAt: "2026-11-14T09:00:00.000Z" }], 4);
    expect(store.get("de", "geht")?.status).toBe(1);
    store.applyRemote([{ ...mine, status: 4, updatedAt: "2026-11-14T11:00:00.000Z" }], 5);
    expect(store.get("de", "geht")?.status).toBe(4);
    expect(store.pendingTerms(10)).toEqual([]);
    // Rated again on a device whose clock is behind: still newer than the copy it replaces.
    expect(store.set("de", "geht", { status: 5 }, "2026-11-14T10:30:00.000Z")!.updatedAt > "2026-11-14T11:00:00.000Z").toBe(true);
    const sent = store.pendingTerms(10);
    store.set("de", "geht", { status: 2 }, "2026-11-14T12:00:00.000Z");
    store.markSent(sent);
    expect(store.pendingTerms(10).map((term) => term.status)).toEqual([2]);
  });
});

const databases: PGlite[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map((database) => database.close())); });

describe("language terms in the account", () => {
  test("two devices merge by newest, a retry adds nothing, and accounts are separate", async () => {
    const pg = new PGlite({ extensions: { vector } });
    databases.push(pg);
    const client = { async query(sql: string, values?: unknown[]) {
      const result = values === undefined && sql.includes(";") ? (await pg.exec(sql)).at(-1)! : await pg.query(sql, values);
      return { ...result, rowCount: result.rows.length || (result as { affectedRows?: number }).affectedRows || 0 };
    } };
    await migrateDatabase(client, { migrations: await loadMigrations() });
    await pg.query("insert into marginchat_users (id,email,password_hash,display_name) values ('u1','u1@example.test','hash','U1'), ('u2','u2@example.test','hash','U2')");
    const service = createLanguageTermService({ database: {
      saveLanguageTerms: (args: any) => languageTermRepository.saveLanguageTerms(client, args),
      readLanguageTerms: (args: any) => languageTermRepository.readLanguageTerms(client, args),
    } });
    const fetcher = (userId: string) => (async (_url: unknown, init?: RequestInit) =>
      new Response(JSON.stringify(await service.sync({ userId, body: JSON.parse(String(init?.body)) })), { status: 200 })) as typeof fetch;

    const phone = new LanguageTermStore("phone", memory());
    const laptop = new LanguageTermStore("laptop", memory());
    phone.set("de", "geht", { status: 2, meaning: "goes", tags: ["verb"], docId: "d1" }, "2026-11-14T10:00:00.000Z");
    phone.set("de", "gute nacht", { status: 1 }, "2026-11-14T10:00:01.000Z");
    expect(await syncLanguageTerms(phone, "u1", fetcher("u1"))).toBe("synced");
    expect(phone.pendingTerms(10)).toEqual([]);
    expect(await syncLanguageTerms(laptop, "u1", fetcher("u1"))).toBe("synced");
    expect(laptop.get("de", "geht")).toMatchObject({ status: 2, meaning: "goes", tags: ["verb"], docIds: ["d1"] });

    laptop.set("de", "geht", { status: 5 }, "2026-11-14T11:00:00.000Z");
    await syncLanguageTerms(laptop, "u1", fetcher("u1"));
    await syncLanguageTerms(phone, "u1", fetcher("u1"));
    expect(phone.get("de", "geht")?.status).toBe(5);
    expect((await pg.query("select count(*)::int as n from marginchat_language_terms where user_id = 'u1'")).rows[0]).toEqual({ n: 2 });

    const other = new LanguageTermStore("other", memory());
    await syncLanguageTerms(other, "u2", fetcher("u2"));
    expect(other.getSnapshot().size).toBe(0);
    await expect(service.sync({ userId: "u1", body: { terms: [{ language: "de", key: "x", meaning: "", status: 9, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }] } })).rejects.toThrow("not readable");
  });
});

describe("reading aloud", () => {
  test("picks a voice for the language, cleans the text and can slow down", () => {
    expect(speechVoice("de")).toBe("de-DE-KatjaNeural");
    expect(speechVoice("pt-BR")).toBe("pt-BR-FranciscaNeural");
    expect(speechVoice("pt-PT")).toBe("pt-PT-RaquelNeural");
    expect(speechVoice("xx")).toBeNull();
    expect(speechText("**Y a-t-il**  de l'eau ?  # ok")).toBe("Y a-t-il de l'eau? ok");
    const ssml = speechSsml({ text: "Tom & <Jerry>", voice: "de-DE-KatjaNeural", slow: true });
    expect(ssml).toContain('xml:lang="de-DE"');
    expect(ssml).toContain('<prosody rate="-30%">Tom &amp; &lt;Jerry&gt;</prosody>');
  });

  test("asks the voice service once it's set up, and says so plainly when it isn't", async () => {
    await expect(createLanguageSpeechService({ env: {} }).speak({ userId: "u1", text: "Guten Abend, Lena.", language: "de" })).rejects.toMatchObject({ statusCode: 503 });
    const calls: Array<{ url: string; body: string; key: string }> = [];
    const speech = createLanguageSpeechService({
      env: { AZURE_SPEECH_KEY: "k", AZURE_SPEECH_REGION: "eastus" },
      fetchImpl: (async (url: string, init: any) => { calls.push({ url, body: init.body, key: init.headers["Ocp-Apim-Subscription-Key"] }); return new Response(new Uint8Array([1, 2, 3]), { status: 200 }); }) as any,
    });
    const { audio, voice } = await speech.speak({ userId: "u1", text: "Guten Abend, Lena.", language: "de" });
    expect([...audio]).toEqual([1, 2, 3]);
    expect(voice).toBe("de-DE-KatjaNeural");
    expect(calls[0]).toMatchObject({ url: "https://eastus.tts.speech.microsoft.com/cognitiveservices/v1", key: "k" });
    expect(calls[0].body).toContain("Guten Abend, Lena.");
    await expect(speech.speak({ userId: "u1", text: "Hallo", language: "xx" })).rejects.toMatchObject({ statusCode: 404 });
    await expect(speech.speak({ userId: "u1", text: "a".repeat(1300), language: "de" })).rejects.toMatchObject({ statusCode: 413 });
    // A day's allowance per account.
    const long = "wort ".repeat(239).trim();
    for (let spent = 18; spent + long.length <= SPEECH_DAILY_CHARACTERS; spent += long.length) await speech.speak({ userId: "u1", text: long, language: "de" });
    await expect(speech.speak({ userId: "u1", text: long, language: "de" })).rejects.toMatchObject({ statusCode: 429 });
    expect((await speech.speak({ userId: "u2", text: "Guten Abend, Lena.", language: "de" })).voice).toBe("de-DE-KatjaNeural");
    const refused = createLanguageSpeechService({ env: { AZURE_SPEECH_KEY: "bad", AZURE_SPEECH_REGION: "eastus" }, fetchImpl: (async () => new Response("", { status: 401 })) as any });
    await expect(refused.speak({ userId: "u1", text: "Guten Abend, Lena.", language: "de" })).rejects.toThrow("AZURE_SPEECH_KEY");
  });

  test("single words stay with the device's voice", () => {
    expect(wantsNeuralVoice("geht")).toBe(false);
    expect(wantsNeuralVoice("Wie geht es dir?")).toBe(true);
  });
});
